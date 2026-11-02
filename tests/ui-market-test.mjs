// 「显示更多」and search must pull previews for the themes they reveal.
//
// The page cannot fetch (connect-src 'none'), so the worker downloads
// thumbnails into the page's own folder. This checks that:
//
//   1. On first render the page asks for thumbnails covering the visible batch.
//   2. That request is quiet — it must not lock the controls.
//   3. 「显示更多」asks again for the newly revealed entries.
//   4. Search asks for the matches it brings on screen.
//   5. Once the worker fills them in, the images actually appear.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "dreamskin-market-"));
const PORT = 9413;
const TOTAL = 60;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function marketState(previewCount) {
  const market = Array.from({ length: TOTAL }, (_, i) => ({
    id: `ver_${String(i).padStart(3, "0")}`,
    themeId: `theme-${String(i).padStart(3, "0")}`,
    name: `市场主题 ${i}`,
    version: "1.0.0",
    author: i % 2 ? "alice" : "bob",
    downloads: i,
    preview: i < previewCount ? `market-theme-${String(i).padStart(3, "0")}.jpg` : "",
    installed: false,
    appearance: "",
    taskMode: "",
  }));
  return {
    paused: false,
    active: "local-a",
    codexRunning: true,
    cdpUp: true,
    injector: { count: 1, fresh: true },
    market,
    themes: [
      { id: "local-a", name: "本地 A", appearance: "dark", taskMode: "full", preview: "", colors: {} },
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
  fs.rmSync(path.join(WORK, "previews"), { recursive: true, force: true });
  fs.mkdirSync(path.join(WORK, "previews"), { recursive: true });
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
  writeState({ id: "", ok: true, message: "", state: marketState(0) });
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

  const thumbCalls = `window.__SET_CALLS
    .map(o => o.request)
    .filter(r => r && r.action === "market-thumbs")`;

  // --- 1. first render asks for the visible batch -------------------------
  const cards1 = await evaluate(send, `document.querySelectorAll('#market .card').length`);
  check("首屏显示 24 张市场卡片", cards1 === 24, String(cards1));

  const call1 = await evaluate(send, thumbCalls);
  check("首屏发出了一次 preview 请求", call1?.length === 1, `${call1?.length} 次`);
  check("请求覆盖了首屏 24 个", call1?.[0]?.ids?.length === 24, JSON.stringify(call1?.[0]?.ids?.length));
  check("请求的 id 就是首屏那些",
    JSON.stringify(call1?.[0]?.ids) === JSON.stringify(
      Array.from({ length: 24 }, (_, i) => `ver_${String(i).padStart(3, "0")}`),
    ));

  // --- 2. it must be a quiet request -------------------------------------
  const locked = await evaluate(send, `({
    apply: document.getElementById('btn-apply').disabled,
    market: document.getElementById('btn-market').disabled,
    search: document.getElementById('market-search').disabled,
  })`);
  check("preview 请求不锁界面", !locked?.apply && !locked?.market && !locked?.search, JSON.stringify(locked));

  // --- 3. 「显示更多」asks for the rest ----------------------------------
  await evaluate(send, `document.getElementById('btn-more').click()`);
  await sleep(900);
  const cards2 = await evaluate(send, `document.querySelectorAll('#market .card').length`);
  check("显示更多后 48 张", cards2 === 48, String(cards2));

  await sleep(4500);   // past the page's 4 s quiet-request cooldown
  const call2 = await evaluate(send, thumbCalls);
  check("显示更多后又发了一次请求", call2?.length === 2, `${call2?.length} 次`);
  const second = call2?.[1]?.ids || [];
  check("第二次只请求新露出的 24 个", second.length === 24, JSON.stringify(second.length));
  check("新请求从第 25 个开始", second[0] === "ver_024", JSON.stringify(second[0]));
  check("已请求过的不重复要", !second.some((id) => call1[0].ids.includes(id)));

  // --- 4. the worker fills them in ---------------------------------------
  for (let i = 0; i < 24; i += 1) {
    const name = `market-theme-${String(i).padStart(3, "0")}.jpg`;
    fs.writeFileSync(path.join(WORK, "previews", name), "x");
  }
  writeState({ id: "", ok: true, message: "", state: marketState(24) });
  await sleep(2600);
  const imgs = await evaluate(send, `document.querySelectorAll('#market .card .shot img').length`);
  check("预览到达后出现图片", imgs === 24, `${imgs} 张`);
  const hint = await evaluate(send, `document.getElementById('market-hint').textContent`);
  check("提示里还剩 6 张待加载", String(hint).includes("6"), String(hint));

  // --- 5. search pulls previews for what it reveals ----------------------
  writeState({ id: "", ok: true, message: "", state: marketState(0) });
  await sleep(2600);
  const beforeSearch = (await evaluate(send, thumbCalls))?.length;
  await evaluate(send, `(() => {
    const el = document.getElementById('market-search');
    el.value = '主题 5';
    el.dispatchEvent(new Event('input'));
  })()`);
  await sleep(4600);
  const afterSearch = await evaluate(send, thumbCalls);
  check("搜索后请求了新露出的条目", afterSearch.length > beforeSearch,
    `${beforeSearch} → ${afterSearch.length}`);
  const searched = afterSearch[afterSearch.length - 1]?.ids || [];
  check("只请求从未露过面的那些", searched.length === 10, JSON.stringify(searched));
  check("从第 50 个起", searched[0] === "ver_050", JSON.stringify(searched[0]));
  check("已问过的不再重复", !searched.includes("ver_005"), JSON.stringify(searched));
  const matched = await evaluate(send, `document.querySelectorAll('#market .card').length`);
  check("搜索过滤生效（主题 5 + 50..59 共 11 个）", matched === 11, String(matched));

  // --- 6. an installed market theme offers 「使用」 and switches by themeId --
  await evaluate(send, `(() => {
    const el = document.getElementById('market-search');
    el.value = '';
    el.dispatchEvent(new Event('input'));
  })()`);
  const st2 = marketState(0);
  st2.market[0].installed = true;
  writeState({ id: "", ok: true, message: "", state: st2 });
  await sleep(2600);
  const firstBtn = await evaluate(send, `({
    text: document.querySelector('#market .card .pick').textContent,
    disabled: document.querySelector('#market .card .pick').disabled,
  })`);
  check("已安装的市场主题显示「使用」", firstBtn?.text === "使用", JSON.stringify(firstBtn));
  check("……而且可以点", firstBtn?.disabled === false);
  await evaluate(send, `document.querySelector('#market .card .pick').click()`);
  await sleep(400);
  const lastCall = await evaluate(send, `window.__SET_CALLS[window.__SET_CALLS.length - 1].request`);
  check("点「使用」按 themeId 切换，不是版本 id",
    lastCall?.action === "switch" && lastCall?.themeId === "theme-000", JSON.stringify(lastCall));

  await send("Runtime.disable", {});
} finally {
  edge.kill();
  await sleep(300);
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
}

console.log(failures === 0 ? "\n  全部通过" : `\n  ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
