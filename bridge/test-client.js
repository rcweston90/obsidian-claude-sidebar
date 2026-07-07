#!/usr/bin/env node
"use strict";
// Quick smoke test: connect, run a command, test RESIZE passthrough, report.
// Usage: BRIDGE_TOKEN=... node test-client.js [ws://127.0.0.1:8898]

const WebSocket = require("ws");

const base = process.argv[2] || "ws://127.0.0.1:8898";
const token = process.env.BRIDGE_TOKEN;
if (!token) {
  console.error("Set BRIDGE_TOKEN");
  process.exit(1);
}

const ws = new WebSocket(`${base}/pty?token=${encodeURIComponent(token)}&cols=80&rows=24`);
let out = "";
let phase = 0;
let done = false;

function finish(ok, msg) {
  if (done) return;
  done = true;
  console.log(ok ? `PASS: ${msg}` : `FAIL: ${msg}`);
  try { ws.close(); } catch (e) {}
  setTimeout(() => process.exit(ok ? 0 : 1), 200);
}

ws.on("open", () => {
  console.log("connected");
  setTimeout(() => ws.send("echo BRIDGE_$((40+2))_OK\n"), 1500);
});

ws.on("message", (d) => {
  out += d.toString("utf8");
  if (phase === 0 && out.includes("BRIDGE_42_OK")) {
    phase = 1;
    console.log("shell echo OK; testing RESIZE...");
    ws.send("\x1b]RESIZE;120;40\x07");
    setTimeout(() => ws.send("stty size\n"), 500);
  } else if (phase === 1 && /40 120/.test(out)) {
    finish(true, "shell I/O and RESIZE passthrough both work");
  }
});

ws.on("error", (e) => finish(false, `ws error: ${e.message}`));
ws.on("close", () => { if (!done) finish(false, `closed early. output tail:\n${out.slice(-500)}`); });
setTimeout(() => finish(false, `timeout. output tail:\n${out.slice(-500)}`), 25000);
