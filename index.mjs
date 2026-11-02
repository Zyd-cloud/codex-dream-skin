// Codex Dream Skin — magpie plugin entry.
//
// magpie tears this host down and re-creates it every time the plugin's options
// are written, which is exactly how the page asks for something. So the entry
// does almost nothing: it makes sure the detached worker is running and returns.
// All long-lived work (bootstrap, injector supervision, command handling) lives
// in worker.mjs, where a host restart cannot interrupt it.
//
// This mirrors how magpie-ssh-remote is built: `index.mjs` spawns a detached
// helper and returns `{}`.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(ROOT, "worker.mjs");
// LOCALAPPDATA first, to agree with worker.mjs: deriving this from homedir()
// disagreed under a redirected environment, and the two then looked at
// different lock files.
const STATE_ROOT =
  process.env.CODEX_DREAM_SKIN_ROOT
  || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "CodexDreamSkin");
const PID_FILE = path.join(STATE_ROOT, "worker.pid");
const LOG_FILE = path.join(STATE_ROOT, "plugin-autostart.log");
const PLUGINS_JSON = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
  "magpie",
  "plugins.json",
);

// The worker touches worker.pid every 10 s. A lock file younger than this counts
// as proof of life, so the common path costs a stat instead of a PowerShell run.
const HEARTBEAT_FRESH_MS = 30_000;

function log(message) {
  try {
    fs.mkdirSync(STATE_ROOT, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`);
  } catch {}
}

/** True when a live worker already owns the plugin. */
function workerIsRunning() {
  try {
    const info = JSON.parse(fs.readFileSync(PID_FILE, "utf8"));
    if (!info || !Number.isInteger(info.pid)) return false;

    try {
      if (Date.now() - fs.statSync(PID_FILE).mtimeMs < HEARTBEAT_FRESH_MS) return true;
    } catch {}

    const out = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${info.pid}" -ErrorAction SilentlyContinue; if ($p -and $p.CommandLine -like '*worker.mjs*') { 'yes' } else { 'no' }`,
    ], { encoding: "utf8", timeout: 15000, windowsHide: true });
    return (out.stdout || "").trim() === "yes";
  } catch {
    return false;
  }
}

function startWorker() {
  if (!fs.existsSync(WORKER)) {
    log("worker.mjs is missing; nothing to start");
    return;
  }
  try {
    const child = spawn(process.execPath, [WORKER], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, CODEX_DREAM_SKIN_WORKER: "1" },
    });
    child.unref();
    log(`spawned worker (${process.execPath})`);
  } catch (error) {
    log(`failed to spawn worker: ${error?.message ?? error}`);
  }
}

/**
 * magpie spins up a throwaway host under %TEMP%\magpie-preview-* to look at a
 * plugin before loading it for real. Those run with a redirected environment, so
 * anything they derive from the user profile is wrong — `worker.mjs` decided its
 * state root that way and reported "missing helper" while the file was right
 * there. A preview is also not a place to start a long-lived worker: 27 of them
 * once left 27 stray workers behind. The real host starts the worker.
 */
function isPreviewHost() {
  return /magpie-preview-/i.test(process.execPath || "")
    || /magpie-preview-/i.test(process.env.MAGPIE_PLUGIN_HOST || "")
    || /magpie-preview-/i.test(process.cwd() || "");
}

/**
 * Is this folder the copy magpie actually has installed?
 *
 * After `plugin add <other path>` the old folder stays on disk, and any host
 * still holding it would spawn a worker for a plugin that is no longer the
 * active one — that worker then won the lock and kept serving the stale copy.
 * One read of plugins.json settles it.
 */
function isActiveInstall() {
  try {
    const doc = JSON.parse(fs.readFileSync(PLUGINS_JSON, "utf8"));
    const list = Array.isArray(doc.plugins) ? doc.plugins : [];
    const self = path.resolve(ROOT).toLowerCase();
    return list.some((p) => {
      if (!p || typeof p.spec !== "string") return false;
      try { return path.resolve(p.spec).toLowerCase() === self; } catch { return false; }
    });
  } catch {
    // Unreadable config: better to start a worker than to leave the page dead.
    return true;
  }
}

export default async function CodexDreamSkinPlugin() {
  if (isPreviewHost()) {
    log("preview host: not starting a worker");
    return {};
  }
  if (!isActiveInstall()) {
    log(`stale copy at ${ROOT}: not the installed plugin, not starting a worker`);
    return {};
  }
  if (!workerIsRunning()) startWorker();
  return {};
}
