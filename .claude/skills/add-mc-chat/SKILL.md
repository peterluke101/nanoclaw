---
name: add-mc-chat
description: Add Mission Control as a chat channel. Runs a small loopback HTTP server inside NanoClaw (exposed via Tailscale Funnel) so Peter can chat with Ares from the MC dashboard, with paperclip attachments and SSE streaming for long agent runs.
---

# Add MC Chat Channel

This skill wires Mission Control (the `peterluke101/mission-control` Next.js dashboard) into NanoClaw as a first-class chat channel.

## Why a separate channel?

The dashboard runs in the browser on Cloudflare Pages. Pages Functions have a 30s wall-time cap on a single request, but agent runs are 10–90s. So this channel speaks SSE end-to-end — the Pages Function streams `text/event-stream` from NanoClaw to the browser, the browser holds the EventSource open, and the agent's final reply arrives as a `done` event whenever it's ready.

Architecture:
```
Browser (chat-dock.tsx)
  └─POST /api/chat (SSE)──> Cloudflare Pages Function
                              └─bearer auth──> Tailscale Funnel
                                                 └──> NanoClaw mc-chat channel (:54173)
                                                        └──> orchestrator → agent → sendMessage()
```

## Phase 1: Pre-flight

### Check if already applied

If `src/channels/mc-chat.ts` exists, the code is already in place — skip to Phase 3.

### Decide on a secret

You need a shared secret used by NanoClaw, the Pages Functions, and (optionally) a CLI smoke test. Generate one:

```bash
openssl rand -hex 32
```

Save it — you'll paste it into both NanoClaw's `.env` and Cloudflare Pages env vars below.

## Phase 2: Apply Code Changes

The files in this skill ship the channel directly into the repo:

- `src/channels/mc-chat.ts` — channel implementation
- `src/channels/mc-chat.test.ts` — unit tests
- `src/channels/index.ts` — adds `import './mc-chat.js'`

After applying:

```bash
npm run build
npm test -- mc-chat
```

## Phase 3: Setup

### 1. Add env vars

In `.env`:
```
MC_CHAT_SECRET=<the secret from openssl>
MC_CHAT_PORT=54173   # optional, defaults to 54173
```

If you use OneCLI / data/env sync, sync the secret over.

### 2. Register the MC JID in NanoClaw

The channel uses a single fixed JID — `mc-chat:dashboard` — mapped to the `main` group so it inherits main's elevated privileges.

```bash
sqlite3 store/messages.db "INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger, requires_trigger, is_main, added_at) VALUES ('mc-chat:dashboard', 'Mission Control', 'main', '@Ares', 0, 1, datetime('now'));"
```

> If your main group folder is named differently, substitute it. Check with:
> `sqlite3 store/messages.db "SELECT folder FROM registered_groups WHERE is_main = 1;"`

### 3. Start NanoClaw

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux
systemctl --user restart nanoclaw
```

You should see in the logs:
```
mc-chat HTTP server listening (loopback only — expose via Tailscale Funnel)
  mc-chat: http://127.0.0.1:54173
```

### 4. Expose via Tailscale Funnel

The channel binds to `127.0.0.1` only, so it isn't reachable from the public internet without an explicit funnel. Funnel terminates TLS and forwards traffic from the Tailscale-issued hostname:

```bash
tailscale funnel --bg 54173
```

Note the resulting URL — looks like `https://<hostname>.<tailnet>.ts.net:54173/`. That goes into Cloudflare Pages as `MC_TUNNEL_URL`.

To confirm funnel state:
```bash
tailscale funnel status
```

### 5. Smoke-test the bridge

From any machine, with the same secret:

```bash
TUNNEL="https://<hostname>.<tailnet>.ts.net:54173"
SECRET="<your secret>"

# Health
curl -s -H "Authorization: Bearer $SECRET" "$TUNNEL/health"
# → {"ok":true,"ts":"...","channel":"mc-chat","queued":0}

# Chat (will hang until the agent finishes — that's the SSE stream working)
curl -N -H "Authorization: Bearer $SECRET" -H "Content-Type: application/json" \
  -d '{"conversationId":"smoke","message":"say hello"}' "$TUNNEL/chat"
# → event: ready ... event: status (every 5s) ... event: done {"text":"..."}
```

### 6. Configure Cloudflare Pages

In the `mission-control` Pages project, add these env vars (Production + Preview):

- `MC_TUNNEL_URL` = `https://<hostname>.<tailnet>.ts.net:54173`
- `MC_CHAT_SECRET` = (the same secret)

Then redeploy.

## API reference

### `POST /chat`
Headers: `Authorization: Bearer $MC_CHAT_SECRET`, `Content-Type: application/json`
Body:
```json
{
  "conversationId": "uuid-from-localStorage",
  "message": "user text",
  "attachments": [
    { "url": "/workspace/group/attachments/abc_pic.png", "filename": "pic.png" }
  ]
}
```
Response: `text/event-stream`:
- `event: ready` — accepted + queued
- `event: status` — heartbeat every 5s while the agent runs
- `event: done` — `{ text, ts }` final agent response
- `event: error` — `{ message }` fatal error or timeout

### `POST /upload`
Headers: same bearer.
Body:
```json
{
  "filename": "pic.png",
  "mime": "image/png",
  "dataBase64": "..."
}
```
Response: `{ url, filename }` — the `url` is the in-container path the agent will see.

Why JSON-base64 and not multipart? The Cloudflare Pages Function does the multipart parsing in the browser-facing direction (where the Web platform makes it easy) and re-emits JSON to NanoClaw. Keeps the NanoClaw side dependency-free.

### `GET /health`
Headers: same bearer.
Response: `{ ok, ts, channel, queued }`. `queued` is the number of in-flight SSE responses waiting on the agent.

## Security notes

- Server binds to `127.0.0.1` only. Tailscale Funnel is the *only* path from the public internet.
- Bearer auth on every endpoint with constant-time comparison.
- Filenames sanitized to alphanumerics + dot/underscore/hyphen; basename only.
- Upload cap: 25 MB.
- Pending SSE responses time out after 5 minutes (covers slow agent runs without leaking sockets).
- A stronger secret (≥32 hex chars) is recommended; the channel logs a warning below 16 chars.

## Troubleshooting

### `mc-chat: MC_CHAT_SECRET not set — channel disabled`
Add `MC_CHAT_SECRET` to `.env` and restart NanoClaw.

### `/chat` returns 503 with "JID not registered"
Run the SQLite INSERT from Phase 3, step 2.

### Heartbeats arrive but `done` never does
The agent's `sendMessage()` isn't being called — check the orchestrator log for routing errors. Likely either the JID prefix mismatch (should be exactly `mc-chat:dashboard`) or the scheduler hit an error before reaching the send step.

### CF Pages Function times out at 30s
Confirm `functions/api/chat.ts` is forwarding the upstream body directly (not awaiting `.text()`). The SSE stream must pass through unbuffered.

## Removal

1. `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid = 'mc-chat:dashboard';"`
2. Delete `src/channels/mc-chat.ts` and `src/channels/mc-chat.test.ts`
3. Remove `import './mc-chat.js'` from `src/channels/index.ts`
4. Remove `MC_CHAT_SECRET` / `MC_CHAT_PORT` from `.env`
5. `tailscale funnel --bg 54173 off`
6. `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS)
