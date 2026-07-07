# Claude Sidebar — Mobile Bridge

Runs the exact PTY session the desktop plugin spawns locally (`terminal_pty.py` → `claude || true; exec $SHELL -i`) on a host machine, exposed over an authenticated WebSocket. Mobile Obsidian attaches as a thin terminal. Your Claude Max subscription is used because the real `claude` CLI runs on the host you logged into (`~/.claude`), not an API key.

## Setup (host = your Mac)

```bash
cd bridge
npm install
```

Run in foreground to test:

```bash
BRIDGE_TOKEN=$(openssl rand -hex 24) node server.js
```

Run 24/7 via launchd: edit `com.claude-sidebar.bridge.plist` (token, paths), then

```bash
cp com.claude-sidebar.bridge.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.claude-sidebar.bridge.plist
tail -f /tmp/claude-sidebar-bridge.log
```

## Config (env vars)

| Var | Default | Notes |
|---|---|---|
| `BRIDGE_TOKEN` | — (required) | shared secret, ≥16 chars |
| `BRIDGE_PORT` | `8898` | |
| `BRIDGE_HOST` | `127.0.0.1` | `0.0.0.0` for LAN/Tailscale access |
| `BRIDGE_CWD` | `$HOME` | default session working dir — point at the vault the phone syncs (iCloud/Obsidian Sync) so edits show up on the phone |
| `BRIDGE_SHELL` | `$SHELL` | |
| `BRIDGE_CLI` | `claude` | |

## Plugin side (mobile Obsidian)

In Claude Sidebar settings on the phone set:

- **Bridge URL**: `ws://<host>:8898` (Tailscale hostname/IP strongly preferred; LAN IP works at home)
- **Bridge token**: same value as `BRIDGE_TOKEN`

The plugin automatically uses the bridge on mobile. On desktop you can force it with the "Always use bridge" toggle (useful for testing).

## Networking

Prefer Tailscale: install on the Mac and phone, log into the same tailnet, then use `ws://<mac-tailscale-name>:8898`. Traffic is WireGuard-encrypted end to end, no ports exposed to the internet. Do **not** port-forward this bridge to the public internet — the token is the only gate, and the session is a full shell on your machine.

## Protocol

- `GET /pty?token=...&cols=80&rows=24[&yolo=1][&continue=1][&cwd=/path]` → WebSocket
- Client→server: raw bytes to the PTY stdin. Resize: `\x1b]RESIZE;cols;rows\x07` (handled by `terminal_pty.py`, same as desktop).
- Server→client: raw PTY output bytes.

## Smoke test

```bash
BRIDGE_TOKEN=... BRIDGE_CLI=true node server.js   # BRIDGE_CLI=true skips claude, drops straight to shell
BRIDGE_TOKEN=... node test-client.js              # in another terminal
```
