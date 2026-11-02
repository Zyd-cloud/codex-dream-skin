// Verifies the button-state rules of the theme page:
//
//   1. Clicking a theme disables every action at once and marks that card
//      「切换中…」.
//   2. Re-rendering from a fresh snapshot mid-switch must not hand out enabled
//      buttons. (The reported bug: the card went back to a clickable 「使用」.)
//   3. A reply that says ok but whose state still names the OLD theme must NOT
//      unlock the card — the display has to match reality before it is
//      clickable again.
//   4. Only when the snapshot both answers the command and shows the new theme
//      active does the card become 「使用中」.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "dreamskin-ui-"));
const PORT = 9412;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stateWith(active) {
  return {
    paused: false,
    active,
    codexRunning: true,
    cdpUp: true,
    injector: { count: 1, fresh: true },
    market: [],
    themes: [
      { id: "aaa", name: "主题 A", appearance: "dark", taskMode: "full", preview: "", colors: {} },
      { id: "bbb", name: "主题 B", appearance: "dark", taskMode: "full", preview: "", colors: {} },
    ],
  };
}

function writeState(payload) {
  fs.writeFileSync(
    path.join(WORK, "state.js"),
    `globalThis.__DREAM_SKIN_STATE__ = ${JSON.stringify(payload)};\n`,
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
      options: {
        get: async () => ({ request: {} }),
        set: async (o) => { window.__SET_CALLS.push(o); return o; },
      },
      read: async () => ({}),
    };
  `, "utf8");
  writeState({ id: "", ok: true, message: "", state: stateWith("aaa") });
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

const CARDS = `[...document.querySelectorAll('#themes .card')].map(c => ({
  name: c.querySelector('.name').textContent,
  pick: c.querySelector('.pick').textContent,
  disabled: c.querySelector('.pick').disabled,
  switching: c.classList.contains('switching'),
}))`;

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
  await sleep(900);

  // --- 1. initial ----------------------------------------------------------
  const initial = await evaluate(send, CARDS);
  check("初始：活动主题「使用中」且禁用", initial?.[0]?.pick === "使用中" && initial[0].disabled);
  check("初始：另一张可点击", initial?.[1]?.disabled === false && initial[1].pick === "使用");

  // --- 2. click -----------------------------------------------------------
  await evaluate(send, `document.querySelectorAll('#themes .pick')[1].click()`);
  await sleep(150);
  const clicked = await evaluate(send, CARDS);
  check("点击后立刻「切换中…」", clicked?.[1]?.pick === "切换中…", JSON.stringify(clicked?.[1]));
  check("点击后立刻禁用", clicked?.[1]?.disabled === true);
  check("点击后全部不可点", clicked?.every((c) => c.disabled) === true);

  const calls = await evaluate(send, `window.__SET_CALLS.map(o => o.request)`);
  const requestId = calls?.[0]?.id;
  check("发出 request（switch → bbb）",
    Boolean(requestId) && calls[0].action === "switch" && calls[0].themeId === "bbb",
    JSON.stringify(calls?.[0]));

  // --- 3. stale snapshot mid-switch --------------------------------------
  writeState({ id: "", ok: true, message: "", state: stateWith("aaa") });
  await sleep(2600);
  const mid = await evaluate(send, CARDS);
  check("切换中重渲染后仍是「切换中…」", mid?.[1]?.pick === "切换中…", JSON.stringify(mid?.[1]));
  check("切换中重渲染后仍然禁用", mid?.[1]?.disabled === true);
  check("切换中全部不可点", mid?.every((c) => c.disabled) === true);

  // --- 4. THE regression: reply says ok, state still names the old theme ---
  writeState({ id: requestId, ok: true, message: "已切换到 bbb", state: stateWith("aaa") });
  await sleep(2600);
  const liar = await evaluate(send, CARDS);
  check("响应成功但状态仍是旧主题时，不解锁", liar?.[1]?.disabled === true, JSON.stringify(liar?.[1]));
  check("……且仍显示「切换中…」", liar?.[1]?.pick === "切换中…");
  check("……顶部按钮也仍禁用",
    (await evaluate(send, `document.getElementById('btn-apply').disabled`)) === true);

  // --- 5. the state finally agrees ---------------------------------------
  writeState({ id: requestId, ok: true, message: "已切换到 bbb", state: stateWith("bbb") });
  await sleep(2600);
  const done = await evaluate(send, CARDS);
  check("状态到位后 B 变成「使用中」", done?.[1]?.pick === "使用中", JSON.stringify(done?.[1]));
  check("状态到位后 A 恢复可点", done?.[0]?.disabled === false, JSON.stringify(done?.[0]));
  check("没有卡片还标着切换中", done?.every((c) => !c.switching) === true);
  check("提示说切换完成",
    String(await evaluate(send, `document.getElementById('toast').textContent`)).includes("已切换到 bbb"));

  // --- 6. one command at a time ------------------------------------------
  const before = await evaluate(send, `window.__SET_CALLS.length`);
  await evaluate(send, `document.querySelectorAll('#themes .pick')[0].click()`);
  await sleep(80);
  await evaluate(send, `document.querySelectorAll('#themes .pick')[1].click()`);
  await sleep(250);
  const after = await evaluate(send, `window.__SET_CALLS.length`);
  check("连点两次只发一条命令", after === before + 1, `${before} → ${after}`);

  await send("Runtime.disable", {});
} finally {
  edge.kill();
  await sleep(300);
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
}

console.log(failures === 0 ? "\n  全部通过" : `\n  ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
