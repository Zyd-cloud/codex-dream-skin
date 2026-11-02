// Codex Dream Skin — the long-lived worker.
//
// Spawned detached by index.mjs and outlives it. That separation matters: the
// plugin host is torn down and re-created every time the plugin's options are
// written, which is exactly how the page asks for something. Keeping the work
// here means a host restart cannot interrupt a command halfway through.
//
// Jobs:
//   1. bootstrap  — deploy the engine, seed a theme, create the shortcuts
//   2. supervise  — keep the injector alive and pointed at Codex's browser id
//   3. serve      — poll options.request, run the action, publish page/state.js
//
// state.js (not an options write) is how the page is answered: its own folder is
// served to it, so a <script> tag reaches it, while `connect-src 'none'` blocks
// fetch. Writing a file needs no magpie round-trip and so never restarts a host.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Derive the state root from LOCALAPPDATA when it is there: a preview host runs
// with a redirected environment, and homedir() then points somewhere the engine
// is not, which surfaced as "missing helper: control-dream-skin.ps1".
const STATE_ROOT =
  process.env.CODEX_DREAM_SKIN_ROOT
  || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "CodexDreamSkin");
const ENGINE = path.join(STATE_ROOT, "engine");
const PAGE_DIR = path.join(ROOT, "page");
const PREVIEW_DIR = path.join(PAGE_DIR, "previews");
const CONFIG_DIR = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
  "magpie",
);
const PLUGINS_JSON = path.join(CONFIG_DIR, "plugins.json");
const LOG_FILE = path.join(STATE_ROOT, "plugin-autostart.log");
const PID_FILE = path.join(STATE_ROOT, "worker.pid");
const BOOTSTRAP_MARKER = path.join(STATE_ROOT, "bootstrap.json");
const CLAIM_DIR = path.join(STATE_ROOT, "claims");
const WORKER_DIR = path.join(STATE_ROOT, "workers");
const MARKET_FILE = path.join(STATE_ROOT, "market.json");

const SUPERVISE_MS = 15_000;
const SUPERVISE_WATCHDOG_MS = 120_000;
const HEARTBEAT_MS = 10_000;
const COMMAND_POLL_MS = 1_500;
const STATE_REFRESH_MS = 30_000;
const BOOTSTRAP_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const CLAIM_STALE_MS = 90_000;
const HEALTH_INTERVAL_MS =
  Number(process.env.CODEX_DREAM_SKIN_HEALTH_MS) || 10 * 60 * 1000;
const HEALTH_DAILY_MS = 24 * 60 * 60 * 1000;
const WORKER_FRESH_MS = 60_000;
// The one place the CDP port is decided. Everything that opens or probes it —
// the launch flags, the injector watcher, the supervisor and the status probe —
// is handed this value, so changing the port means changing one line (or setting
// CODEX_DREAM_SKIN_PORT in the environment).
const PORT = Number(process.env.CODEX_DREAM_SKIN_PORT) || 9335;

let lastRequestId = "";
let lastPublishAt = 0;
let busy = false;
let publishRev = Date.now();   // monotonic per publish; survives no restart

// --- small helpers ----------------------------------------------------------

const LOG_MAX_BYTES = 512 * 1024;
const LOG_KEEP_LINES = 300;
const INJECTOR_ARCHIVES_TO_KEEP = 20;

let logBytes = -1;

