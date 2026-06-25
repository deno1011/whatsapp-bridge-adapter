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
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const { Bridge } = require("./lib/bridge");

const BRIDGE_DIR =
  process.env.MESSENGER_BRIDGE_DIR ||
  path.join(os.homedir(), ".emacs.d", "messenger-bridge");
const AUTH_DIR = process.env.WA_AUTH_DIR || path.join(__dirname, "auth");
const ALLOWED = (process.env.WA_ALLOWED_JIDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const POLL_MS = parseInt(process.env.WA_POLL_MS || "500", 10);

const bridge = new Bridge(BRIDGE_DIR);

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
      console.log("[wa] connected.");
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

  // Inbound: WhatsApp -> bridge inbox
  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      if (!m.message || (m.key && m.key.fromMe)) continue;
      const jid = m.key && m.key.remoteJid;
      if (!jid) continue;
      const text = extractText(m.message);
      if (!text) continue; // text-only for now
      if (ALLOWED.length === 0 || !ALLOWED.includes(jid)) {
        console.log(`[wa] ignored from ${jid} (not whitelisted): ${text.slice(0, 40)}`);
        continue;
      }
      const id = bridge.writeInbound({
        channel: "whatsapp",
        chat: jid,
        text,
        meta: { pushName: m.pushName || null, waMessageId: m.key.id },
      });
      console.log(`[wa] <- ${jid}: ${text.slice(0, 60)} (inbox ${id})`);
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
