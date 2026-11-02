import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readImageMetadata } from "./image-metadata.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const here = path.dirname(scriptPath);
const root = path.resolve(here, "..");
const SKIN_VERSION = "1.2.0";
const MAX_ART_BYTES = 16 * 1024 * 1024;
const STRONG_THEME_AUDIT_MS = 30000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const BROWSER_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

class CdpIdentityMismatchError extends Error {}

function parseArgs(argv) {
  const options = {
    port: 9335,
    mode: "watch",
    timeoutMs: 30000,
    screenshot: null,
    reload: false,
    browserId: null,
    themeDir: path.join(root, "assets"),
    pauseFile: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port") options.port = Number(argv[++i]);
    else if (arg === "--once") options.mode = "once";
    else if (arg === "--watch") options.mode = "watch";
    else if (arg === "--verify") options.mode = "verify";
    else if (arg === "--remove") options.mode = "remove";
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++i]);
    else if (arg === "--browser-id") options.browserId = argv[++i];
    else if (arg === "--theme-dir") options.themeDir = path.resolve(argv[++i]);
    else if (arg === "--pause-file") options.pauseFile = path.resolve(argv[++i]);
    else if (arg === "--screenshot") options.screenshot = path.resolve(argv[++i]);
    else if (arg === "--reload") options.reload = true;
    else if (arg === "--self-test") options.mode = "self-test";
    else if (arg === "--check-payload") options.mode = "check-payload";
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) {
    throw new Error(`Invalid port: ${options.port}`);
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 250 || options.timeoutMs > 120000) {
    throw new Error(`Invalid timeout: ${options.timeoutMs}`);
  }
  if (options.browserId !== null && !BROWSER_ID_PATTERN.test(options.browserId)) {
    throw new Error(`Invalid browser ID: ${options.browserId}`);
  }
  if (["watch", "once", "verify", "remove"].includes(options.mode) && !options.browserId) {
    throw new Error(`--browser-id is required in ${options.mode} mode`);
  }
  return options;
}

function validatedDebuggerUrl(target, port) {
  const url = new URL(target.webSocketDebuggerUrl);
  const pathIsValid = /^\/devtools\/(?:page|browser)\/[A-Za-z0-9._-]{1,200}$/.test(url.pathname);
  if (url.protocol !== "ws:" || !LOOPBACK_HOSTS.has(url.hostname) || Number(url.port) !== port ||
      url.username || url.password || url.search || url.hash || !pathIsValid) {
    throw new Error("Rejected a CDP WebSocket URL outside the allowed loopback endpoint shape");
  }
  return url.href;
}

function parseCdpMessage(data) {
  try {
    const message = JSON.parse(String(data));
    return message && typeof message === "object" ? message : null;
  } catch {
    return null;
  }
}

function browserIdFromVersion(version, port) {
  const url = validatedDebuggerUrl(version, port);
  const parsed = new URL(url);
  const match = parsed.pathname.match(/^\/devtools\/browser\/([A-Za-z0-9._-]{1,200})$/);
  if (!match || parsed.search || parsed.hash || !BROWSER_ID_PATTERN.test(match[1])) {
    throw new Error("Rejected an invalid CDP browser identity URL");
  }
  return match[1];
}

function isValidCdpPageTarget(item, port) {
  if (item?.type !== "page" || !item.url?.startsWith("app://") || typeof item.id !== "string" ||
      !BROWSER_ID_PATTERN.test(item.id) || !item.webSocketDebuggerUrl) return false;
  try {
    const debuggerUrl = new URL(validatedDebuggerUrl(item, port));
    return debuggerUrl.pathname === `/devtools/page/${item.id}`;
  } catch {
    return false;
  }
}

class CdpSession {
  constructor(target, port) {
    this.target = target;
    this.ws = new WebSocket(validatedDebuggerUrl(target, port));
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
  }

  async open() {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        try { this.ws.close(); } catch {}
        reject(new Error("CDP WebSocket open timed out"));
      }, 5000);
      this.ws.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
      this.ws.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("CDP WebSocket open failed")); }, { once: true });
    });
    this.ws.addEventListener("message", (event) => this.onMessage(event));
    this.ws.addEventListener("error", () => this.close());
    this.ws.addEventListener("close", () => {
      this.closed = true;
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timeout);
        waiter.reject(new Error("CDP socket closed"));
      }
      this.pending.clear();
    });
    await this.send("Runtime.enable");
    await this.send("Page.enable");
    return this;
  }

  onMessage(event) {
    const message = parseCdpMessage(event.data);
    if (!message) {
      this.close();
      return;
    }
    if (message.id) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      clearTimeout(waiter.timeout);
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`${message.error.message} (${message.error.code})`));
      else waiter.resolve(message.result);
      return;
    }
    for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {});
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("CDP session is closed"));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, 10000);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: false,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`Renderer evaluation failed: ${detail}`);
    }
    return result.result?.value;
  }

  close() {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("CDP session closed"));
    }
    this.pending.clear();
    if (!this.closed) {
      try { this.ws.close(); } catch {}
    }
    this.closed = true;
  }
}

class BrowserIdentityAnchor {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.closed = false;
    this.ws.addEventListener("close", () => { this.closed = true; });
    this.ws.addEventListener("error", () => {
      this.closed = true;
      try { this.ws.close(); } catch {}
    });
  }

  async open() {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.close();
        reject(new Error("CDP browser identity WebSocket open timed out"));
      }, 5000);
      this.ws.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
      this.ws.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("CDP browser identity WebSocket open failed"));
      }, { once: true });
      this.ws.addEventListener("close", () => {
        clearTimeout(timeout);
        reject(new Error("CDP browser identity WebSocket closed during startup"));
      }, { once: true });
    });
    if (this.closed) throw new Error("CDP browser identity WebSocket is already closed");
    return this;
  }

  close() {
    if (!this.closed) {
      try { this.ws.close(); } catch {}
    }
    this.closed = true;
  }
}

