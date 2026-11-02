// Proves the page no longer rebuilds the grid on every poll.
//
// Before: `poll()` called `render()` unconditionally, so every 2 s the whole
// card list was replaced and every <img> re-created — flicker plus wasted CPU.
// Now the worker stamps each publish with `rev`, and the page redraws only when
// it changes. This test holds the snapshot still and counts mutations.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "dreamskin-redraw-"));
const PORT = 9421;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function statePayload(rev) {
  return {
    rev,
    id: "",
    ok: true,
    message: "",
    state: {
      paused: false,
      active: "aaa",
      codexRunning: true,
      cdpUp: true,
      injector: { count: 1, fresh: true },
      market: [],
      themes: [
        { id: "aaa", name: "主题 A", appearance: "dark", taskMode: "full", preview: "", colors: {} },
        { id: "bbb", name: "主题 B", appearance: "dark", taskMode: "full", preview: "", colors: {} },
      ],
    },
  };
}

function writeState(rev) {
  fs.writeFileSync(
    path.join(WORK, "state.js"),
    `globalThis.__DREAM_SKIN_STATE__ = ${JSON.stringify(statePayload(rev))};\n`,
    "utf8",
  );
}

function stage() {
  fs.cpSync(path.join(PLUGIN, "page"), WORK, { recursive: true });
  fs.rmSync(path.join(WORK, "state.js"), { force: true });
  fs.mkdirSync(path.join(WORK, "_magpie"), { recursive: true });
  fs.writeFileSync(path.join(WORK, "_magpie", "bridge.js"), `
    window.__SET_CALLS = [];
    window.magpie = {
      ready: Promise.resolve({ dark: true, lang: "zh", tokens: {} }),
      theme: { dark: true, lang: "zh", tokens: {} },
      onTheme() {}, context: {}, onAction() {},
      options: { get: async () => ({ request: {} }), set: async (o) => { window.__SET_CALLS.push(o); return o; } },
      read: async () => ({}),
    };
  `, "utf8");
  writeState(1000);
}

async function connect(url) {
  const ws = new WebSocket(url);
  let next = 0;
  const waiting = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  };
  await new Promise((r) => { ws.onopen = r; });
  const send = (method, params) => new Promise((r) => {
    const id = ++next;
    waiting.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
  return send;
}

async function evaluate(send, expression) {
  const res = await send("Runtime.evaluate", {
    expression: `JSON.stringify(${expression})`,
    returnByValue: true,
    awaitPromise: true,
  });
  const value = res.result?.result?.value;
  return value ? JSON.parse(value) : null;
}

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!ok) failures += 1;
};

stage();
const edge = spawn(EDGE, [
  "--headless=new", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(WORK, "profile")}`,
  "--no-first-run", "--disable-gpu",
  `file:///${path.join(WORK, "index.html").replace(/\\/g, "/")}`,
], { stdio: "ignore", windowsHide: true });

try {
  let page = null;
  for (let i = 0; i < 40 && !page; i += 1) {
    await sleep(300);
    try {
      page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
        .find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    } catch {}
  }
  if (!page) throw new Error("headless Edge never opened a page");
  const send = await connect(page.webSocketDebuggerUrl);
  await send("Runtime.enable", {});
  await sleep(1200);

  const cards = await evaluate(send, `document.querySelectorAll('#themes .card').length`);
  check("首次渲染出两张卡片", cards === 2, String(cards));

  // Count childList mutations on the grid from here on.
  await evaluate(send, `(() => {
    window.__rebuilds = 0;
    const grid = document.getElementById('themes');
    new MutationObserver((records) => {
      for (const r of records) if (r.type === 'childList') window.__rebuilds += 1;
    }).observe(grid, { childList: true });
    return true;
  })()`);

  // Nothing changes in state.js across several polls.
  await sleep(5200);
  const steady = await evaluate(send, `window.__rebuilds`);
  check("状态不变时 5 秒内不重建卡片", steady === 0, `重建 ${steady} 次`);

  // Now publish a new rev — exactly once — and expect exactly one rebuild.
  writeState(1001);
  await sleep(2600);
  const afterChange = await evaluate(send, `window.__rebuilds`);
  check("发布新 rev 后重建一次", afterChange >= 1 && afterChange <= 2, `重建 ${afterChange} 次`);

  // And back to steady.
  const beforeHold = await evaluate(send, `window.__rebuilds`);
  await sleep(4200);
  const held = await evaluate(send, `window.__rebuilds`);
  check("之后再次安静下来", held === beforeHold, `${beforeHold} → ${held}`);

  await send("Runtime.disable", {});
} finally {
  edge.kill();
  await sleep(300);
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
}

console.log(failures === 0 ? "\n  全部通过" : `\n  ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);