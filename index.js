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

const bridge = new Bridge(BRIDGE_DIR);
let selfJid = null; // phone-number JID, set on connection.open
let selfLid = null; // LID-form JID (newer WhatsApp addressing), if any

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
    syncFullHistory: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log("\nScan this in WhatsApp ▸ Linked Devices:\n");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
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
    } else if (connection === "close") {
      const code =
        lastDisconnect &&
        lastDisconnect.error &&
        lastDisconnect.error.output &&
        lastDisconnect.error.output.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      console.log(
        `[wa] connection closed (code ${code}) ` +
          (loggedOut
            ? "— logged out. Delete WA_AUTH_DIR and re-scan."
            : "— reconnecting…")
      );
      if (!loggedOut) start().catch((e) => console.error("[wa] restart:", e));
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
      const jid = m.key.remoteJid;
      if (!jid) continue;
      const fromMe = !!m.key.fromMe;
      const text = extractText(m.message);
      if (!text) continue; // text-only for now
      if (!ALLOWED.includes(jid)) {
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
        meta: { pushName: m.pushName || null, waMessageId: m.key.id, fromMe },
      });
      console.log(
        `[wa] <- ${jid}${fromMe ? " (self)" : ""}: ${text.slice(0, 60)} (inbox ${id})`
      );
    }
  });

  // Outbound: bridge outbox -> WhatsApp
  bridge.watchOutbox(async (msg) => {
    if (!msg.chat || !msg.text) return;
    await sock.sendMessage(String(msg.chat), { text: String(msg.text) });
    console.log(`[wa] -> ${msg.chat}: ${String(msg.text).slice(0, 60)}`);
  }, POLL_MS);

  console.log(`[wa] bridge dir: ${BRIDGE_DIR}`);
  console.log(`[wa] auth dir:   ${AUTH_DIR}`);
}

start().catch((e) => {
  console.error("[wa] fatal:", e);
  process.exit(1);
});