/** Trim a log to its tail, so a plugin left running for months stays bounded. */
function rotateLog() {
  try {
    const tail = fs.readFileSync(LOG_FILE, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .slice(-LOG_KEEP_LINES)
      .join("\n");
    fs.writeFileSync(LOG_FILE, `${tail}\n`, "utf8");
    logBytes = Buffer.byteLength(tail);
  } catch {
    logBytes = 0;
  }
}

function log(message) {
  try {
    fs.mkdirSync(STATE_ROOT, { recursive: true });
    if (logBytes < 0) {
      try { logBytes = fs.statSync(LOG_FILE).size; } catch { logBytes = 0; }
    }
    const line = `${new Date().toISOString()} ${message}\n`;
    fs.appendFileSync(LOG_FILE, line);
    logBytes += Buffer.byteLength(line);
    if (logBytes > LOG_MAX_BYTES) rotateLog();
  } catch {}
}

/**
 * The injector supervisor archives its output on every restart, and nothing ever
 * removed the old ones — 30 files had piled up in three days.
 */
function pruneInjectorArchives() {
  try {
    const archives = fs.readdirSync(STATE_ROOT)
      .filter((name) => /^injector-runtime\.log(\.err)?\.\d{8}-\d{6}-\d+$/.test(name))
      .map((name) => ({
        name,
        at: fs.statSync(path.join(STATE_ROOT, name)).mtimeMs,
      }))
      .sort((a, b) => b.at - a.at);
    for (const old of archives.slice(INJECTOR_ARCHIVES_TO_KEEP)) {
      try { fs.rmSync(path.join(STATE_ROOT, old.name), { force: true }); } catch {}
    }
  } catch {}
}

/**
 * Theme previews outlive the theme when it is deleted, and nothing removed them.
 * Only ever run this with a non-empty theme list: an empty one would be a failed
 * status read, and would wipe every preview.
 */
function pruneOrphanPreviews(themes) {
  if (!Array.isArray(themes) || themes.length === 0) return;
  try {
    const ids = new Set(themes.map((t) => String(t.id)));
    let removed = 0;
    for (const name of fs.readdirSync(PREVIEW_DIR)) {
      if (!name.endsWith(".jpg") || name.startsWith("market-")) continue;
      const id = name.slice(0, -4);
      if (ids.has(id)) continue;
      try { fs.rmSync(path.join(PREVIEW_DIR, name), { force: true }); removed += 1; } catch {}
    }
    if (removed > 0) log(`pruned ${removed} orphaned theme preview(s)`);
  } catch {}
}

// --- background self-check ---------------------------------------------------
//
// Everything here has bitten this plugin at least once: 27 stray workers, 189 MB
// of archived backgrounds, a 50-file archive pile, corrupt previews that never
// retried, a supervisor that silently stopped. None of them raised anything — the
// only symptom was "the page looks wrong", days later. This pass watches the same
// numbers and writes to the log when one crosses a line.
//
// It stays in the background on purpose: no UI badge, no toast. And it only
// writes on a *change* (plus one summary a day) so a healthy install stays quiet.

const HEALTH_MIN_BYTES = 1024 * 1024;
const HEALTH_LIMITS = {
  imageBytes: 300 * HEALTH_MIN_BYTES,
  imageFiles: 200,
  marketPreviews: 800,
  claims: 60,
  pluginLogBytes: 2 * LOG_MAX_BYTES,
  watchLogBytes: 8 * HEALTH_MIN_BYTES,
  stateBytes: 400 * 1024,
};

let lastHealthIssues = null;      // array of strings, or null before the first pass
let lastHealthSummaryAt = 0;
let lastStateSnapshot = null;     // the freshest status the worker has seen

function directoryStats(dir) {
  let files = 0;
  let bytes = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = directoryStats(full);
        files += sub.files;
        bytes += sub.bytes;
      } else {
        files += 1;
        try { bytes += fs.statSync(full).size; } catch {}
      }
    }
  } catch {}
  return { files, bytes };
}

function fileSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

/**
 * Gather the numbers and decide what is wrong. Returns the issue list plus a
 * one-line metric summary, so the log entry can be read without digging.
 */
function collectHealth() {
  const issues = [];
  const metrics = [];

  const workers = pruneWorkerMarkers();
  metrics.push(`workers=${workers}`);
  if (workers > 1) {
    issues.push(`${workers} worker processes sharing the lock (expected 1)`);
  }

  const images = directoryStats(path.join(STATE_ROOT, "images"));
  const imageMB = Math.round(images.bytes / HEALTH_MIN_BYTES);
  metrics.push(`images=${images.files}/${imageMB}MB`);
  if (images.bytes > HEALTH_LIMITS.imageBytes || images.files > HEALTH_LIMITS.imageFiles) {
    issues.push(`images/ holds ${images.files} files (${imageMB} MB)`);
  }

  let localPreviews = 0;
  let marketPreviews = 0;
  try {
    for (const name of fs.readdirSync(PREVIEW_DIR)) {
      if (!name.endsWith(".jpg")) continue;
      if (name.startsWith("market-")) marketPreviews += 1;
      else localPreviews += 1;
    }
  } catch {}
  metrics.push(`previews=${localPreviews}+${marketPreviews}`);
  if (marketPreviews > HEALTH_LIMITS.marketPreviews) {
    issues.push(`${marketPreviews} market thumbnails cached`);
  }
  const knownThemes = Array.isArray(lastStateSnapshot?.themes) ? lastStateSnapshot.themes.length : 0;
  if (knownThemes > 0 && localPreviews > knownThemes) {
    issues.push(`${localPreviews - knownThemes} theme preview(s) no longer match a theme`);
  }

  let claims = 0;
  try { claims = fs.readdirSync(CLAIM_DIR).length; } catch {}
  metrics.push(`claims=${claims}`);
  if (claims > HEALTH_LIMITS.claims) {
    issues.push(`${claims} request claims retained`);
  }

  const pluginLog = fileSize(LOG_FILE);
  metrics.push(`log=${Math.round(pluginLog / 1024)}KB`);
  if (pluginLog > HEALTH_LIMITS.pluginLogBytes) {
    issues.push(`plugin-autostart.log is ${Math.round(pluginLog / 1024)} KB (rotation is not keeping up)`);
  }

  const watchLog = fileSize(path.join(STATE_ROOT, "codex-watch.log"));
  metrics.push(`watch=${Math.round(watchLog / 1024)}KB`);
  if (watchLog > HEALTH_LIMITS.watchLogBytes) {
    issues.push(`codex-watch.log is ${Math.round(watchLog / 1024)} KB (its rotation is not running)`);
  }

  const stateBytes = fileSize(path.join(PAGE_DIR, "state.js"));
  metrics.push(`state=${Math.round(stateBytes / 1024)}KB`);
  if (stateBytes > HEALTH_LIMITS.stateBytes) {
    issues.push(`state.js is ${Math.round(stateBytes / 1024)} KB`);
  }

  // The injector is only expected to be fresh while Codex is running with CDP
  // open. Its absence otherwise is normal, not a fault.
  if (lastStateSnapshot?.cdpUp) {
    const fresh = Boolean(lastStateSnapshot.injector?.fresh);
    metrics.push(`injector=${fresh ? "fresh" : "stale"}`);
    if (!fresh) {
      issues.push("Codex exposes CDP but the injector is not attached");
    }
  } else {
    metrics.push("injector=n/a");
  }

  return { issues, summary: metrics.join(" ") };
}

