"use strict";

// File-bridge I/O for emacs-messenger-bridge.
// Mirrors the protocol of messenger-bridge.el:
//   <root>/inbox     adapter -> Emacs (we write here)
//   <root>/outbox    Emacs   -> adapter (we read here)
//   <root>/sent      outbox files we have delivered
//   <root>/processed (owned by Emacs)
// Atomicity: write ".<name>.tmp" then rename onto "<name>.json".

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function fileTimestamp(d = new Date()) {
  // YYYYMMDDTHHMMSS in UTC, matching the other adapters.
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

function isoTimestamp(d = new Date()) {
  // ISO-8601 UTC without milliseconds: 2026-06-25T15:26:07Z
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

class Bridge {
  constructor(root) {
    this.root = root;
    this.dirs = {};
    for (const d of ["inbox", "outbox", "sent", "processed"]) {
      this.dirs[d] = path.join(root, d);
      fs.mkdirSync(this.dirs[d], { recursive: true });
    }
  }

  // Write an inbound message into inbox/ atomically. Returns the message id.
  writeInbound({ channel, chat, text, meta }) {
    const id = crypto.randomUUID();
    const msg = {
      id,
      channel,
      chat,
      text,
      timestamp: isoTimestamp(),
      meta: meta || {},
    };
    const name = `${fileTimestamp()}-${id}.json`;
    const tmp = path.join(this.dirs.inbox, `.${name}.tmp`);
    const fin = path.join(this.dirs.inbox, name);
    fs.writeFileSync(tmp, JSON.stringify(msg));
    fs.renameSync(tmp, fin);
    return id;
  }

  // Write the normalized contact list for CHANNEL to contacts/<channel>.json
  // atomically. RECORDS is [{ e164, handle, name }] — e164 is the +E.164
  // number (or null when the channel hides it, e.g. WhatsApp @lid), handle is
  // the channel-native address to send to, name is the best known name. The
  // bridge (messenger-bridge.el) merges every channel's file on the e164 key.
  writeContacts(channel, records) {
    const dir = path.join(this.root, "contacts");
    fs.mkdirSync(dir, { recursive: true });
    const fin = path.join(dir, `${channel}.json`);
    const tmp = path.join(dir, `.${channel}.json.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(records || []));
    fs.renameSync(tmp, fin);
    return (records || []).length;
  }

  // Poll outbox/; for each new message call handler(msg) (async). On success
  // move the file to sent/; on failure leave it in outbox/ to retry next tick.
  // channelFilter: when set, only deliver messages whose `channel` matches —
  // other channels' messages are LEFT in outbox/ for their own adapter. This
  // lets several adapters (whatsapp, signal, …) share one bridge.
  watchOutbox(handler, intervalMs = 500, channelFilter = null) {
    let running = false;
    const tick = async () => {
      if (running) return; // never overlap ticks
      running = true;
      try {
        const files = fs
          .readdirSync(this.dirs.outbox)
          .filter((f) => f.endsWith(".json"))
          .sort();
        for (const f of files) {
          const full = path.join(this.dirs.outbox, f);
          let msg;
          try {
            msg = JSON.parse(fs.readFileSync(full, "utf8"));
          } catch (e) {
            continue; // half-written / unparsable: skip this tick
          }
          // Not our channel: leave it for the adapter that owns it.
          if (channelFilter && msg.channel !== channelFilter) continue;
          try {
            await handler(msg);
            fs.renameSync(full, path.join(this.dirs.sent, f));
          } catch (e) {
            console.error(`[bridge] send failed for ${f}:`, e.message);
            // leave in outbox/ for the next tick to retry
          }
        }
      } finally {
        running = false;
      }
    };
    return setInterval(() => {
      tick().catch((e) => console.error("[bridge] tick error:", e));
    }, intervalMs);
  }
}

module.exports = { Bridge, fileTimestamp, isoTimestamp };
