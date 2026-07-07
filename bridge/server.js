#!/usr/bin/env node
"use strict";
/*
 * Claude Sidebar mobile bridge.
 *
 * Exposes the same PTY session the desktop plugin spawns locally
 * (python3 terminal_pty.py <cols> <rows> $SHELL -lc "claude || true; exec $SHELL -i")
 * over an authenticated WebSocket, so mobile Obsidian can attach as a thin
 * terminal. The RESIZE escape protocol (\x1b]RESIZE;cols;rows\x07) passes
 * straight through stdin and is handled by terminal_pty.py, exactly as on
 * desktop.
 *
 * Config via environment variables:
 *   BRIDGE_TOKEN  (required) shared secret; clients pass ?token=...
 *   BRIDGE_PORT   default 8898
 *   BRIDGE_HOST   default 127.0.0.1 — set to 0.0.0.0 only if you understand
 *                 the exposure; prefer binding to your Tailscale IP.
 *   BRIDGE_CWD    default working directory for sessions (default: $HOME)
 *   BRIDGE_SHELL  default: $SHELL or /bin/zsh
 *   BRIDGE_CLI    default: claude
 */

const http = require("http");
const crypto = require("crypto");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn, execSync } = require("child_process");
const { WebSocketServer } = require("ws");

const CONFIG = {
  port: parseInt(process.env.BRIDGE_PORT || "8898", 10),
  host: process.env.BRIDGE_HOST || "127.0.0.1",
  token: process.env.BRIDGE_TOKEN || "",
  defaultCwd: process.env.BRIDGE_CWD || os.homedir(),
  shell: process.env.BRIDGE_SHELL || process.env.SHELL || "/bin/zsh",
  cli: process.env.BRIDGE_CLI || "claude",
};

if (!CONFIG.token || CONFIG.token.length < 16) {
  console.error("BRIDGE_TOKEN (>=16 chars) is required. Generate one: openssl rand -hex 24");
  process.exit(1);
}

const PTY_SCRIPT = path.join(__dirname, "..", "terminal_pty.py");
if (!fs.existsSync(PTY_SCRIPT)) {
  console.error(`terminal_pty.py not found at ${PTY_SCRIPT}`);
  process.exit(1);
}

// launchd starts us with a bare PATH; recover the login-shell PATH once.
let shellPath = process.env.PATH || "";
try {
  const out = execSync(`${CONFIG.shell} -lic 'echo "__PATH__"; echo "$PATH"'`, {
    encoding: "utf8",
    timeout: 8000,
  });
  const p = out.split("__PATH__\n")[1]?.trim().split("\n")[0];
  if (p) shellPath = p;
} catch (e) {
  console.warn("[bridge] login-shell PATH detection failed; using inherited PATH");
}

function tokenOk(candidate) {
  const a = Buffer.from(String(candidate || ""));
  const b = Buffer.from(CONFIG.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("claude-sidebar-bridge ok\n");
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch (e) {
    socket.destroy();
    return;
  }
  if (url.pathname !== "/pty" || !tokenOk(url.searchParams.get("token"))) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const cols = Math.max(2, parseInt(url.searchParams.get("cols") || "80", 10) || 80);
  const rows = Math.max(2, parseInt(url.searchParams.get("rows") || "24", 10) || 24);
  const yolo = url.searchParams.get("yolo") === "1";
  const cont = url.searchParams.get("continue") === "1";
  const cwdParam = url.searchParams.get("cwd");
  let cwd = cwdParam || CONFIG.defaultCwd;
  if (!fs.existsSync(cwd)) {
    console.warn(`[bridge] cwd ${cwd} does not exist; falling back to ${os.homedir()}`);
    cwd = os.homedir();
  }

  // Mirror the desktop plugin's shell command exactly.
  let cli = CONFIG.cli;
  if (yolo) cli += " --dangerously-skip-permissions";
  const shellCmd = cont
    ? `${cli} --continue || ${cli} || true; exec $SHELL -i`
    : `${cli} || true; exec $SHELL -i`;

  const child = spawn(
    "python3",
    [PTY_SCRIPT, String(cols), String(rows), CONFIG.shell, "-lc", shellCmd],
    {
      cwd,
      env: {
        ...process.env,
        PATH: shellPath,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        LANG: process.env.LANG || "en_US.UTF-8",
      },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true, // own process group so we can kill the whole tree
    }
  );

  const tag = `[bridge] session pid=${child.pid}`;
  console.log(`${tag} started cwd=${cwd} yolo=${yolo} continue=${cont} size=${cols}x${rows}`);

  child.stdout.on("data", (d) => {
    if (ws.readyState === ws.OPEN) ws.send(d);
  });
  child.stderr.on("data", (d) => {
    if (ws.readyState === ws.OPEN) ws.send(d);
  });
  child.on("exit", (code, signal) => {
    console.log(`${tag} exited (${code ?? signal})`);
    try {
      ws.close(1000, `exit ${code ?? signal}`);
    } catch (e) {}
  });
  child.on("error", (err) => {
    console.error(`${tag} spawn error: ${err.message}`);
    try {
      ws.send(`\r\n[bridge error: ${err.message}]\r\n`);
      ws.close(1011);
    } catch (e) {}
  });

  ws.on("message", (data) => {
    // RESIZE escapes pass through; terminal_pty.py parses them from stdin.
    try {
      child.stdin.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
    } catch (e) {}
  });

  // Keepalive so mobile radios / NAT don't silently drop the socket.
  const ping = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
  }, 30000);

  const killTree = (sig) => {
    if (child.pid) {
      try {
        process.kill(-child.pid, sig);
        return;
      } catch (e) {}
    }
    try {
      child.kill(sig);
    } catch (e) {}
  };

  ws.on("close", () => {
    clearInterval(ping);
    console.log(`${tag} socket closed`);
    killTree("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) killTree("SIGKILL");
    }, 1500);
  });
});

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`[bridge] listening on ${CONFIG.host}:${CONFIG.port} (cwd default: ${CONFIG.defaultCwd})`);
});