function healthTick() {
  const { issues, summary } = collectHealth();
  const previous = lastHealthIssues;
  const changed = previous === null
    || previous.length !== issues.length
    || previous.some((item, index) => item !== issues[index]);

  if (issues.length > 0) {
    if (changed) {
      log(`health: ${issues.length} issue(s) — ${issues.join("; ")} | ${summary}`);
    }
    lastHealthIssues = issues;
    return;
  }

  if (previous && previous.length > 0) {
    log(`health: back to normal (was ${previous.length} issue(s)) | ${summary}`);
    lastHealthIssues = [];
    lastHealthSummaryAt = Date.now();
    return;
  }

  // Nothing wrong: say so once a day, so a silent log is not ambiguous.
  if (Date.now() - lastHealthSummaryAt > HEALTH_DAILY_MS) {
    lastHealthSummaryAt = Date.now();
    log(`health: ok | ${summary}`);
  }
  lastHealthIssues = [];
}

/** Generate the missing theme previews — a fresh install has none. */
function ensurePreviews(themes) {
  if (!Array.isArray(themes) || themes.length === 0) return;
  if (!themes.some((t) => !t.preview)) return;
  const result = control("refresh-previews", [], 120000);
  if (result?.generated > 0) log(`generated ${result.generated} theme preview(s)`);
}

function readOptions() {
  try {
    const doc = JSON.parse(fs.readFileSync(PLUGINS_JSON, "utf8"));
    const self = path.resolve(ROOT).toLowerCase();
    const entry = (Array.isArray(doc.plugins) ? doc.plugins : []).find((p) => {
      if (!p || typeof p.spec !== "string") return false;
      try { return path.resolve(p.spec).toLowerCase() === self; } catch { return false; }
    });
    return (entry && typeof entry.options === "object" && entry.options) || {};
  } catch {
    return {};
  }
}

function fetchJson(url, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { signal: controller.signal }).then((r) => r.json())
    .finally(() => clearTimeout(timer));
}

function runPs(script, args, timeoutMs = 120000) {
  const bin = path.join(ENGINE, "scripts", script);
  if (!fs.existsSync(bin)) return { ok: false, error: `missing helper: ${script}` };
  try {
    const out = spawnSync("powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", bin, ...args],
      { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
    const line = (out.stdout || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
    if (!line) return { ok: false, error: (out.stderr || "no output").trim().slice(0, 300) };
    try { return JSON.parse(line); } catch { return { ok: false, error: line.slice(0, 300) }; }
  } catch (error) {
    return { ok: false, error: `${error?.message ?? error}` };
  }
}

function control(action, extra = [], timeoutMs = 120000, withStatus = false) {
  const args = ["-Action", action, "-PreviewDir", PREVIEW_DIR, "-Port", String(PORT), ...extra];
  // -WithStatus folds the status read into this call. Asking separately costs a
  // second PowerShell startup (~1.6 s) for data this action already touched.
  if (withStatus) args.push("-WithStatus");
  return runPs("control-dream-skin.ps1", args, timeoutMs);
}

// --- 1. bootstrap -----------------------------------------------------------

/**
 * A cheap fingerprint of a directory tree: relative path plus size, for every
 * file. Good enough to answer "is the deployed copy the one I ship?".
 */
function treeManifest(dir) {
  const parts = [];
  const walk = (current, prefix) => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, key);
      else { try { parts.push(`${key}:${fs.statSync(full).size}`); } catch {} }
    }
  };
  walk(dir, "");
  return parts.join("|");
}

/** Copy files that differ, writing beside the target and renaming into place. */
function syncTree(source, target) {
  let copied = 0;
  const walk = (src, dest) => {
    try { fs.mkdirSync(dest, { recursive: true }); } catch { return; }
    let entries;
    try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const from = path.join(src, entry.name);
      const to = path.join(dest, entry.name);
      if (entry.isDirectory()) { walk(from, to); continue; }
      try {
        const sourceSize = fs.statSync(from).size;
        let same = false;
        try { same = fs.statSync(to).size === sourceSize; } catch {}
        if (same) continue;
        // Atomic replace: the injector supervisor may be starting a process
        // that reads this file, and it must never see a half-written one.
        const staging = `${to}.incoming`;
        fs.copyFileSync(from, staging);
        fs.renameSync(staging, to);
        copied += 1;
      } catch {}
    }
  };
  walk(source, target);
  return copied;
}

/**
 * Bring the deployed engine to the version this plugin ships.
 *
 * bootstrap only copied the engine when nothing was deployed yet, so anyone who
 * updated the plugin kept running the engine from their first install — a newer
 * worker would then call a helper that did not understand its arguments. That is
 * exactly how a `-Port` parameter reached a bootstrap that had never heard of it.
 */
