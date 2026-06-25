# whatsapp-bridge-adapter

A **WhatsApp adapter** for
[emacs-messenger-bridge](https://github.com/deno1011/emacs-messenger-bridge),
built on [Baileys](https://github.com/WhiskeySockets/Baileys). It links a
WhatsApp number (like WhatsApp Web) and relays messages to/from the bridge's
file protocol, so Emacs — and a future chat agent (EAR) — can talk WhatsApp
without speaking the protocol itself.

```
 WhatsApp ──▶ Baileys ──▶ <bridge>/inbox/  ──▶ Emacs / EAR
 WhatsApp ◀── Baileys ◀── <bridge>/outbox/ ◀── Emacs / EAR
```

## ⚠️ Read first — this is unofficial

This uses the **unofficial** WhatsApp Web protocol via Baileys. It is **against
WhatsApp's Terms of Service** and the linked number **can get banned**. Use a
**secondary number** you can afford to lose, not your main one. There is no
official WhatsApp API for personal accounts; this is the trade-off for
free-form, proactive messaging (an official Cloud-API alternative exists but
restricts proactive messages to approved templates outside a 24h window).

## Requirements

- Node.js ≥ 18
- A running `emacs-messenger-bridge` on the same machine (same bridge dir)
- A phone with WhatsApp to scan the QR once

## Setup

```bash
npm install
cp .env.example .env          # then edit .env
```

Edit `.env`:
- `MESSENGER_BRIDGE_DIR` — **must equal** `messenger-bridge-directory` in your
  Emacs config (default `~/.emacs.d/messenger-bridge`).
- `WA_AUTH_DIR` — where the WhatsApp session is stored (default `./auth`).
- `WA_ALLOWED_JIDS` — **safety whitelist** (see below). Leave empty for the
  first run.

## First run + the safety whitelist

```bash
npm start          # or: node --env-file=.env index.js
```

1. A QR code prints. Open WhatsApp ▸ **Linked Devices** ▸ *Link a device* and
   scan it. On success: `[wa] connected.`
2. With `WA_ALLOWED_JIDS` empty, **nothing inbound is relayed** — by design.
   Message the linked number from your phone; the adapter prints the sender's
   JID:
   ```
   [wa] ignored from 491701234567@s.whatsapp.net (not whitelisted): hi
   ```
3. Put that JID into `WA_ALLOWED_JIDS` in `.env` and restart. Now only that
   chat is relayed into the bridge — so the agent talks only to **you**, not
   to every WhatsApp contact.

The session persists in `WA_AUTH_DIR`; later runs reconnect without a QR.
Delete `WA_AUTH_DIR` to force a fresh login (e.g. after a logout).

## How it maps to the bridge

| Direction | WhatsApp | Bridge message |
|---|---|---|
| inbound | text/caption from a whitelisted JID | `inbox/*.json` `{channel:"whatsapp", chat:<jid>, text, meta:{pushName, waMessageId}}` |
| outbound | `sock.sendMessage(chat, {text})` | `outbox/*.json` `{chat:<jid>, text}` → moved to `sent/` |

`chat` is the WhatsApp **JID** — the agent replies to the same `chat` it
received, so routing is automatic. Only text messages are relayed for now.

## End-to-end with Emacs

```elisp
;; Emacs side (emacs-messenger-bridge)
(require 'messenger-bridge)
(setq messenger-bridge-directory "~/.emacs.d/messenger-bridge/")
(messenger-bridge-start)
;; send a WhatsApp message from Emacs:
(messenger-send "491701234567@s.whatsapp.net" "Hallo vom Agent" "whatsapp")
```

Incoming WhatsApp messages land in the `*messenger-bridge*` buffer (default
handler) until EAR is wired onto `messenger-on-message-functions`.

## Run as a background service (launchd, macOS)

Do the QR login once in a terminal (`node index.js`) so `./auth` exists. Then
use the template in [`launchd/`](launchd/com.deno1011.whatsapp-bridge.plist):

```bash
# edit the __NODE_BINARY__ / __ADAPTER_DIR__ placeholders first
cp launchd/com.deno1011.whatsapp-bridge.plist ~/Library/LaunchAgents/
launchctl load  ~/Library/LaunchAgents/com.deno1011.whatsapp-bridge.plist
launchctl start com.deno1011.whatsapp-bridge
# logs: /tmp/whatsapp-bridge.{out,err}.log ; stop: launchctl unload <plist>
```

`KeepAlive` restarts it if it crashes; `RunAtLoad` starts it at login. The
`.env` in the working directory is auto-loaded.

## Limitations

- Text only (no media/voice yet).
- One linked number per adapter instance.
- Unofficial → may break when WhatsApp changes the protocol; keep Baileys
  updated.

## License

MIT. See [LICENSE](LICENSE).
