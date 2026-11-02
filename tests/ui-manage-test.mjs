// Verifies the theme management UI: the per-card 编辑 / 删除 buttons, the two
// dialogs, and the request the page sends for each.
//
// Checked here:
//
//   1. Every local card carries 编辑 and 删除; the in-use card's 删除 is
//      disabled, because the engine refuses to delete the theme on screen.
//   2. Opening 编辑 prefills from the snapshot — including safeArea and the focus
//      values, which the card itself does not show.
//   3. Saving sends only the fields that changed, so a rename cannot reset the
//      art settings.
//   4. 删除 goes through a confirmation step, not a bare click.
//   5. While a command is in flight every action is disabled again.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "dreamskin-manage-"));
const PORT = 9414;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stateWith() {
  return {
    paused: false,
    active: "aaa",
    codexRunning: true,
    cdpUp: true,
    injector: { count: 1, fresh: true },
    market: [],
    themes: [
      {
        id: "aaa", name: "主题 A", appearance: "dark", taskMode: "full",
        safeArea: "none", focusX: 0.5, focusY: 0.5, preview: "", colors: {},
      },
      {
        id: "bbb", name: "主题 B", appearance: "dark", taskMode: "ambient",
        safeArea: "right", focusX: 0.25, focusY: 0.75, preview: "", colors: {},
      },
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
  writeState({ id: "", ok: true, message: "", state: stateWith() });
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
  return (method, params) => new Promise((r) => {
    const id = ++next;
    waiting.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
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

const TOOLS = `[...document.querySelectorAll('#themes .card')].map(c => ({
  name: c.querySelector('.name').textContent,
  tools: [...c.querySelectorAll('.tool')].map(b => ({ text: b.textContent, disabled: b.disabled })),
}))`;

const LAST_CALL = `(() => {
  const calls = window.__SET_CALLS || [];
  return calls.length ? calls[calls.length - 1].request : null;
})()`;

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
  await sleep(1600);

  // 1. The buttons exist and the in-use card cannot be deleted.
  const tools = await evaluate(send, TOOLS);
  check("两张卡片都有 编辑/删除", tools?.length === 2
    && tools.every((t) => t.tools.length === 2
      && t.tools[0].text === "编辑" && t.tools[1].text === "删除"));
  check("正在使用的卡片：删除被禁用", tools?.[0]?.tools[1]?.disabled === true);
  check("正在使用的卡片：编辑可用", tools?.[0]?.tools[0]?.disabled === false);
  check("未使用的卡片：两个按钮都可用",
    tools?.[1]?.tools[0]?.disabled === false && tools?.[1]?.tools[1]?.disabled === false);

  // 2. Editing prefills from the snapshot.
  await evaluate(send, `(() => {
    document.querySelectorAll('#themes .card')[1].querySelectorAll('.tool')[0].click();
    return true;
  })()`);
  await sleep(250);
  const prefill = await evaluate(send, `(() => {
    const d = document.getElementById('edit-dialog');
    return {
      open: d.open,
      id: document.getElementById('edit-id').textContent,
      name: document.getElementById('edit-name').value,
      appearance: document.getElementById('edit-appearance').value,
      taskMode: document.getElementById('edit-taskmode').value,
      safeArea: document.getElementById('edit-safearea').value,
      focusX: document.getElementById('edit-focusx').value,
      focusY: document.getElementById('edit-focusy').value,
      focusXOut: document.getElementById('edit-focusx-out').textContent,
    };
  })()`);
  check("编辑对话框打开", prefill?.open === true);
  check("预填 id", prefill?.id === "bbb", prefill?.id);
  check("预填名称", prefill?.name === "主题 B", prefill?.name);
  check("预填 safeArea", prefill?.safeArea === "right", prefill?.safeArea);
  check("预填 taskMode", prefill?.taskMode === "ambient", prefill?.taskMode);
  check("预填 focusX", String(prefill?.focusX) === "0.25", String(prefill?.focusX));
  check("焦点数值同步显示", prefill?.focusXOut === "0.25", prefill?.focusXOut);

  // 3. Changing only the name sends only the name.
  await evaluate(send, `(() => {
    document.getElementById('edit-name').value = '主题 B2';
    document.getElementById('edit-save').click();
    return true;
  })()`);
  await sleep(300);
  const update1 = await evaluate(send, LAST_CALL);
  check("发出 update", update1?.action === "update" && update1?.themeId === "bbb",
    JSON.stringify(update1));
  check("patch 只含 name", update1?.patch?.name === "主题 B2"
    && !("appearance" in (update1?.patch || {}))
    && !("safeArea" in (update1?.patch || {})),
    JSON.stringify(update1?.patch));
  check("对话框已关闭",
    (await evaluate(send, `document.getElementById('edit-dialog').open`)) === false);

  // 5. In-flight command disables everything.
  const busy = await evaluate(send, TOOLS);
  check("指令进行中：所有按钮禁用",
    busy?.every((t) => t.tools.every((b) => b.disabled)));

  // 4. Reload for a clean `pending`, then check the delete confirmation.
  await send("Page.reload", {});
  await sleep(1700);
  const delClicked = await evaluate(send, `(() => {
    const cards = [...document.querySelectorAll('#themes .card')];
    cards[1].querySelectorAll('.tool')[1].click();
    const d = document.getElementById('confirm-dialog');
    return { open: d.open, text: document.getElementById('confirm-text').textContent };
  })()`);
  check("删除前先弹确认框", delClicked?.open === true);
  check("确认框写出主题名", (delClicked?.text || "").includes("主题 B"), delClicked?.text);
  check("确认框出现时还没有发指令",
    (await evaluate(send, LAST_CALL)) === null);

  await evaluate(send, `(() => { document.getElementById('confirm-ok').click(); return true; })()`);
  await sleep(300);
  const delCall = await evaluate(send, LAST_CALL);
  check("确认后发出 delete", delCall?.action === "delete" && delCall?.themeId === "bbb",
    JSON.stringify(delCall));

  // 4b. Changing appearance + focus in one go forwards both, and not the name.
  await send("Page.reload", {});
  await sleep(1700);
  await evaluate(send, `(() => {
    document.querySelectorAll('#themes .card')[1].querySelectorAll('.tool')[0].click();
    return true;
  })()`);
  await sleep(250);
  await evaluate(send, `(() => {
    document.getElementById('edit-appearance').value = 'light';
    document.getElementById('edit-focusx').value = '0.9';
    document.getElementById('edit-focusx').dispatchEvent(new Event('input'));
    document.getElementById('edit-save').click();
    return true;
  })()`);
  await sleep(300);
  const update2 = await evaluate(send, LAST_CALL);
  check("外观 + 焦点一起发送", update2?.patch?.appearance === "light"
    && Number(update2?.patch?.focusX) === 0.9,
    JSON.stringify(update2?.patch));
  check("未改动名称就不发送 name", !("name" in (update2?.patch || {})),
    JSON.stringify(update2?.patch));
} finally {
  edge.kill();
  await sleep(400);
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
}

console.log(failures === 0 ? "  全部通过" : `  ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);