function syncEngine() {
  const source = path.join(ROOT, "engine");
  if (!fs.existsSync(path.join(source, "scripts", "injector.mjs"))) return;
  try {
    if (treeManifest(source) === treeManifest(ENGINE)) return;
    const copied = syncTree(source, ENGINE);
    if (copied > 0) log(`engine synced from the plugin (${copied} file(s) updated)`);
  } catch (error) {
    log(`engine sync failed: ${error?.message ?? error}`);
  }
}

function bootstrapNeeded() {
  if (!fs.existsSync(path.join(ENGINE, "scripts", "injector.mjs"))) return true;
  try {
    const marker = JSON.parse(fs.readFileSync(BOOTSTRAP_MARKER, "utf8"));
    if (typeof marker.at === "number" && Date.now() - marker.at < BOOTSTRAP_MAX_AGE_MS) return false;
  } catch {}
  return true;
}

function bootstrap() {
  if (!bootstrapNeeded()) return { ok: true, cached: true };
  const result = runPs("bootstrap-dream-skin.ps1", [
    "-EngineRoot", ENGINE,
    "-StateRoot", STATE_ROOT,
    "-PreviewDir", PREVIEW_DIR,
    "-ThemeLibrary", path.join(ROOT, "themes"),
    "-LauncherDir", path.join(ROOT, "launcher"),
    "-Port", String(PORT),
    // Opting out has to be sticky: bootstrap re-runs every few hours, so a
    // shortcut the user deleted would otherwise reappear. The marker file is
    // created by the user, never by the plugin.
    ...(fs.existsSync(path.join(STATE_ROOT, "no-shortcuts.flag")) ? ["-SkipShortcuts"] : []),
  ], 180000);
  log(`bootstrap: ${result?.ok ? "ok" : "failed"} ${result?.error || JSON.stringify(result?.steps || {})}`);
  if (result?.ok) {
    try { fs.writeFileSync(BOOTSTRAP_MARKER, JSON.stringify({ at: Date.now() }), "utf8"); } catch {}
  }
  return result;
}

// --- 2. supervision ---------------------------------------------------------

const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
let lastPruneAt = 0;

/**
 * Reclaim the archived background copies. Each theme switch writes a new one,
 * so without this the folder reached 189 MB with a single file still in use.
 * Six-hourly is plenty; it is also the only place that touches images/, so it
 * cannot race a switch that just wrote one.
 */
function pruneIfDue() {
  if (Date.now() - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = Date.now();
  const result = control("prune", [], 120000);
  if (result?.removed > 0) {
    const mb = Math.round((result.freedBytes || 0) / (1024 * 1024));
    log(`pruned ${result.removed} archived image(s), freed ${mb} MB`);
  }
}

let superviseInFlight = false;

/**
 * Keep the injector alive, without blocking the command loop.
 *
 * `runPs` is a spawnSync, and ensure-injector takes ~2 s. Run on a 15 s timer it
 * held the single thread for 14 % of the time, so a click in the page could sit
 * behind supervision for seconds. Nothing here needs the result, so it goes to a
 * child process instead.
 *
 * ensure-injector guards its own body with a named mutex, so an overlapping run
 * just exits — but the in-flight flag keeps us from piling up processes anyway.
 */
function supervise() {
  if (superviseInFlight) return;
  const script = path.join(ENGINE, "scripts", "ensure-injector.ps1");
  if (!fs.existsSync(script)) return;
  superviseInFlight = true;
  try {
    const child = spawn("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
      "-File", script, "-Port", String(PORT),
    ], { stdio: "ignore", windowsHide: true });
    // Without a watchdog a single hung PowerShell would leave the flag set for
    // the life of the worker, and supervision would stop silently.
    const watchdog = setTimeout(() => {
      try { child.kill(); } catch {}
      superviseInFlight = false;
      log("supervise watchdog: a run did not return, cleared it");
    }, SUPERVISE_WATCHDOG_MS);
    watchdog.unref?.();
    const clear = () => {
      clearTimeout(watchdog);
      superviseInFlight = false;
    };
    child.on("exit", clear);
    child.on("error", (error) => {
      clear();
      log(`supervise failed: ${error?.message ?? error}`);
    });
  } catch (error) {
    superviseInFlight = false;
    log(`supervise failed: ${error?.message ?? error}`);
  }
}

function startWatcher() {
  const script = path.join(ENGINE, "scripts", "watch-codex.ps1");
  if (!fs.existsSync(script)) return;
  try {
    spawn("powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
       "-File", script, "-Port", String(PORT)],
      { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch (error) {
    log(`watcher failed: ${error?.message ?? error}`);
  }
}

// --- 3. the page ------------------------------------------------------------

/**
 * The market catalog, held once in memory.
 *
 * It used to be a read-modify-write on market.json from several places: the
 * background thumbnail fetch after a load, and the on-demand fetch the page
 * triggers when it reveals more cards. Each held its own snapshot, so whichever
 * wrote last erased the other's progress and previews silently went missing
 * again. One array that every path mutates removes the race by construction.
 */
let marketCache = null;

function loadMarketCache() {
  if (marketCache) return marketCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(MARKET_FILE, "utf8"));
    marketCache = Array.isArray(parsed) ? parsed : [];
  } catch {
    marketCache = [];
  }
  return marketCache;
}