async function fetchCdpJson(port, resource) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${resource}`, {
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function listAppTargets(port, expectedBrowserId = null) {
  const targets = await fetchCdpJson(port, "/json/list");
  if (!Array.isArray(targets)) throw new Error("CDP target list is not an array");
  if (expectedBrowserId) {
    const version = await fetchCdpJson(port, "/json/version");
    const actualBrowserId = browserIdFromVersion(version, port);
    if (actualBrowserId !== expectedBrowserId) {
      throw new CdpIdentityMismatchError(
        `CDP browser identity changed from ${expectedBrowserId} to ${actualBrowserId}`,
      );
    }
  }
  return targets.filter((item) => isValidCdpPageTarget(item, port));
}

async function connectBrowserIdentityAnchor(port, expectedBrowserId) {
  const version = await fetchCdpJson(port, "/json/version");
  const actualBrowserId = browserIdFromVersion(version, port);
  if (actualBrowserId !== expectedBrowserId) {
    throw new CdpIdentityMismatchError(
      `CDP browser identity changed from ${expectedBrowserId} to ${actualBrowserId}`,
    );
  }
  return new BrowserIdentityAnchor(validatedDebuggerUrl(version, port)).open();
}

const THEME_CHOICES = {
  appearance: new Set(["auto", "light", "dark"]),
  safeArea: new Set(["left", "right", "none"]),
  taskMode: new Set(["ambient", "full", "off"]),
};

function normalizedUnit(value, name) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new Error(`${name} must be null or a number between 0 and 1`);
  }
  return number;
}

function normalizedChoice(value, name, choices, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  if (!choices.has(value)) throw new Error(`${name} has an unsupported value: ${value}`);
  return value;
}

function normalizedText(value, name, fallback, maxLength = 120) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value !== "string" || value.length > maxLength || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`${name} must be a short single-line string`);
  }
  return value;
}

async function loadTheme(themeDir) {
  const realThemeDir = await fs.realpath(themeDir);
  const themePath = path.join(realThemeDir, "theme.json");
  const themeText = await fs.readFile(themePath, "utf8");
  const raw = JSON.parse(themeText);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Theme root must be an object");
  }
  const image = normalizedText(raw.image, "image", null, 240);
  if (!image || path.isAbsolute(image)) throw new Error("Theme image must be a relative path");
  const imagePath = path.resolve(realThemeDir, image);
  const relativeImage = path.relative(realThemeDir, imagePath);
  if (!relativeImage || relativeImage.startsWith("..") || path.isAbsolute(relativeImage)) {
    throw new Error("Theme image must remain inside the selected theme directory");
  }
  const extension = path.extname(imagePath).toLowerCase();
  if (![".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
    throw new Error(`Unsupported theme image format: ${extension || "missing"}`);
  }
  const realImagePath = await fs.realpath(imagePath);
  const realRelativeImage = path.relative(realThemeDir, realImagePath);
  if (!realRelativeImage || realRelativeImage.startsWith("..") || path.isAbsolute(realRelativeImage)) {
    throw new Error("Theme image cannot escape through a link or junction");
  }
  const art = raw.art && typeof raw.art === "object" && !Array.isArray(raw.art) ? raw.art : {};
  const palette = raw.palette && typeof raw.palette === "object" && !Array.isArray(raw.palette)
    ? raw.palette : {};
  // Themes authored for the Codex++ DreamSkin format carry a full 10-colour
  // palette. Keep it so the renderer can drive every --dream-* surface from
  // the theme instead of falling back to the engine's generic blue-dark set.
  const rawColors = raw.colors && typeof raw.colors === "object" && !Array.isArray(raw.colors)
    ? raw.colors
    : {};
  const theme = {
    id: normalizedText(raw.id, "id", "custom", 80),
    name: normalizedText(raw.name, "name", "Codex Dream Skin", 120),
    image,
    appearance: normalizedChoice(raw.appearance, "appearance", THEME_CHOICES.appearance, "auto"),
    art: {
      focusX: normalizedUnit(art.focusX, "art.focusX"),
      focusY: normalizedUnit(art.focusY, "art.focusY"),
      safeArea: normalizedChoice(art.safeArea, "art.safeArea", THEME_CHOICES.safeArea, "auto"),
      taskMode: normalizedChoice(art.taskMode, "art.taskMode", THEME_CHOICES.taskMode, "auto"),
    },
    palette: {},
  };
  if (typeof palette.accent === "string" && palette.accent.trim()) {
    const accent = palette.accent.trim();
    if (!/^(?:#[\da-f]{3,8}|(?:rgba?|hsla?|oklch|oklab)\([^;{}]{1,96}\))$/i.test(accent)) {
      throw new Error("palette.accent is not a supported CSS color");
    }
    theme.palette.accent = accent;
  }
  const colors = {};
  for (const [key, value] of Object.entries(rawColors)) {
    if (typeof value !== "string" || !value.trim()) continue;
    const color = value.trim();
    if (!/^(?:#[\da-f]{3,8}|(?:rgba?|hsla?|oklch|oklab)\([^;{}]{1,96}\))$/i.test(color)) {
      throw new Error(`colors.${key} is not a supported CSS color`);
    }
    colors[key] = color;
  }
  if (Object.keys(colors).length > 0) theme.colors = colors;
  const [themeStat, imageStat] = await Promise.all([fs.stat(themePath), fs.stat(realImagePath)]);
  if (!imageStat.isFile()) throw new Error("Theme image is not a file");
  if (imageStat.size < 1) throw new Error("Theme image cannot be empty");
  if (imageStat.size > MAX_ART_BYTES) {
    throw new Error(`Theme image exceeds the ${MAX_ART_BYTES / 1024 / 1024} MB limit`);
  }
  const imageBytes = await fs.readFile(realImagePath);
  if (imageBytes.length < 1 || imageBytes.length > MAX_ART_BYTES) {
    throw new Error(`Theme image must be between 1 byte and ${MAX_ART_BYTES / 1024 / 1024} MB`);
  }
  const artMetadata = readImageMetadata(imageBytes, extension);
  if (!artMetadata) {
    throw new Error("Theme image metadata is invalid or exceeds the 16384px / 50MP safety limit");
  }
  theme.artMetadata = artMetadata;
  const fingerprint = createHash("sha256")
    .update(themeText, "utf8")
    .update("\0")
    .update(imageBytes)
    .digest("hex");
  return {
    theme,
    themePath,
    imagePath: realImagePath,
    imageBytes,
    fingerprint,
    sourceStamp: `${themeStat.size}:${themeStat.mtimeMs}:${imageStat.size}:${imageStat.mtimeMs}`,
  };
}

async function loadPayload(themeDir = path.join(root, "assets"), candidateTheme = null) {
  const loadedTheme = candidateTheme ?? await loadTheme(themeDir);
  const assetsDir = path.join(root, "assets");
  const [baseCss, template, nativeShellCss, communityCompatCss] = await Promise.all([
    fs.readFile(path.join(assetsDir, "dream-skin.css"), "utf8"),
    fs.readFile(path.join(assetsDir, "renderer-inject.js"), "utf8"),
    fs.readFile(path.join(assetsDir, "dream-skin-native-shell-compat.css"), "utf8")
      .catch(() => ""),
    fs.readFile(path.join(assetsDir, "dream-skin-community-compat.css"), "utf8")
      .catch(() => ""),
  ]);
  // Codex++ only compiles a theme's Safe CSS when `current.css` sits next to
  // the ACTIVE image (dream-skin/theme/current.css). It never reads the copy in
  // the theme library. Mirror that exactly so the two renderers agree.
  let themeCss = "";
  try {
    themeCss = await fs.readFile(
      path.join(path.dirname(loadedTheme.imagePath), "current.css"),
      "utf8",
    );
  } catch {
    themeCss = "";
  }
  let managedCss = "";
  if (themeCss.trim()) {
    try {
      const { compileSafeCss } = await import(
        pathToFileURL(path.join(assetsDir, "safe-css.js")).href
      );
      managedCss = `${compileSafeCss(themeCss)}\n${communityCompatCss}`;
    } catch (error) {
      console.error(`[dream-skin] theme.css rejected: ${error.message}`);
      managedCss = "";
    }
  }
  const css = `${baseCss}\n${nativeShellCss}\n${managedCss}`;
  const extension = path.extname(loadedTheme.imagePath).toLowerCase();
  const mime = extension === ".jpg" || extension === ".jpeg" ? "image/jpeg"
    : extension === ".webp" ? "image/webp" : "image/png";
  const artDataUrl = `data:${mime};base64,${loadedTheme.imageBytes.toString("base64")}`;
  const themeJson = JSON.stringify(loadedTheme.theme);

  const styleRevision = createHash("sha256").update(css, "utf8").digest("hex");
  const payloadRevision = createHash("sha256")
    .update(`windows:${styleRevision}:${loadedTheme.fingerprint}:${themeJson}`, "utf8")
    .digest("hex");

  // Rust's str::replace replaces every occurrence; JS with a string pattern
  // only replaces the first, so substitute globally.
  const substitute = (text, token, value) => text.split(token).join(value);
  let payload = template
    .replace("__DREAM_CSS_JSON__", JSON.stringify(css))
    .replace("__DREAM_ART_JSON__", "window.__CODEX_PLUS_DREAM_SKIN_ART__")
    .replace("__DREAM_THEME_JSON__", "window.__CODEX_PLUS_DREAM_SKIN_THEME__")
    .replace("__DREAM_VERSION_JSON__", JSON.stringify("2.1.0-snow.1"))
    .replace("__GLASS_VISION_CSS_JSON__", JSON.stringify(css))
    .replace("__GLASS_VISION_ART_JSON__", "window.__CODEX_PLUS_DREAM_SKIN_ART__")
    .replace("__DREAM_SKIN_CSS_JSON__", JSON.stringify(css))
    .replace("__DREAM_SKIN_ART_JSON__", "window.__CODEX_PLUS_DREAM_SKIN_ART__")
    .replace("__DREAM_SKIN_THEME_JSON__", "window.__CODEX_PLUS_DREAM_SKIN_THEME__")
    .replace("__DREAM_SKIN_VERSION_JSON__", JSON.stringify("1.5.20"))
    .replace("__DREAM_SKIN_STYLE_REVISION_JSON__", JSON.stringify(styleRevision))
    .replace("__DREAM_SKIN_PAYLOAD_REVISION_JSON__", JSON.stringify(payloadRevision));
  for (const token of ["__DREAM_", "__GLASS_VISION_"]) {
    if (payload.includes(token)) {
      throw new Error(`dream skin renderer contains unresolved placeholder: ${token}`);
    }
  }

  const artAssignment = `window.__CODEX_PLUS_DREAM_SKIN_ART__ = ${JSON.stringify(artDataUrl)};\n`;
  const skinApiBootstrap = `(() => {
  const theme = ${themeJson};
  const root = document.documentElement;
  const colors = theme && typeof theme.colors === "object" ? theme.colors : {};
  const variables = {
    "--ds-theme-color-background": colors.background,
    "--ds-theme-color-panel": colors.panel,
    "--ds-theme-color-panel-alt": colors.panelAlt,
    "--ds-theme-color-accent": colors.accent,
    "--ds-theme-color-accent-alt": colors.accentAlt,
    "--ds-theme-color-secondary": colors.secondary,
    "--ds-theme-color-highlight": colors.highlight,
    "--ds-theme-color-text": colors.text,
    "--ds-theme-color-muted": colors.muted,
    "--ds-theme-color-line": colors.line,
    "--ds-theme-image-focus-x": String(theme?.art?.focusX ?? 0.5),
    "--ds-theme-image-focus-y": String(theme?.art?.focusY ?? 0.5),
  };
  for (const [name, value] of Object.entries(variables)) if (typeof value === "string" && value) root.style.setProperty(name, value);
  const map = {
    root: "html", sidebar: "aside.app-shell-left-panel", main: "main.main-surface",
    header: "header.app-header-tint", home: ".dream-skin-home, [data-feature='game-source']",
    "home-hero": ".dream-skin-home > div:first-child, [data-feature='game-source']",
    "project-list": "[data-feature='game-source']", thread: "main.main-surface [role='main']",
    message: "main.main-surface article", composer: ".composer-surface-chrome",
    "composer-toolbar": ".composer-surface-chrome [role='toolbar']", dialog: "[role='dialog']",
  };
  const mark = () => {
    for (const [part, selector] of Object.entries(map)) for (const node of document.querySelectorAll(selector)) {
      if (node.getAttribute("data-ds-part") !== part) node.setAttribute("data-ds-part", part);
    }
  };
  mark();
  window.__CODEX_PLUS_DREAM_SKIN_API_OBSERVER__?.disconnect?.();
  let markTimer = null;
  const scheduleMark = () => {
    if (markTimer !== null) return;
    markTimer = setTimeout(() => {
      markTimer = null;
      mark();
    }, 250);
  };
  const observer = new MutationObserver((records) => {
    if (records.every((record) =>
      [...record.addedNodes].every((node) => node.nodeType === 3)
      && [...record.removedNodes].every((node) => node.nodeType === 3))) return;
    scheduleMark();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.__CODEX_PLUS_DREAM_SKIN_API_OBSERVER__ = observer;
})();`;

  payload = `(() => {
window.__CODEX_PLUS_EXTERNAL_DREAM_SKIN_RUNTIME__ = true;
window.__CODEX_PLUS_CLEAR_DREAM_SKIN__?.();
${artAssignment}window.__CODEX_PLUS_DREAM_SKIN_ART_SIGNATURE__ = ${JSON.stringify(loadedTheme.fingerprint)};
window.__CODEX_PLUS_DREAM_SKIN_THEME__ = ${themeJson};
window.__CODEX_PLUS_DREAM_SKIN_RUNTIME_REVISION__ = ${JSON.stringify("27-dream-skin-1.5.20-wallpaper-shell")};
window.__CODEX_PLUS_DREAM_SKIN_TARGET_ENGINE__ = ${JSON.stringify("windows")};
${skinApiBootstrap}
const result = ${payload};
const state = window.__CODEX_DREAM_SKIN_STATE__ || window.__CODEX_GLASS_VISION_SKIN_STATE__;
if (state) {
  state.version = \`codex-plus:\${String(window.__CODEX_PLUS_DREAM_SKIN_PLATFORM__ || 'unknown')}:\${window.__CODEX_PLUS_DREAM_SKIN_TARGET_ENGINE__}:r\${window.__CODEX_PLUS_DREAM_SKIN_RUNTIME_REVISION__}\`;
}
window.__CODEX_PLUS_DREAM_SKIN_PAYLOAD_SIGNATURE__ = ${JSON.stringify(payloadRevision)};
return result;
})()`;
  const { imageBytes: _imageBytes, ...themeState } = loadedTheme;
  return { ...themeState, payload };
}

async function fileExists(filePath) {
  if (!filePath) return false;
  try {
    return (await fs.stat(filePath)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readThemeSourceStamp(loadedTheme) {
  const [themeStat, imageStat] = await Promise.all([
    fs.stat(loadedTheme.themePath),
    fs.stat(loadedTheme.imagePath),
  ]);
  return `${themeStat.size}:${themeStat.mtimeMs}:${imageStat.size}:${imageStat.mtimeMs}`;
}

async function probeSession(session) {
  return session.evaluate(`(() => {
    const markers = {
      shell: Boolean(document.querySelector('main.main-surface') || document.querySelector('main')),
      sidebar: Boolean(document.querySelector('aside.app-shell-left-panel') || document.querySelector('aside')),
      composer: Boolean(document.querySelector('.composer-surface-chrome') || document.querySelector('[class*="composer"]')),
      main: Boolean(document.querySelector('[role="main"]')),
    };
    // A document that is still parsing is not safe to inject into: the early
    // payload registers a new-document script and evaluates immediately, which
    // can take a half-built renderer down. Electron then respawns it and the
    // window appears to flash closed and open.
    const ready = document.readyState === 'complete';
    return {
      markers,
      ready,
      codex: location.protocol === 'app:' && ready && markers.shell && markers.sidebar && (markers.composer || markers.main),
    };
  })()`);
}

async function waitForCodexProbe(session, timeoutMs = 1800) {
  const deadline = Date.now() + timeoutMs;
  let probe = null;
  while (Date.now() < deadline) {
    try {
      probe = await probeSession(session);
      if (probe?.codex) return probe;
    } catch {
      // The renderer may be between documents while the early payload waits.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return probe;
}

async function connectTarget(target, port) {
  return new CdpSession(target, port).open();
}

async function connectCodexTargets(port, timeoutMs, expectedBrowserId) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const targets = await listAppTargets(port, expectedBrowserId);
      const connected = [];
      for (const target of targets) {
        let session;
        try {
          session = await connectTarget(target, port);
          const probe = await probeSession(session);
          if (probe?.codex) connected.push({ target, session, probe });
          else session.close();
        } catch (error) {
          session?.close();
          lastError = error;
        }
      }
      if (connected.length) return connected;
      lastError = new Error("No page matched the expected Codex shell markers");
    } catch (error) {
      if (error instanceof CdpIdentityMismatchError) throw error;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new Error(`No verified Codex renderer on 127.0.0.1:${port}: ${lastError?.message ?? "timed out"}`);
}

async function applyToSession(session, payload) {
  return session.evaluate(payload);
}

export function earlyPayloadFor(payload, revision) {
  return `(() => {
    const generationKey = "__CODEX_DREAM_SKIN_EARLY_GENERATION__";
    const appliedKey = "__CODEX_DREAM_SKIN_EARLY_APPLIED__";
    const generation = ${JSON.stringify(revision)};
    window[generationKey] = generation;
    let observer = null;
    let timeout = null;
    const stop = () => {
      observer?.disconnect();
      observer = null;
      if (timeout) clearTimeout(timeout);
      timeout = null;
    };
    const install = () => {
      if (window[generationKey] !== generation) { stop(); return true; }
      const root = document.documentElement;
      if (!root || !document.body) return false;
      const shell = document.querySelector('main.main-surface') || document.querySelector('main');
      const sidebar = document.querySelector('aside.app-shell-left-panel') || document.querySelector('aside');
      if (!shell || !sidebar) return false;
      stop();
      ${payload};
      window[appliedKey] = generation;
      return true;
    };
    if (install()) return;
    if (typeof MutationObserver === "function" && document.documentElement) {
      observer = new MutationObserver(install);
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    timeout = setTimeout(stop, 10000);
  })()`;
}

async function registerEarlyPayload(session, payload, revision) {
  const result = await session.send("Page.addScriptToEvaluateOnNewDocument", {
    source: earlyPayloadFor(payload, revision),
  });
  return result.identifier ?? null;
}

async function removeEarlyPayload(session, identifier) {
  if (!identifier || session.closed) return;
  await session.send("Page.removeScriptToEvaluateOnNewDocument", { identifier }).catch(() => {});
}

async function removeFromSession(session) {
  return session.evaluate(`(() => {
    window.__CODEX_DREAM_SKIN_DISABLED__ = true;
    const state = window.__CODEX_DREAM_SKIN_STATE__;
    if (state?.cleanup) return state.cleanup();
    const root = document.documentElement;
    for (const attribute of [
      'data-dream-skin', 'data-dream-shell', 'data-dream-upload-alpha',
      'data-dream-art-wide', 'data-dream-art-safe', 'data-dream-task-mode',
      'data-dream-art-safe-area', 'data-dream-art-task-mode',
      'data-dream-art-aspect', 'data-dream-art-ready',
    ]) root?.removeAttribute(attribute);
    root?.classList.remove(
      'codex-dream-skin', 'dream-theme-light', 'dream-theme-dark',
      'dream-art-wide', 'dream-art-standard', 'dream-focus-left',
      'dream-focus-center', 'dream-focus-right', 'dream-safe-left',
      'dream-safe-center', 'dream-safe-right', 'dream-safe-none',
      'dream-task-ambient', 'dream-task-banner', 'dream-task-off'
    );
    for (const property of [
      '--dream-art', '--dream-art-position', '--dream-focus-x', '--dream-focus-y',
      '--dream-accent', '--dream-accent-ink', '--dream-image-luma',
      '--ds-theme-color-background', '--ds-theme-color-panel',
      '--ds-theme-color-panel-alt', '--ds-theme-color-accent',
      '--ds-theme-color-accent-alt', '--ds-theme-color-secondary',
      '--ds-theme-color-highlight', '--ds-theme-color-text',
      '--ds-theme-color-muted', '--ds-theme-color-line',
      '--ds-theme-image-focus-x', '--ds-theme-image-focus-y',
    ]) root?.style.removeProperty(property);
    document.querySelectorAll('[data-ds-part]').forEach((node) => node.removeAttribute('data-ds-part'));
    document.querySelectorAll('.dream-home').forEach((node) => node.classList.remove('dream-home'));
    document.querySelectorAll('.dream-task').forEach((node) => node.classList.remove('dream-task'));
    document.querySelectorAll('.dream-home-shell').forEach((node) => node.classList.remove('dream-home-shell'));
    document.querySelectorAll('.main-surface').forEach((node) => node.classList.remove('main-surface'));
    document.getElementById('codex-dream-skin-style')?.remove();
    document.getElementById('codex-dream-skin-chrome')?.remove();
    delete window.__CODEX_DREAM_SKIN_STATE__;
    return true;
  })()`);
}

async function verifyRemovedSession(session) {
  return session.evaluate(`(() =>
    !document.documentElement.classList.contains('codex-dream-skin') &&
    !document.documentElement.style.getPropertyValue('--dream-art') &&
    !document.querySelector('.dream-home') &&
    !document.querySelector('.dream-task') &&
    !document.querySelector('.dream-home-shell') &&
    !document.getElementById('codex-dream-skin-style') &&
    !document.getElementById('codex-dream-skin-chrome') &&
    !window.__CODEX_DREAM_SKIN_STATE__
  )()`);
}

async function verifySession(session) {
  return session.evaluate(`(() => {
    const box = (node) => {
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        x: Math.round(rect.x), y: Math.round(rect.y),
        width: Math.round(rect.width), height: Math.round(rect.height),
        visible: rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden",
      };
    };
    const root = document.documentElement;
    const runtimeState = window.__CODEX_DREAM_SKIN_STATE__ ||
      window.__CODEX_GLASS_VISION_SKIN_STATE__ || null;
    const modernHome = document.querySelector('[data-ds-part="home"]');
    const homeSignal = document.querySelector('[data-testid="home-icon"]') ||
      document.querySelector('[data-feature="game-source"]') ||
      document.querySelector('.group\\\\/home-suggestions');
    const homeRoute = modernHome || homeSignal?.closest('[role="main"]') || null;
    const home = modernHome ||
      document.querySelector('[role="main"].dream-home, [role="main"].dream-skin-home, [role="main"].glass-vision-home');
    const suggestions = home?.querySelector('.group\\\\/home-suggestions') || null;
    const cards = suggestions ? [...suggestions.querySelectorAll('button')].map(box) : [];
    const chrome = document.getElementById('codex-dream-skin-chrome') ||
      document.getElementById('codex-glass-vision-skin-chrome');
    const chromePointerEvents = chrome ? getComputedStyle(chrome).pointerEvents : null;
    const adoptedStylePresent = runtimeState?.styleMode === 'adopted' &&
      runtimeState.styleSheet &&
      Array.from(document.adoptedStyleSheets || []).includes(runtimeState.styleSheet);
    const stateStylePresent = runtimeState?.styleMode === 'style' &&
      Boolean(runtimeState.styleNode?.isConnected);
    const result = {
      installed: root.getAttribute('data-dream-skin') === 'active' ||
        root.classList.contains('codex-dream-skin') ||
        root.classList.contains('codex-glass-vision-skin'),
      version: runtimeState?.version || null,
      expectedVersion: ${JSON.stringify(SKIN_VERSION)},
      stylePresent: Boolean(document.getElementById('codex-dream-skin-style') ||
        document.getElementById('codex-glass-vision-skin-style') ||
        adoptedStylePresent || stateStylePresent),
      chromePresent: Boolean(chrome),
      chromePointerEvents,
      decorationSafe: !chrome || chromePointerEvents === 'none',
      homeRoute: Boolean(homeRoute),
      homePresent: Boolean(home),
      hero: box(home?.querySelector('[data-ds-part="home-hero"]') ||
        home?.firstElementChild?.firstElementChild?.firstElementChild),
      visibleCardCount: cards.filter((item) => item?.visible).length,
      projectButton: box(home?.querySelector('.group\\\\/project-selector > button')),
      composer: box(document.querySelector(
        '.composer-surface-chrome, [class*="_ComposerLayoutRoot_"], ' +
        '[data-composer-surface-variant][data-composer-radius-variant], [data-ds-part="composer"]',
      )),
      sidebar: box(document.querySelector('aside.app-shell-left-panel')),
      viewport: { width: innerWidth, height: innerHeight },
      documentOverflow: {
        x: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        y: document.documentElement.scrollHeight > document.documentElement.clientHeight,
      },
    };
    result.pass = result.installed &&
      result.stylePresent && result.decorationSafe &&
      Boolean(result.composer) && Boolean(result.composer.visible) &&
      Boolean(result.sidebar) && Boolean(result.sidebar.visible) &&
      !result.documentOverflow.x && !result.documentOverflow.y &&
      (!result.homePresent || Boolean(result.hero));
    return result;
  })()`);
}

async function waitForVerifiedSession(session, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastResult;
  let lastError;
  while (Date.now() < deadline) {
    try {
      lastResult = await verifySession(session);
      lastError = null;
      if (lastResult.pass) return lastResult;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!lastResult && lastError) throw lastError;
  return lastResult;
}

async function capture(session, outputPath) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const result = await session.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  await fs.writeFile(outputPath, Buffer.from(result.data, "base64"));
}

async function runOneShot(options) {
  const connected = await connectCodexTargets(options.port, options.timeoutMs, options.browserId);
  const loadedPayload = (options.mode === "once" || options.reload)
    ? await loadPayload(options.themeDir) : null;
  const payload = loadedPayload?.payload ?? null;
  const results = [];
  let screenshotCaptured = false;
  try {
    for (const { target, session, probe } of connected) {
      try {
        if (options.mode === "remove") await removeFromSession(session);
        else if (options.mode === "once") await applyToSession(session, payload);
        if (options.mode === "once") {
          await new Promise((resolve) => setTimeout(resolve, 850));
        }
        if (options.reload) {
          await session.send("Page.reload", { ignoreCache: true });
          await new Promise((resolve) => setTimeout(resolve, 1600));
          if (options.mode !== "remove") await applyToSession(session, payload);
        }
        const verified = options.mode === "remove"
          ? await verifyRemovedSession(session)
          : (options.reload || options.mode === "once" || options.mode === "verify")
            ? await waitForVerifiedSession(session, options.timeoutMs)
            : await verifySession(session);
        results.push({ targetId: target.id, markers: probe.markers, result: verified });
        if (options.screenshot && !screenshotCaptured) {
          await capture(session, options.screenshot);
          screenshotCaptured = true;
        }
      } finally {
        session.close();
      }
    }
  } finally {
    for (const { session } of connected) session.close();
  }
  console.log(JSON.stringify({ mode: options.mode, port: options.port, targets: results }, null, 2));
  const failed = results.length === 0 || results.some((item) =>
    options.mode === "remove" ? item.result !== true : !item.result?.pass);
  if (failed) process.exitCode = 2;
}

async function runWatch(options) {
  let identityAnchor = await connectBrowserIdentityAnchor(options.port, options.browserId);
  // The anchor only learns it is dead from the WebSocket close event, and a
  // force-killed Codex can leave that socket half-open with no close at all.
  // So the identity is also verified directly against /json/version each pass.
  let anchoredBrowserId = options.browserId;
  const sessions = new Map();
  const earlyScripts = new Map();
  const fallbackTargets = new Map();
  const fallbackListeners = new Set();
  const targetFailures = new Map();
  let stopping = false;
  let listFailures = 0;
  let lastListErrorLogAt = 0;
  let lastThemeErrorLogAt = 0;
  let lastStrongThemeAuditAt = 0;
  let loadedPayload = null;
  let paused = false;
  const stop = () => { stopping = true; };
  const rejectTarget = (target, baseDelayMs, error = null) => {
    const previous = targetFailures.get(target.id) ?? { failures: 0, lastLogAt: 0 };
    const failures = previous.failures + 1;
    const delayMs = Math.min(30000, baseDelayMs * (2 ** Math.min(failures - 1, 4)));
    const now = Date.now();
    if (error && (failures === 1 || now - previous.lastLogAt >= 30000)) {
      console.error(`[dream-skin] inject failed for ${target.id}: ${error.message}; retrying in ${delayMs}ms`);
      previous.lastLogAt = now;
    }
    targetFailures.set(target.id, { failures, lastLogAt: previous.lastLogAt, until: now + delayMs });
  };
  const attachLoadFallback = (id, target, session) => {
    if (fallbackListeners.has(id)) return;
    fallbackListeners.add(id);
    let lastReinjectErrorLogAt = 0;
    session.on("Page.loadEventFired", () => {
      if (!fallbackTargets.get(id)) return;
      setTimeout(() => {
        const operation = paused ? removeFromSession(session) : applyToSession(session, loadedPayload.payload);
        operation.catch((error) => {
          if (Date.now() - lastReinjectErrorLogAt >= 30000) {
            console.error(`[dream-skin] reinject failed for ${target.id}: ${error.message}`);
            lastReinjectErrorLogAt = Date.now();
          }
        });
      }, 250);
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    loadedPayload = await loadPayload(options.themeDir);
    lastStrongThemeAuditAt = Date.now();
    paused = await fileExists(options.pauseFile);
    while (!stopping) {
      // Verify the browser identity directly rather than waiting for a close
      // event that a force-killed Codex may never send. A failed fetch means the
      // endpoint is gone; a different id means Codex was restarted. Either way
      // the anchor is dropped and the re-anchor path below takes over.
      try {
        const version = await fetchCdpJson(options.port, "/json/version");
        const currentBrowserId = browserIdFromVersion(version, options.port);
        if (currentBrowserId !== anchoredBrowserId) {
          console.error(`[dream-skin] ${new Date().toISOString()} CDP browser identity changed from ${anchoredBrowserId} to ${currentBrowserId}`);
          identityAnchor.close();
        }
      } catch {
        if (!identityAnchor.closed) {
          console.error(`[dream-skin] ${new Date().toISOString()} CDP endpoint stopped answering; waiting for it to return`);
          identityAnchor.close();
        }
      }
      if (identityAnchor.closed) {
        // Codex was restarted, so our loopback port now belongs to a new browser
        // identity — or is briefly gone while Codex is down. Wait for the
        // endpoint to come back and re-anchor to whatever browser answers,
        // instead of exiting: that way the skin follows a Codex restart
        // immediately rather than waiting for an external supervisor to notice.
        //
        // Safety is unchanged. The port is the one our own launcher opened, and
        // every target is still gated on the Codex shell markers by
        // probeSession, so this does not widen what we inject into. Giving up
        // after a long quiet period keeps a genuinely closed Codex from leaving
        // a watcher behind.
        let reanchored = null;
        let reanchoredVersion = null;
        for (let attempt = 0; attempt < 600 && !stopping; attempt += 1) {
          try {
            const version = await fetchCdpJson(options.port, "/json/version");
            reanchored = new BrowserIdentityAnchor(validatedDebuggerUrl(version, options.port)).open();
            reanchoredVersion = version;
            break;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }
        if (!reanchored) {
          console.error("[dream-skin] CDP endpoint did not return; watcher is stopping");
          process.exitCode = 3;
          break;
        }
        identityAnchor = reanchored;
        anchoredBrowserId = browserIdFromVersion(reanchoredVersion, options.port);
        // Give the fresh Codex time to build its main window. Connecting and
        // injecting the instant the port answers is what made a close and an
        // immediate restart look like a crash.
        await new Promise((resolve) => setTimeout(resolve, 4000));
        console.error(`[dream-skin] ${new Date().toISOString()} Codex restarted with a new browser identity; re-anchored`);
        continue;
      }
      let targets = [];
      try {
        targets = await listAppTargets(options.port);
        listFailures = 0;
      } catch (error) {
        listFailures += 1;
        const retryMs = Math.min(10000, 1000 * (2 ** Math.min(listFailures - 1, 4)));
        if (listFailures === 1 || Date.now() - lastListErrorLogAt >= 30000) {
          console.error(`[dream-skin] ${new Date().toISOString()} ${error.message}; retrying in ${retryMs}ms`);
          lastListErrorLogAt = Date.now();
        }
        await new Promise((resolve) => setTimeout(resolve, retryMs));
        continue;
      }

      const nextPaused = await fileExists(options.pauseFile);
      let nextPayload = loadedPayload;
      if (!nextPaused) {
        try {
          const now = Date.now();
          let shouldAudit = !loadedPayload || now - lastStrongThemeAuditAt >= STRONG_THEME_AUDIT_MS;
          if (!shouldAudit) {
            try {
              shouldAudit = await readThemeSourceStamp(loadedPayload) !== loadedPayload.sourceStamp;
            } catch {
              shouldAudit = true;
            }
          }
          if (shouldAudit) {
            const candidateTheme = await loadTheme(options.themeDir);
            lastStrongThemeAuditAt = now;
            if (!loadedPayload || candidateTheme.fingerprint !== loadedPayload.fingerprint) {
              nextPayload = await loadPayload(options.themeDir, candidateTheme);
            } else {
              loadedPayload.sourceStamp = candidateTheme.sourceStamp;
            }
          }
        } catch (error) {
          if (Date.now() - lastThemeErrorLogAt >= 30000) {
            console.error(`[dream-skin] theme update rejected: ${error.message}; keeping the active theme`);
            lastThemeErrorLogAt = Date.now();
          }
        }
      }
      const pauseChanged = nextPaused !== paused;
      const payloadChanged = !nextPaused && nextPayload !== loadedPayload;
      loadedPayload = nextPayload;
      paused = nextPaused;

      if (pauseChanged || payloadChanged) {
        for (const [id, session] of sessions) {
          try {
            const previousEarlyScript = earlyScripts.get(id);
            if (paused) {
              await removeFromSession(session);
              await removeEarlyPayload(session, previousEarlyScript);
              earlyScripts.delete(id);
              fallbackTargets.delete(id);
              fallbackListeners.delete(id);
            } else {
              let nextEarlyScript = null;
              try {
                nextEarlyScript = await registerEarlyPayload(
                  session,
                  loadedPayload.payload,
                  loadedPayload.fingerprint,
                );
                if (!nextEarlyScript) throw new Error("CDP did not return an early-script identifier");
                fallbackTargets.set(id, false);
              } catch (error) {
                fallbackTargets.set(id, true);
                console.error(`[dream-skin] early theme refresh unavailable for ${id}: ${error.message}`);
                attachLoadFallback(id, { id }, session);
              }
              if (nextEarlyScript) earlyScripts.set(id, nextEarlyScript);
              else earlyScripts.delete(id);
              await removeEarlyPayload(session, previousEarlyScript);
              await applyToSession(session, loadedPayload.payload);
            }
          } catch (error) {
            console.error(`[dream-skin] live theme update failed for ${id}: ${error.message}`);
            await removeEarlyPayload(session, earlyScripts.get(id));
            earlyScripts.delete(id);
            fallbackTargets.delete(id);
            fallbackListeners.delete(id);
            session.close();
            sessions.delete(id);
          }
        }
        console.log(paused ? "[dream-skin] paused" : `[dream-skin] active theme ${loadedPayload.theme.id}`);
      }

      const activeIds = new Set(targets.map((target) => target.id));
      for (const id of targetFailures.keys()) {
        if (!activeIds.has(id)) targetFailures.delete(id);
      }
      for (const [id, session] of sessions) {
        if (!activeIds.has(id) || session.closed) {
          await removeEarlyPayload(session, earlyScripts.get(id));
          earlyScripts.delete(id);
          fallbackTargets.delete(id);
          fallbackListeners.delete(id);
          session.close();
          sessions.delete(id);
          targetFailures.delete(id);
        }
      }

      for (const target of targets) {
        if (identityAnchor.closed) break;
        if (sessions.has(target.id)) continue;
        if ((targetFailures.get(target.id)?.until ?? 0) > Date.now()) continue;
        let session;
        let earlyScriptId = null;
        try {
          session = await connectTarget(target, options.port);
          if (identityAnchor.closed) throw new CdpIdentityMismatchError("Original CDP browser identity closed");
          // Probe BEFORE touching the target. Registering or evaluating a
          // payload on a document that is still loading can take the renderer
          // down, which is what made a fast Codex restart look like a crash.
          const probe = await waitForCodexProbe(session);
          if (!probe?.codex) {
            session.close();
            rejectTarget(target, 5000);
            continue;
          }
          let earlyInjectionFallback = false;
          if (!paused) {
            try {
              earlyScriptId = await registerEarlyPayload(
                session,
                loadedPayload.payload,
                loadedPayload.fingerprint,
              );
              if (!earlyScriptId) throw new Error("CDP did not return an early-script identifier");
              await session.evaluate(earlyPayloadFor(loadedPayload.payload, loadedPayload.fingerprint));
            } catch (error) {
              await removeEarlyPayload(session, earlyScriptId);
              earlyScriptId = null;
              earlyInjectionFallback = true;
              console.error(`[dream-skin] early injection unavailable for ${target.id}: ${error.message}`);
            }
          }
          fallbackTargets.set(target.id, earlyInjectionFallback);
          if (earlyInjectionFallback) attachLoadFallback(target.id, target, session);
          if (identityAnchor.closed) throw new CdpIdentityMismatchError("Original CDP browser identity closed");
          let earlyApplied = false;
          if (!paused && !earlyInjectionFallback) {
            earlyApplied = await session.evaluate(
              `window.__CODEX_DREAM_SKIN_EARLY_APPLIED__ === ${JSON.stringify(loadedPayload.fingerprint)}`,
            ).catch(() => false);
          }
          if (paused) await removeFromSession(session);
          else if (!earlyApplied) await applyToSession(session, loadedPayload.payload);
          sessions.set(target.id, session);
          if (earlyScriptId) earlyScripts.set(target.id, earlyScriptId);
          targetFailures.delete(target.id);
          console.log(`[dream-skin] injected target ${target.id}`);
        } catch (error) {
          await removeEarlyPayload(session, earlyScriptId);
          fallbackTargets.delete(target.id);
          fallbackListeners.delete(target.id);
          session?.close();
          if (identityAnchor.closed || error instanceof CdpIdentityMismatchError) break;
          rejectTarget(target, 2500, error);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  } finally {
    identityAnchor.close();
    for (const [id, session] of sessions) {
      await removeEarlyPayload(session, earlyScripts.get(id));
      session.close();
    }
    earlyScripts.clear();
    fallbackTargets.clear();
    fallbackListeners.clear();
  }
}

if (path.resolve(process.argv[1] || "") === path.resolve(scriptPath)) {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === "self-test") {
  const valid = validatedDebuggerUrl({ webSocketDebuggerUrl: `ws://127.0.0.1:${options.port}/devtools/page/test` }, options.port);
  const browserId = browserIdFromVersion({
    webSocketDebuggerUrl: `ws://127.0.0.1:${options.port}/devtools/browser/test-browser`,
  }, options.port);
  const invalid = [
    "ws://example.com/devtools/page/test",
    `ws://127.0.0.1:${options.port + 1}/devtools/page/test`,
    `wss://127.0.0.1:${options.port}/devtools/page/test`,
    `ws://user@127.0.0.1:${options.port}/devtools/page/test`,
    `ws://127.0.0.1:${options.port}/unexpected/test`,
    `ws://127.0.0.1:${options.port}/devtools/page/test?query=1`,
  ];
  for (const value of invalid) {
    let rejected = false;
    try { validatedDebuggerUrl({ webSocketDebuggerUrl: value }, options.port); } catch { rejected = true; }
    if (!rejected) throw new Error(`CDP URL validation accepted an unsafe URL: ${value}`);
  }
  const invalidBrowserUrls = [
    `ws://127.0.0.1:${options.port}/devtools/page/not-a-browser`,
    `ws://127.0.0.1:${options.port}/devtools/browser/bad%20id`,
    `ws://127.0.0.1:${options.port}/devtools/browser/test?query=1`,
  ];
  for (const value of invalidBrowserUrls) {
    let rejected = false;
    try { browserIdFromVersion({ webSocketDebuggerUrl: value }, options.port); } catch { rejected = true; }
    if (!rejected) throw new Error(`Browser identity validation accepted an unsafe URL: ${value}`);
  }
  const validPageTarget = {
    id: "page-test",
    type: "page",
    url: "app://codex/",
    webSocketDebuggerUrl: `ws://127.0.0.1:${options.port}/devtools/page/page-test`,
  };
  const invalidPageTargets = [
    { ...validPageTarget, webSocketDebuggerUrl: `ws://127.0.0.1:${options.port}/devtools/browser/page-test` },
    { ...validPageTarget, id: "other-page" },
    { ...validPageTarget, id: 123 },
    { ...validPageTarget, type: "other" },
  ];
  if (!valid || browserId !== "test-browser" || !isValidCdpPageTarget(validPageTarget, options.port) ||
      invalidPageTargets.some((item) => isValidCdpPageTarget(item, options.port))) {
    throw new Error("CDP URL and target validation self-test failed");
  }
  const validMessage = parseCdpMessage('{"id":7,"result":{"ok":true}}');
  const invalidMessages = ["{not-json", "null", '"text"', "42", "true"];
  if (validMessage?.id !== 7 || validMessage.result?.ok !== true ||
      invalidMessages.some((value) => parseCdpMessage(value) !== null)) {
    throw new Error("CDP message validation self-test failed");
  }
  if (/dispatchKeyEvent|dispatchMouseEvent/.test(capture.toString())) {
    throw new Error("Screenshot capture must not dispatch renderer input events");
  }
  console.log(JSON.stringify({ pass: true, version: SKIN_VERSION, test: "loopback-cdp-validation" }));
  } else if (options.mode === "check-payload") {
    const loaded = await loadPayload(options.themeDir);
    const unresolved = ["__DREAM_CSS_JSON__", "__DREAM_ART_JSON__", "__DREAM_THEME_JSON__"]
      .some((placeholder) => loaded.payload.includes(placeholder));
    if (unresolved) {
      throw new Error("Payload placeholders were not fully replaced");
    }
    console.log(JSON.stringify({
      pass: true,
      version: SKIN_VERSION,
      payloadBytes: Buffer.byteLength(loaded.payload),
      themeId: loaded.theme.id,
      appearance: loaded.theme.appearance,
      art: loaded.theme.art,
      artMetadata: loaded.theme.artMetadata ?? null,
    }));
  } else if (options.mode === "watch") await runWatch(options);
  else await runOneShot(options);
}
