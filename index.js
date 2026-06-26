"use strict";

// WhatsApp (Baileys) adapter for emacs-messenger-bridge.
//
// Relays:
//   WhatsApp incoming text  -> <bridge>/inbox/   (Emacs/EAR picks up)
//   <bridge>/outbox/ message -> WhatsApp send    (EAR's reply goes out)
//
// First run prints a QR code; scan it in WhatsApp ▸ Linked Devices. The
// session is stored in WA_AUTH_DIR so later runs reconnect without a QR.
//
// Config (env, see .env.example):
//   MESSENGER_BRIDGE_DIR  bridge root (MUST match messenger-bridge.el)
//   WA_AUTH_DIR           Baileys session store      (default ./auth)
//   WA_ALLOWED_JIDS       comma-separated JID whitelist of chats to RELAY
//                         inbound from. SAFETY: if empty, nothing inbound is
//                         relayed — incoming JIDs are just printed so you can
//                         discover your own and whitelist it.
//   WA_POLL_MS            outbox poll interval ms     (default 500)

const path = require("path");
const os = require("os");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  jidNormalizedUser,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const { Bridge } = require("./lib/bridge");

// Minimal .env loader (no dependency): load KEY=VALUE from ./.env so plain
// `node index.js` picks up config without needing --env-file. Real env vars
// already set take precedence.
(function loadDotenv() {
  try {
    const fs = require("fs");
    const txt = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      if (process.env[m[1]] !== undefined) continue;
      let v = m[2];
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      process.env[m[1]] = v;
    }
  } catch (e) {
    /* no .env: use defaults / real env */
  }
})();

const BRIDGE_DIR =
  process.env.MESSENGER_BRIDGE_DIR ||
  path.join(os.homedir(), ".emacs.d", "messenger-bridge");