function saveMarketCache() {
  if (!marketCache) return;
  try {
    fs.mkdirSync(STATE_ROOT, { recursive: true });
    const target = MARKET_FILE;
    const temp = `${target}.tmp`;
    // Atomic: a reader never sees a half-written catalog.
    fs.writeFileSync(temp, JSON.stringify(marketCache), "utf8");
    fs.renameSync(temp, target);
  } catch (error) {
    log(`market save failed: ${error?.message ?? error}`);
  }
}

function buildState(statusOverride) {
  const status = statusOverride || control("status", [], 60000);
  if (!status || status.ok === false) {
    return { ok: false, error: status?.error || "status unavailable", themes: [] };
  }
  // `status` already counted the injectors; asking again with a second CIM
  // query cost another ~700 ms on every state build for nothing.
  const injectorCount = Number(status.injectorCount) || 0;
  const themes = Array.isArray(status.themes) ? status.themes : [];

  // `installed` is derived from the theme library on every read. The cached
  // catalog only says what was installed when the market was last loaded, so
  // trusting it left a just-installed theme still offering 「安装」.
  const installedIds = new Set(themes.map((t) => t.id));
  // One directory listing instead of 500 stats, and it keeps the catalog honest:
  // a preview recorded in market.json can still be gone (folder moved, previews
  // cleared). Handing the page a name for a missing file broke the grid and,
  // because the entry claimed a preview, stopped it from being re-requested.
  let previewFiles = null;
  try { previewFiles = new Set(fs.readdirSync(PREVIEW_DIR)); } catch {}
  const market = loadMarketCache().map((entry) => {
    const preview = entry.preview && (!previewFiles || previewFiles.has(entry.preview))
      ? entry.preview
      : "";
    return {
      ...entry,
      preview,
      installed: installedIds.has(entry.themeId),
    };
  });

  const snapshot = {
    paused: Boolean(status.paused),
    active: status.active || "",
    themes,
    codexRunning: Boolean(status.codexRunning),
    cdpUp: Boolean(status.cdpUp),
    injector: injectorCount > 0
      ? { count: injectorCount, fresh: Boolean(status.injectorFresh) }
      : null,
    market,
    at: Date.now(),
  };
  // The health pass reads this instead of querying again.
  lastStateSnapshot = snapshot;
  return snapshot;
}

function publish(payload) {
  try {
    fs.mkdirSync(PAGE_DIR, { recursive: true });
    const target = path.join(PAGE_DIR, "state.js");
    const temp = `${target}.tmp`;
    // `rev` lets the page tell "this is a new snapshot" from "the same one,
    // read again". Without it the page rebuilt every card every poll, which
    // threw away and re-created every <img> twice a second.
    const body = { ...payload, rev: ++publishRev };
    fs.writeFileSync(temp, `globalThis.__DREAM_SKIN_STATE__ = ${JSON.stringify(body)};\n`, "utf8");
    fs.renameSync(temp, target);   // atomic: the page never reads a half file
    return true;
  } catch (error) {
    log(`publish failed: ${error?.message ?? error}`);
    return false;
  }
}

function claimRequest(id, action) {
  const claimPath = path.join(CLAIM_DIR, `${id}.json`);
  try {
    fs.mkdirSync(CLAIM_DIR, { recursive: true });
    try {
      const existing = fs.statSync(claimPath);
      if (Date.now() - existing.mtimeMs < CLAIM_STALE_MS) return false;
      fs.rmSync(claimPath, { force: true });   // abandoned by a killed host
    } catch {}
    fs.writeFileSync(claimPath, JSON.stringify({ id, action, at: Date.now() }),
      { encoding: "utf8", flag: "wx" });
    const files = fs.readdirSync(CLAIM_DIR)
      .map((name) => ({ name, at: fs.statSync(path.join(CLAIM_DIR, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const stale of files.slice(30)) {
      try { fs.rmSync(path.join(CLAIM_DIR, stale.name), { force: true }); } catch {}
    }
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    return true;
  }
}

// The community market Codex++ itself uses. 863 themes at the time of writing;
// it is paginated and capped the way Codex++ caps it.
const COMMUNITY_API = "https://api.dreamskin.cc";
const MARKET_PAGE = 48;
const MARKET_LIMIT = 500;
const THUMBNAIL_BUDGET = 72;      // how many previews to fetch after a load
const THUMBNAIL_CONCURRENCY = 6;

async function fetchCatalog() {
  const items = [];
  let offset = 0;
  let total = Infinity;
  while (items.length < MARKET_LIMIT && offset < total) {
    const res = await fetch(
      `${COMMUNITY_API}/v1/themes?limit=${MARKET_PAGE}&offset=${offset}&sort=recent`,
      { signal: AbortSignal.timeout(20000) },
    );
    if (!res.ok) throw new Error(`catalog HTTP ${res.status}`);
    const page = await res.json();
    total = Number(page.total) || 0;
    const batch = Array.isArray(page.items) ? page.items : [];
    if (!batch.length) break;
    items.push(...batch);
    offset += batch.length;
  }
  return { total, items: items.slice(0, MARKET_LIMIT) };
}

function thumbnailName(themeId) {
  return `market-${themeId.replace(/[^a-z0-9_-]/gi, "_")}.jpg`;
}

/** Turn a catalog record into what the page needs, including a local preview. */
function toMarketEntry(item, localIds) {
  const thumb = thumbnailName(item.themeId || item.id);
  const hasThumb = fs.existsSync(path.join(PREVIEW_DIR, thumb));
  return {
    id: item.id,                     // version id — what /download wants
    themeId: item.themeId || "",
    name: item.name || item.themeId || item.id,
    version: item.version || "",
    author: item.authorDisplayName || "",
    downloads: Number(item.downloadCount) || 0,
    preview: hasThumb ? thumb : "",
    installed: localIds.has(item.themeId),
    appearance: "",
    taskMode: "",
  };
}

/**
 * Pull thumbnails for the themes the page will show first. The page cannot
 * fetch (connect-src 'none'), so the images have to be sitting in its folder
 * before it renders. Done in the background: state is republished as they
 * arrive so the grid fills in instead of waiting for the whole batch.
 */
/**
 * Download thumbnails for a list of market entries, filling `entry.preview` in
 * place. The page cannot fetch (connect-src 'none'), so every image it shows has
 * to be sitting in its own folder first.
 */
async function downloadThumbnails(queue) {
  let index = 0;
  let added = 0;
  const runner = async () => {
    while (index < queue.length) {
      const entry = queue[index++];
      try {
        const res = await fetch(
          `${COMMUNITY_API}/v1/themes/${entry.id}/preview/thumbnail`,
          { signal: AbortSignal.timeout(20000) },
        );
        if (!res.ok) continue;
        // A CDN error page is often well over 512 bytes, and writing one as a
        // .jpg would produce a corrupt preview that then "exists" forever — the
        // entry is only retried while it has no preview at all.
        const type = (res.headers.get("content-type") || "").toLowerCase();
        if (!type.startsWith("image/")) continue;
        const bytes = Buffer.from(await res.arrayBuffer());
        if (bytes.length < 512) continue;
        // JPEG magic: catches an HTML body served with an image content type.
        if (bytes[0] !== 0xFF || bytes[1] !== 0xD8 || bytes[2] !== 0xFF) continue;
        const name = thumbnailName(entry.themeId || entry.id);
        fs.mkdirSync(PREVIEW_DIR, { recursive: true });
        fs.writeFileSync(path.join(PREVIEW_DIR, name), bytes);
        entry.preview = name;
        added += 1;
      } catch {
        // a missing thumbnail is not worth failing anything over
      }
    }
  };
  await Promise.all(Array.from({ length: THUMBNAIL_CONCURRENCY }, runner));
  return added;
}

async function loadMarket() {
  try {
    const { total, items } = await fetchCatalog();
    const local = control("list", [], 60000);
    const localIds = new Set((local?.themes || []).map((t) => t.id));
    const entries = items.map((item) => toMarketEntry(item, localIds));

    // Serve the catalog immediately, previews still missing. Keep previously
    // downloaded thumbnails: a reload should not throw away what is on disk.
    const previous = new Map(loadMarketCache().map((e) => [String(e.id), e]));
    for (const entry of entries) {
      const before = previous.get(String(entry.id));
      if (before?.preview && fs.existsSync(path.join(PREVIEW_DIR, before.preview))) {
        entry.preview = before.preview;
      }
    }
    marketCache = entries;
    saveMarketCache();

    setTimeout(() => {
      downloadThumbnails(entries.filter((e) => !e.preview).slice(0, THUMBNAIL_BUDGET))
        .then((added) => {
          if (added > 0) {
            saveMarketCache();
            publish({ id: "", ok: true, message: "", state: buildState() });
            log(`market: ${added} thumbnails fetched`);
          }
        })
        .catch((error) => log(`thumbnails failed: ${error?.message ?? error}`));
    }, 0);

    return { ok: true, message: `市场共 ${total} 个主题，已载入 ${entries.length} 个` };
  } catch (error) {
    return { ok: false, error: `市场加载失败：${error?.message ?? error}` };
  }
}

/**
 * Fetch thumbnails for specific market entries — what the page asks for when
 * 「显示更多」 or a search reveals themes that were never on screen before.
 */
async function fetchThumbnailsFor(ids) {
  const wanted = new Set(Array.isArray(ids) ? ids.map(String) : []);
  if (!wanted.size) return { ok: false, error: "没有指定条目" };

  // Mutate the shared catalog, never a private copy: a snapshot would erase
  // whatever the background fetch had recorded in the meantime.
  const entries = loadMarketCache();
  if (!entries.length) return { ok: false, error: "市场目录尚未载入" };

  const queue = entries.filter((e) => wanted.has(String(e.id)) && !e.preview);
  if (!queue.length) return { ok: true, message: "预览已就绪" };

  const added = await downloadThumbnails(queue);
  saveMarketCache();
  log(`market: ${added}/${queue.length} requested thumbnails fetched`);
  return added > 0
    ? { ok: true, message: `已加载 ${added} 张预览` }
    : { ok: false, error: "预览图下载失败" };
}

async function installMarket(versionId) {
  if (!versionId) return { ok: false, error: "缺少主题版本 id" };
  const ticket = fs.mkdtempSync(path.join(os.tmpdir(), "dreamskin-"));
  try {
    // 1. Metadata, so the package can be verified against what was reviewed.
    const metaRes = await fetch(`${COMMUNITY_API}/v1/themes/${versionId}`,
      { signal: AbortSignal.timeout(20000) });
    if (!metaRes.ok) return { ok: false, error: `元数据请求失败：HTTP ${metaRes.status}` };
    const meta = await metaRes.json();
    if (meta.applyCompatible === false) {
      return { ok: false, error: "该主题是旧格式，只能在线预览" };
    }

    // 2. Package.
    const zipPath = path.join(ticket, "theme.zip");
    const pkgRes = await fetch(`${COMMUNITY_API}/v1/themes/${versionId}/download`,
      { signal: AbortSignal.timeout(120000) });
    if (!pkgRes.ok) return { ok: false, error: `下载失败：HTTP ${pkgRes.status}` };
    const bytes = Buffer.from(await pkgRes.arrayBuffer());
    fs.writeFileSync(zipPath, bytes);

    // 3. Same checks Codex++ makes before it trusts a package.
    if (Number.isFinite(meta.packageBytes) && bytes.length !== meta.packageBytes) {
      return { ok: false, error: `包大小不符（${bytes.length} ≠ ${meta.packageBytes}）` };
    }
    if (meta.packageSha256) {
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual.toLowerCase() !== String(meta.packageSha256).toLowerCase()) {
        return { ok: false, error: "包 SHA-256 与审核元数据不符" };
      }
    }

    // 4. Install and apply.
    const themeId = meta.themeId || versionId;
    const existing = control("list", [], 60000);
    if ((existing?.themes || []).some((t) => t.id === themeId)) {
      return { ok: false, error: `主题已存在：${themeId}（如需更新请先删除）` };
    }
    const installed = control("install", ["-ThemeId", themeId, "-SourceZip", zipPath], 180000);
    if (installed.ok === false) return { ok: false, error: installed.error || "安装失败" };

    const applied = control("switch", ["-ThemeId", themeId], 120000, true);
    control("refresh-previews", [], 120000);
    return applied.ok === false
      ? { ok: false, error: applied.error }
      : { ok: true, message: `已安装并应用 ${meta.name || themeId}`, status: applied.status };
  } catch (error) {
    return { ok: false, error: `${error?.message ?? error}` };
  } finally {
    try { fs.rmSync(ticket, { recursive: true, force: true }); } catch {}
  }
}

async function handle(request) {
  const action = request.action;
  const themeId = request.themeId;
  switch (action) {
    case "sync":
      return { ok: true, message: "" };
    case "switch": {
      if (!themeId) return { ok: false, error: "themeId is required" };
      const r = control("switch", ["-ThemeId", themeId], 120000, true);
      return r.ok === false ? { ok: false, error: r.error || "switch failed" }
        : { ok: true, message: `已切换到 ${themeId}`, status: r.status };
    }
    case "market-thumbs":
      return await fetchThumbnailsFor(request.ids);
    case "pause": {
      const r = control("pause", [], 120000, true);
      return r.ok === false ? { ok: false, error: r.error }
        : { ok: true, message: "已恢复 Codex 官方外观", status: r.status };
    }
    case "resume": {
      const r = control("resume", [], 120000, true);
      return r.ok === false ? { ok: false, error: r.error }
        : { ok: true, message: "皮肤已重新应用", status: r.status };
    }
    case "refresh": {
      const r = control("refresh-previews", [], 120000);
      return r.ok === false ? { ok: false, error: r.error }
        : { ok: true, message: `已刷新 ${r.generated ?? 0} 张预览` };
    }
    case "market-load":
      return await loadMarket();
    case "market-install":
      return await installMarket(themeId);   // themeId here is the version id
    default:
      return { ok: false, error: `unknown action: ${action}` };
  }
}

async function commandLoop() {
  if (busy) return;
  busy = true;
  try {
    const options = readOptions();
    const request = options.request;
    const id = request && typeof request === "object" ? String(request.id || "") : "";

    if (!id) {
      if (Date.now() - lastPublishAt >= STATE_REFRESH_MS) {
        lastPublishAt = Date.now();
        publish({ id: "", ok: true, message: "", state: buildState() });
      }
      return;
    }

    if (id === lastRequestId) return;
    if (!claimRequest(id, request.action)) return;

    lastRequestId = id;
    log(`request ${id}: ${request.action || "(none)"} ${request.themeId || ""}`);
    const outcome = await handle(request);
    lastPublishAt = Date.now();
    publish({
      id,
      ok: Boolean(outcome.ok),
      error: outcome.error || "",
      message: outcome.message || "",
      state: buildState(outcome.status),
    });
  } catch (error) {
    log(`command loop error: ${error?.message ?? error}`);
  } finally {
    busy = false;
  }
}

// --- single instance --------------------------------------------------------

function workerPidAlive(pid) {
  try {
    const out = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; if ($p -and $p.CommandLine -like '*worker.mjs*') { 'yes' } else { 'no' }`,
    ], { encoding: "utf8", timeout: 15000, windowsHide: true });
    return (out.stdout || "").trim() === "yes";
  } catch {
    return false;
  }
}

/**
 * Take the worker slot with an atomic exclusive create.
 *
 * The earlier version read the pid file and then wrote it, which is a race:
 * when several hosts start at the same instant they all read "nobody home"
 * before any of them writes the pid, and each starts its own worker. That is
 * how 27 stray workers piled up. `wx` makes the claim atomic, so exactly one
 * process wins and the rest exit.
 */
function claimWorkerSlot() {
  const selfRoot = path.resolve(ROOT).toLowerCase();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(STATE_ROOT, { recursive: true });
      const fd = fs.openSync(PID_FILE, "wx");
      try {
        // The root goes in the lock so a worker from a previous install can be
        // recognised: it would keep publishing state.js into the folder it was
        // started from, and the page in the new folder would stay empty forever.
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), root: ROOT }));
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") return false;

      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(PID_FILE, "utf8")); } catch {}
      if (holder && Number.isInteger(holder.pid)) {
        if (holder.pid === process.pid) return true;
        if (workerPidAlive(holder.pid)) {
          const holderRoot = holder.root ? path.resolve(holder.root).toLowerCase() : null;
          if (holderRoot && holderRoot !== selfRoot) {
            log(`retiring worker ${holder.pid}: it serves ${holder.root}, this instance is ${ROOT}`);
            try { process.kill(holder.pid); } catch {}
            try { fs.rmSync(PID_FILE, { force: true }); } catch {}
            continue;
          }
          return false;   // a real worker owns this plugin
        }
      }
      // The holder is gone; clear the stale file and try once more.
      try { fs.rmSync(PID_FILE, { force: true }); } catch {}
    }
  }
  return false;
}

function releaseWorkerSlot() {
  try {
    const info = JSON.parse(fs.readFileSync(PID_FILE, "utf8"));
    if (info?.pid !== process.pid) return;
    fs.rmSync(PID_FILE, { force: true });
  } catch {}
  // Drop the liveness marker too, so a clean exit does not read as "two workers
  // are running" for the next minute while the file ages out.
  try { fs.rmSync(path.join(WORKER_DIR, `${process.pid}.json`), { force: true }); } catch {}
}

/**
 * Keep the lock file's mtime fresh. index.mjs reads that as proof of life and
 * skips its PowerShell lookup — which otherwise ran on every plugin-host reload,
 * i.e. on every click in the page, for one to two seconds.
 *
 * The same heartbeat drops a marker per worker process, so the health check can
 * count live workers by listing a directory instead of running a CIM query.
 */
function touchWorkerSlot() {
  try {
    const info = JSON.parse(fs.readFileSync(PID_FILE, "utf8"));
    if (info?.pid !== process.pid) return;   // someone else owns the slot now
    const now = new Date();
    fs.utimesSync(PID_FILE, now, now);
  } catch {}

  try {
    fs.mkdirSync(WORKER_DIR, { recursive: true });
    const marker = path.join(WORKER_DIR, `${process.pid}.json`);
    if (!fs.existsSync(marker)) {
      fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, root: ROOT }), "utf8");
    }
    const now = new Date();
    fs.utimesSync(marker, now, now);
  } catch {}
}

/** Remove markers of workers that stopped beating; return how many are left. */
function pruneWorkerMarkers() {
  let live = 0;
  try {
    for (const name of fs.readdirSync(WORKER_DIR)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(WORKER_DIR, name);
      let age = Infinity;
      try { age = Date.now() - fs.statSync(file).mtimeMs; } catch {}
      if (age > WORKER_FRESH_MS) {
        try { fs.rmSync(file, { force: true }); } catch {}
      } else {
        live += 1;
      }
    }
  } catch {}
  return live;
}

// --- main -------------------------------------------------------------------

if (!claimWorkerSlot()) {
  // A live worker already owns this plugin; this spawn is redundant.
  process.exit(0);
}
process.on("exit", releaseWorkerSlot);

log(`worker started (pid ${process.pid})`);

pruneInjectorArchives();
syncEngine();
bootstrap();
pruneIfDue();
supervise();
startWatcher();

// These timers are the worker's reason to exist, so they are deliberately NOT
// unref'd: an unref'd timer would let the process exit right after startup.
setInterval(() => { supervise(); }, SUPERVISE_MS);
setInterval(() => { commandLoop(); }, COMMAND_POLL_MS);
setInterval(() => { pruneIfDue(); }, 30 * 60 * 1000);
setInterval(() => { touchWorkerSlot(); }, HEARTBEAT_MS);
setInterval(() => { healthTick(); }, HEALTH_INTERVAL_MS);

const initialState = buildState();
publish({ id: "", ok: true, message: "", state: initialState });
lastPublishAt = Date.now();
// Housekeeping that needs to know which themes exist right now.
pruneOrphanPreviews(initialState.themes);
ensurePreviews(initialState.themes);
// Say hello with a baseline, so the first real problem has something to differ
// against — and so the log shows the check is actually running.
touchWorkerSlot();
healthTick();

log("worker ready");