const AUTH_DIR = process.env.WA_AUTH_DIR || path.join(__dirname, "auth");
const ALLOWED = (process.env.WA_ALLOWED_JIDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const POLL_MS = parseInt(process.env.WA_POLL_MS || "500", 10);
const DEBUG = !!process.env.WA_DEBUG;
// Export the WhatsApp contact list (name -> JID) to <bridge>/contacts.json so
// the agent can resolve "send to Max" -> Max's JID. Local file, your own data.
const EXPORT_CONTACTS = (process.env.WA_EXPORT_CONTACTS || "true") !== "false";

const bridge = new Bridge(BRIDGE_DIR);
let selfJid = null; // phone-number JID, set on connection.open
let selfLid = null; // LID-form JID (newer WhatsApp addressing), if any
let reconnectAttempts = 0; // for exponential backoff
let reconnectTimer = null; // ensures only ONE pending reconnect (no overlap)

// --- contacts export -----------------------------------------------------
const contacts = new Map(); // jid -> { name, notify }
const lidToPn = new Map(); // @lid jid -> phone-number jid (learned mapping)
let contactsTimer = null;

// "<number>@s.whatsapp.net" -> "+<number>" (the E.164 join key the bridge
// merges on). Tolerates a device suffix (number:5@…) and the legacy @c.us
// host. Returns null for @lid (privacy form, no number) and groups.
function jidToE164(jid) {
  const m = /^(\d+)(?::\d+)?@(?:s\.whatsapp\.net|c\.us)$/.exec(jid || "");
  return m ? "+" + m[1] : null;
}

function upsertContacts(list) {
  if (!EXPORT_CONTACTS || !Array.isArray(list)) return;
  let changed = false;
  for (const c of list) {
    if (!c || !c.id) continue;
    // Learn the @lid <-> phone-number link when the contact carries both forms.
    if (c.lid && c.id.endsWith("@s.whatsapp.net")) {
      lidToPn.set(jidNormalizedUser(c.lid), jidNormalizedUser(c.id));
    }
    const prev = contacts.get(c.id) || {};
    const next = {
      name: c.name || c.verifiedName || prev.name || null,
      notify: c.notify || prev.notify || null,
    };
    if (prev.name !== next.name || prev.notify !== next.notify) {
      contacts.set(c.id, next);
      changed = true;
    }
  }
  if (changed && !contactsTimer) {
    contactsTimer = setTimeout(() => {
      contactsTimer = null;
      const records = [];
      for (const [jid, v] of contacts) {
        // If this is an @lid entry whose number we learned, export it under the
        // resolved phone number so it merges (also cross-channel) on the e164
        // key instead of staying an unmergeable @lid.
        const pn = jid.endsWith("@lid") ? lidToPn.get(jid) : null;
        const handle = pn || jid;
        records.push({
          e164: jidToE164(handle),
          handle,
          name: v.name || v.notify || null,
        });
      }
      try {
        bridge.writeContacts("whatsapp", records);
        console.log(
          `[wa] contacts: ${records.length} exported -> contacts/whatsapp.json`
        );
      } catch (e) {
        console.error("[wa] contacts write:", e.message);
      }
    }, 1500); // debounce bursts of contact events
  }
}
// -------------------------------------------------------------------------

function extractText(message) {
  if (!message) return null;
  return (
    message.conversation ||
    (message.extendedTextMessage && message.extendedTextMessage.text) ||
    (message.imageMessage && message.imageMessage.caption) ||
    (message.videoMessage && message.videoMessage.caption) ||
    null
  );
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    browser: Browsers.macOS("Desktop"),
    syncFullHistory: true, // pull contact list on connect
  });

  sock.ev.on("creds.update", saveCreds);

  // Contacts → <bridge>/contacts.json (name resolution for the agent).
  sock.ev.on("contacts.upsert", upsertContacts);
  sock.ev.on("contacts.update", upsertContacts);
  sock.ev.on("messaging-history.set", (h) => upsertContacts(h && h.contacts));

  // Ids of messages we sent, to drop their echo on messages.upsert.
  const sentIds = new Set();

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log("\nScan this in WhatsApp ▸ Linked Devices:\n");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      reconnectAttempts = 0; // healthy connection: reset backoff
      selfJid = sock.user && sock.user.id ? jidNormalizedUser(sock.user.id) : null;
      selfLid =
        sock.user && sock.user.lid ? jidNormalizedUser(sock.user.lid) : null;
      console.log(
        "[wa] connected as", selfJid || "(unknown)",
        selfLid ? `(lid ${selfLid})` : ""
      );
      if (ALLOWED.length === 0) {
        console.log(
          "[wa] WARNING: WA_ALLOWED_JIDS is empty — no inbound is relayed.\n" +
            "      Message this number from your phone; the sender JID will be\n" +
            "      printed below. Put it in WA_ALLOWED_JIDS to relay that chat."
        );
      } else {
        console.log("[wa] relaying inbound from:", ALLOWED.join(", "));
      }
      // Force an app-state resync to pull the contact list (it is normally
      // only sent at initial link, not on reconnect).
      if (typeof sock.resyncAppState === "function") {
        sock
          .resyncAppState(
            ["critical_block", "critical_unblock_low", "regular_high", "regular_low", "regular"],
            false
          )
          .then(() => console.log("[wa] app-state resynced (contacts requested)"))
          .catch((e) => console.error("[wa] resyncAppState:", e.message));
      }
    } else if (connection === "close") {
      const code =
        lastDisconnect &&
        lastDisconnect.error &&
        lastDisconnect.error.output &&
        lastDisconnect.error.output.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      if (loggedOut) {
        console.log("[wa] connection closed — logged out. Delete WA_AUTH_DIR and re-scan.");
        return;
      }
      if (reconnectTimer) return; // a reconnect is already pending — no overlap
      const delay = Math.min(2000 * Math.pow(2, reconnectAttempts), 60000);
      reconnectAttempts += 1;
      console.log(
        `[wa] connection closed (code ${code}) — reconnecting in ${Math.round(
          delay / 1000
        )}s (attempt ${reconnectAttempts})`
      );
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        start().catch((e) => console.error("[wa] restart:", e));
      }, delay);
    }
  });

  // Inbound: WhatsApp -> bridge inbox. Relay is WHITELIST-driven: a message is
  // relayed iff its chat JID is in WA_ALLOWED_JIDS. That covers incoming
  // messages AND your own "Note to Self" chat (fromMe). Every text message's
  // JID is logged so you can discover which to whitelist (incl. the newer
  // "@lid" addressing). WA_DEBUG=1 additionally logs raw upserts.
  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (DEBUG) {
      for (const dm of messages) {
        console.log(
          `[wa][debug] upsert type=${type} fromMe=${dm.key && dm.key.fromMe} ` +
            `jid=${dm.key && dm.key.remoteJid} ` +
            `msg=${dm.message ? Object.keys(dm.message).join("/") : "none"}`
        );
      }
    }
    if (type !== "notify" && type !== "append") return;
    for (const m of messages) {
      if (!m.message || !m.key) continue;
      // Skip the echo of a message we just sent (prevents a self-chat loop).
      if (m.key.id && sentIds.has(m.key.id)) {
        sentIds.delete(m.key.id);
        continue;
      }
      const rawJid = m.key.remoteJid;
      if (!rawJid) continue;
      // Personal 1:1 only — ignore groups, broadcast lists and status.
      if (rawJid.endsWith("@g.us") || rawJid.endsWith("@broadcast")) continue;
      // WhatsApp privacy: a chat can arrive under an @lid that hides the phone
      // number. The decoded key carries the real phone-number JID in senderPn,
      // so normalize to it — everything downstream (whitelist, contacts, name
      // resolution, the agent) then sees a stable, resolvable identity and
      // never the @lid. Falls back to the raw jid if no senderPn was sent.
      const isLid = rawJid.endsWith("@lid");
      const jid =
        isLid && m.key.senderPn ? jidNormalizedUser(m.key.senderPn) : rawJid;
      if (isLid && m.key.senderPn) lidToPn.set(rawJid, jid); // learn the link
      const fromMe = !!m.key.fromMe;
      // Learn a contact name from conversations (WhatsApp won't push the full
      // address book to a linked device; this captures people you talk to).
      if (!fromMe && m.pushName) upsertContacts([{ id: jid, notify: m.pushName }]);
      const text = extractText(m.message);
      if (!text) continue; // text-only for now
      // Accept the normalized PN jid OR the raw @lid in the whitelist, so old
      // @lid entries keep working while new ones can use the plain number.
      if (!ALLOWED.includes(jid) && !ALLOWED.includes(rawJid)) {
        console.log(
          `[wa] (not whitelisted) ${jid}${fromMe ? " self" : ""}: ` +
            `${text.slice(0, 40)} — add this JID to WA_ALLOWED_JIDS to relay`
        );
        continue;
      }
      const id = bridge.writeInbound({
        channel: "whatsapp",
        chat: jid,
        text,
        meta: {
          pushName: m.pushName || null,
          waMessageId: m.key.id,
          fromMe,
          lid: isLid ? rawJid : null,
        },
      });
      console.log(
        `[wa] <- ${jid}${isLid ? ` (was ${rawJid})` : ""}` +
          `${fromMe ? " (self)" : ""}: ${text.slice(0, 60)} (inbox ${id})`
      );
    }
  });

  // Outbound: bridge outbox -> WhatsApp. Remember the sent message id so the
  // echo of it (WhatsApp delivers our own message back via messages.upsert,
  // e.g. in the self-chat) is not relayed back inbound — which would loop.
  bridge.watchOutbox(
    async (msg) => {
      if (!msg.chat || !msg.text) return;
      const r = await sock.sendMessage(String(msg.chat), { text: String(msg.text) });
      if (r && r.key && r.key.id) sentIds.add(r.key.id);
      console.log(`[wa] -> ${msg.chat}: ${String(msg.text).slice(0, 60)}`);
    },
    POLL_MS,
    "whatsapp" // only deliver whatsapp messages; leave others for their adapter
  );

  console.log(`[wa] bridge dir: ${BRIDGE_DIR}`);
  console.log(`[wa] auth dir:   ${AUTH_DIR}`);
}

start().catch((e) => {
  console.error("[wa] fatal:", e);
  process.exit(1);
});
