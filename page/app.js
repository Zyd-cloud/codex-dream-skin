// Page logic for the Dream Skin plugin.
//
// The page runs in an iframe sandboxed to `allow-scripts` with `connect-src
// 'none'`: it cannot reach the network or magpie's API, and `fetch` is blocked.
// Two channels are left, and this page uses both:
//
//   reading   `state.js` in the plugin's own folder, loaded with a <script> tag
//             (a subresource from its own folder is allowed; only connect-src is
//             not). The host rewrites that file after every command, so no
//             magpie round-trip — and no plugin restart — is needed to answer.
//   writing   `magpie.options.set({ request })`, the page's one write channel.
//
// The host reads `options.request`, runs the action, and republishes state.js
// with `{ id, ok, error, message, state }`.
(() => {
  const $ = (id) => document.getElementById(id);
  const POLL_MS = 2000;
  const CMD_TIMEOUT_MS = 60000;

  const ui = {
    subtitle: $("subtitle"),
    status: $("status"),
    chipSkin: $("chip-skin"),
    chipCodex: $("chip-codex"),
    chipInjector: $("chip-injector"),
    chipActive: $("chip-active"),
    themes: $("themes"),
    themesEmpty: $("themes-empty"),
    market: $("market"),
    marketHint: $("market-hint"),
    marketTools: $("market-tools"),
    marketSearch: $("market-search"),
    marketMore: $("market-more"),
    btnMore: $("btn-more"),
    toast: $("toast"),
    btnApply: $("btn-apply"),
    btnOriginal: $("btn-original"),
    btnRefresh: $("btn-refresh"),
    btnMarket: $("btn-market"),
    editDialog: $("edit-dialog"),
    editForm: $("edit-form"),
    editId: $("edit-id"),
    editName: $("edit-name"),
    editAppearance: $("edit-appearance"),
    editTaskMode: $("edit-taskmode"),
    editSafeArea: $("edit-safearea"),
    editFocusX: $("edit-focusx"),
    editFocusY: $("edit-focusy"),
    editFocusXOut: $("edit-focusx-out"),
    editFocusYOut: $("edit-focusy-out"),
    editCancel: $("edit-cancel"),
    editSave: $("edit-save"),
    confirmDialog: $("confirm-dialog"),
    confirmText: $("confirm-text"),
    confirmCancel: $("confirm-cancel"),
    confirmOk: $("confirm-ok"),
  };

  const MARKET_PAGE = 24;      // cards drawn per batch
  const PREVIEW_BATCH = 24;    // thumbnails asked for in one go
  const PREVIEW_RETRY_MS = 60000;
  let marketVisible = MARKET_PAGE;
  let marketQuery = "";
  const previewAsked = new Map();   // market entry id -> when it was asked for
  let previewCooldownUntil = 0;

  let state = null;          // last snapshot from state.js
  let stateRev = null;       // `rev` of the snapshot already drawn
  let pending = null;        // { id, action, at }
  let toastTimer = null;

  function toast(message, bad) {
    ui.toast.textContent = message;
    ui.toast.classList.toggle("bad", Boolean(bad));
    ui.toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 4500);
  }

  async function readOptions() {
    try { return (await magpie.options.get()) || {}; } catch { return {}; }
  }

  /** Load state.js with a cache-busting query and hand back what it assigned. */
  function loadState() {
    return new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = `state.js?t=${Date.now()}`;
      const done = (value) => { script.remove(); resolve(value); };
      script.onload = () => done(globalThis.__DREAM_SKIN_STATE__ || null);
      script.onerror = () => done(null);
      document.head.append(script);
    });
  }

  /**
   * Is a command in flight? While one is, the page must not offer another: the
   * cards are rebuilt from each new snapshot (every couple of seconds), so a
   * `disabled` poked onto one button would be thrown away by the next render.
   * Everything below derives its state from `pending` instead.
   */
  function isBusy() {
    return pending !== null;
  }

  /** True when the in-flight command is switching to this very theme. */
  function isSwitchingTo(theme) {
    if (!pending) return false;
    if (pending.action !== "switch" && pending.action !== "market-install") return false;
    return pending.themeId === theme.switchId
      || pending.themeId === theme.installId
      || pending.themeId === theme.id;
  }

  /**
   * Has the command actually landed?
   *
   * The response arriving is not enough. A reply can come back before the state
   * it describes is the one being reported — clearing `pending` on the id alone
   * unlocks the buttons for a moment while the old theme is still the active
   * one, which reads as "it did not switch, let me click again". So a command
   * only ends when the snapshot both answers it and shows what it asked for.
   */
  function commandLanded(snapshot) {
    if (!pending || !snapshot) return false;
    if (snapshot.id !== pending.id) return false;
    if (!snapshot.ok) return true;             // a failure is a legitimate end

    const st = snapshot.state || {};
    const wanted = pending.expect || {};
    if ("active" in wanted) {
      if (st.paused) return false;             // paused shows no active theme
      if (String(st.active || "") !== String(wanted.active)) return false;
    }
    if ("paused" in wanted && Boolean(st.paused) !== Boolean(wanted.paused)) return false;
    return true;
  }

  async function sendCommand(action, themeId, expect, extra) {
    if (pending) return;                       // one command at a time
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    pending = { id, action, themeId, expect: expect || null, at: Date.now() };
    render();                                  // reflect the block at once
    const options = await readOptions();
    const request = { id, action };
    if (themeId) request.themeId = themeId;
    // Only `update` carries a patch, and only the fields the user changed.
    if (extra && typeof extra === "object") request.patch = extra;
    try {
      await magpie.options.set({ ...options, request });
      toast(action === "pause" ? "正在恢复官方外观…"
        : action === "market-load" ? "正在加载市场…"
        : action === "market-install" ? "正在下载主题…"
        : action === "delete" ? "正在删除…"
        : action === "update" ? "正在保存…"
        : "正在切换…");
    } catch (error) {
      pending = null;
      render();
      toast(`操作失败：${error?.message ?? error}`, true);
    }
  }

  function swatch(color) {
    const span = document.createElement("span");
    span.className = "swatch";
    if (color) span.style.background = color;
    return span;
  }

  function card(theme, opts) {
    const el = document.createElement("article");
    el.className = "card";
    if (opts.active) el.classList.add("active");

    const shot = document.createElement("div");
    shot.className = "shot";
    if (theme.preview) {
      const img = document.createElement("img");
      img.src = `previews/${theme.preview}`;
      img.alt = theme.name || theme.id;
      img.loading = "lazy";
      shot.append(img);
    } else {
      shot.classList.add("none");
    }

    const meta = document.createElement("div");
    meta.className = "meta";

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = theme.name || theme.id;
    name.title = theme.id;
    meta.append(name);

    const row = document.createElement("div");
    row.className = "row";
    const colors = theme.colors || {};
    row.append(swatch(colors.panel), swatch(colors.accent), swatch(colors.text));
    const bits = [theme.appearance, theme.taskMode].filter(Boolean);
    const label = document.createElement("span");
    label.textContent = bits.join(" · ");
    row.append(label);
    meta.append(row);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "pick";
    const switching = isSwitchingTo(theme);
    // The switch target is resolved up front so isSwitchingTo() and the click
    // handler can never disagree about which id identifies this card.
    const target = opts.installed
      ? (theme.switchId || theme.id)
      : (theme.installId || theme.id);

    if (switching) {
      button.textContent = "切换中…";
      button.disabled = true;
      button.classList.add("busy");
      el.classList.add("switching");
    } else if (opts.active) {
      button.textContent = "使用中";
      button.disabled = true;
    } else {
      button.textContent = opts.installed ? "使用" : "安装";
      // While any command runs, nothing is clickable: a second click would
      // race the first one and the page could not tell which won.
      button.disabled = isBusy();
      button.addEventListener("click", () => {
        // Two different ids are in play: a local theme switches by its theme id,
        // a market entry installs by its version id (`ver_…`). An installed
        // market entry therefore switches by themeId, not by version id.
        if (opts.installed) {
          sendCommand("switch", target, { active: target });
        } else {
          // Installing ends by applying the theme, whose local id is themeId.
          sendCommand("market-install", target, { active: theme.switchId || target });
        }
      });
    }
    meta.append(button);

    if (opts.editable) {
      const tools = document.createElement("div");
      tools.className = "tools";

      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "tool";
      edit.textContent = "编辑";
      edit.title = "改名、外观、取景";
      edit.disabled = isBusy();
      edit.addEventListener("click", () => openEdit(theme.id));
      tools.append(edit);

      const del = document.createElement("button");
      del.type = "button";
      del.className = "tool danger";
      del.textContent = "删除";
      // The engine refuses to delete the theme that is on screen. Say why on the
      // button instead of letting the click come back as a failed command.
      del.disabled = isBusy() || Boolean(opts.active);
      del.title = opts.active
        ? "正在使用的主题不能删除，先切换到其他主题"
        : `删除「${theme.name || theme.id}」`;
      del.addEventListener("click", () => askDelete(theme.id));
      tools.append(del);

      meta.append(tools);
    }

    el.append(shot, meta);
    return el;
  }

  // --- theme editing / deleting -------------------------------------------

  let editingId = null;
  let deletingId = null;

  function themeById(id) {
    return (state?.state?.themes || []).find((t) => t.id === id) || null;
  }

  function syncFocusLabels() {
    ui.editFocusXOut.textContent = Number(ui.editFocusX.value).toFixed(2);
    ui.editFocusYOut.textContent = Number(ui.editFocusY.value).toFixed(2);
  }

  function openEdit(id) {
    const theme = themeById(id);
    if (!theme || pending) return;
    editingId = id;
    ui.editId.textContent = id;
    ui.editName.value = theme.name || id;
    ui.editAppearance.value = theme.appearance || "auto";
    ui.editTaskMode.value = theme.taskMode || "ambient";
    ui.editSafeArea.value = theme.safeArea || "none";
    ui.editFocusX.value = Number.isFinite(theme.focusX) ? theme.focusX : 0.5;
    ui.editFocusY.value = Number.isFinite(theme.focusY) ? theme.focusY : 0.5;
    syncFocusLabels();
    ui.editDialog.showModal();
  }

  function closeEdit() {
    editingId = null;
    if (ui.editDialog.open) ui.editDialog.close();
  }

  function saveEdit() {
    if (!editingId || pending) return;
    const theme = themeById(editingId);
    const name = ui.editName.value.trim();
    if (!name) { toast("名称不能为空", true); return; }

    // Send only what changed: the engine leaves every omitted field alone, so a
    // rename cannot reset the art settings.
    const patch = {};
    if (theme && name !== (theme.name || "")) patch.name = name;
    if (theme && ui.editAppearance.value !== (theme.appearance || "auto")) {
      patch.appearance = ui.editAppearance.value;
    }
    if (theme && ui.editTaskMode.value !== (theme.taskMode || "ambient")) {
      patch.taskMode = ui.editTaskMode.value;
    }
    if (theme && ui.editSafeArea.value !== (theme.safeArea || "none")) {
      patch.safeArea = ui.editSafeArea.value;
    }
    const fx = Number(ui.editFocusX.value);
    const fy = Number(ui.editFocusY.value);
    if (theme && Math.abs(fx - (Number.isFinite(theme.focusX) ? theme.focusX : 0.5)) > 0.001) {
      patch.focusX = fx;
    }
    if (theme && Math.abs(fy - (Number.isFinite(theme.focusY) ? theme.focusY : 0.5)) > 0.001) {
      patch.focusY = fy;
    }

    if (!Object.keys(patch).length) { closeEdit(); toast("没有改动"); return; }
    const id = editingId;
    closeEdit();
    sendCommand("update", id, null, patch);
  }

  function askDelete(id) {
    const theme = themeById(id);
    if (!theme || pending) return;
    deletingId = id;
    ui.confirmText.textContent =
      `确定删除「${theme.name || id}」吗？主题文件会从本机移除，无法撤销。`;
    ui.confirmDialog.showModal();
  }

  function closeConfirm() {
    deletingId = null;
    if (ui.confirmDialog.open) ui.confirmDialog.close();
  }

  function confirmDelete() {
    if (!deletingId || pending) return;
    const id = deletingId;
    closeConfirm();
    sendCommand("delete", id, null);
  }

  function marketView() {
    const all = state?.state?.market || [];
    const q = marketQuery.trim().toLowerCase();
    const filtered = q
      ? all.filter((t) =>
          `${t.name} ${t.author} ${t.themeId}`.toLowerCase().includes(q))
      : all;
    return { all, filtered };
  }

  /**
   * Thumbnails only exist for themes the worker has already downloaded, and the
   * page cannot fetch them itself. So whenever cards come into view without a
   * preview — on 「显示更多」 or after a search — ask the worker for that batch.
   *
   * Deliberately a *quiet* request: it must not set `pending`, because fetching
   * a thumbnail is cosmetic and blocking every control for it would be absurd.
   */
  function queueMissingPreviews(shown) {
    if (isBusy() || Date.now() < previewCooldownUntil) return;
    const now = Date.now();
    const need = shown
      .filter((t) => !t.preview && now - (previewAsked.get(t.id) || 0) > PREVIEW_RETRY_MS)
      .map((t) => t.id);
    if (!need.length) return;

    const batch = need.slice(0, PREVIEW_BATCH);
    batch.forEach((id) => previewAsked.set(id, now));
    requestPreviews(batch);
  }

  async function requestPreviews(ids) {
    previewCooldownUntil = Date.now() + 4000;
    try {
      // Read fresh, and never clobber a real command that just started.
      const options = await readOptions();
      if (isBusy()) return;
      await magpie.options.set({
        ...options,
        request: { id: `thumbs-${Date.now().toString(36)}`, action: "market-thumbs", ids },
      });
    } catch {
      // Let a later render try again rather than giving up for good.
      ids.forEach((id) => previewAsked.delete(id));
      previewCooldownUntil = Date.now() + 15000;
    }
  }

  function renderMarket() {
    const { all, filtered } = marketView();
    const shown = filtered.slice(0, marketVisible);

    ui.market.replaceChildren(
      ...shown.map((t) => card(
        {
          id: t.id,
          switchId: t.themeId,
          installId: t.id,
          name: t.name,
          preview: t.preview,
          appearance: t.installed ? "已安装" : "",
          taskMode: t.author,
        },
        { active: false, installed: Boolean(t.installed) },
      )),
    );

    const remaining = filtered.length - shown.length;
    ui.marketMore.hidden = remaining <= 0;
    if (remaining > 0) {
      ui.btnMore.textContent = `显示更多（还有 ${remaining} 个）`;
    }

    if (all.length) {
      ui.marketTools.hidden = false;
      ui.marketHint.textContent = q_count(shown, filtered, all);
    }

    // Whatever just came into view without a picture, ask for it.
    queueMissingPreviews(shown);
  }

  function q_count(shown, filtered, all) {
    const base = `市场共 ${all.length} 个${filtered.length !== all.length ? `，筛选出 ${filtered.length} 个` : ""}`;
    const missing = shown.filter((t) => !t.preview).length;
    return missing ? `${base} · 本屏 ${missing} 张预览加载中` : base;
  }

  function render() {
    const snapshot = state?.state || {};
    const themes = snapshot.themes || [];
    const paused = Boolean(snapshot.paused);
    const active = snapshot.active || "";
    const busy = isBusy();

    ui.subtitle.textContent = busy
      ? "正在切换，等这一步完成…"
      : themes.length
        ? `${themes.length} 个本地主题${paused ? " · 当前为官方外观" : ` · 使用中：${active || "—"}`}`
        : (state ? "还没有主题，点「刷新」或从市场安装" : "正在读取状态…");

    ui.status.hidden = !state;
    if (state) {
      ui.chipSkin.textContent = paused ? "皮肤：已关闭" : "皮肤：已开启";
      ui.chipSkin.className = `chip ${paused ? "off" : "on"}`;
      ui.chipCodex.textContent = `Codex：${snapshot.codexRunning ? "运行中" : "未运行"}`;
      ui.chipCodex.className = `chip ${snapshot.codexRunning ? "on" : "off"}`;
      ui.chipInjector.textContent = snapshot.injector
        ? `注入器：${snapshot.injector.fresh ? "正常" : "待刷新"}`
        : "注入器：未运行";
      ui.chipInjector.className = `chip ${snapshot.injector?.fresh ? "on" : "off"}`;
      ui.chipActive.textContent = `活动主题：${active || "—"}`;
      ui.chipActive.className = "chip on";
    }

    // The controls are governed by `pending` alone, so this runs whether or not
    // a snapshot has arrived yet — nothing is clickable before the first one.
    ui.btnApply.disabled = busy || !state;
    ui.btnApply.textContent = paused ? "应用皮肤" : "重新应用";
    ui.btnOriginal.disabled = busy || paused || !state;
    ui.btnRefresh.disabled = busy || !state;
    ui.btnMarket.disabled = busy;

    ui.themes.replaceChildren(
      ...themes.map((t) => card(t, {
          active: !paused && t.id === active,
          installed: true,
          editable: true,
        })),
    );
    ui.themesEmpty.hidden = themes.length > 0;

    renderMarket();
  }

  async function poll() {
    const snapshot = await loadState();
    let cleared = false;
    let redraw = false;

    if (snapshot) {
      state = snapshot;
      // The worker publishes every 30 s and after every command; the page reads
      // twice a second. Redrawing on an unchanged snapshot rebuilt every card
      // and re-created every <img>, which flickered. `rev` marks a real change.
      // A snapshot without it (an older worker still running during an upgrade)
      // falls back to redrawing every poll, which is merely slower, not wrong.
      if (snapshot.rev === undefined || snapshot.rev !== stateRev) {
        stateRev = snapshot.rev;
        redraw = true;
      }
      if (commandLanded(snapshot)) {
        pending = null;
        cleared = true;
        if (snapshot.ok) toast(snapshot.message || "完成");
        else toast(`失败：${snapshot.error || "未知错误"}`, true);
      } else if (pending && snapshot.id === pending.id && snapshot.ok) {
        // Answered, but the state it carries is not the one that was asked for.
        // Keep blocking; if the state never catches up, give up quickly rather
        // than sit behind a spinner.
        if (!pending.awaitingSince) pending.awaitingSince = Date.now();
      }
    } else if (!state) {
      ui.subtitle.textContent = "state.js 尚未生成，等插件宿主启动…";
    }

    if (pending && pending.awaitingSince && Date.now() - pending.awaitingSince > 8000) {
      pending = null;
      cleared = true;
      toast("命令已执行，但界面状态没对上，请点「刷新」再看一次", true);
    }

    if (pending && Date.now() - pending.at > CMD_TIMEOUT_MS) {
      pending = null;
      cleared = true;
      toast("操作超时，请确认 magpie 里该插件已启用", true);
    }

    // Redraw on a new snapshot or when the in-flight command ended: the
    // controls' enabled state is derived from `pending`, so it has to be
    // repainted for a change there to take effect.
    if (redraw || cleared) render();
  }

  ui.btnApply.addEventListener("click", () => sendCommand("resume", undefined, { paused: false }));
  ui.btnOriginal.addEventListener("click", () => sendCommand("pause", undefined, { paused: true }));
  ui.btnRefresh.addEventListener("click", () => sendCommand("refresh"));
  ui.btnMarket.addEventListener("click", () => {
    marketVisible = MARKET_PAGE;
    sendCommand("market-load");
  });

  ui.btnMore.addEventListener("click", () => {
    marketVisible += MARKET_PAGE;
    renderMarket();
  });

  ui.marketSearch.addEventListener("input", () => {
    marketQuery = ui.marketSearch.value;
    marketVisible = MARKET_PAGE;
    renderMarket();
  });

  // --- edit / delete dialogs ----------------------------------------------
  // <dialog> rather than confirm(): the sandbox grants allow-scripts but not
  // allow-modals, so window.confirm() is blocked and returns nothing.
  ui.editCancel.addEventListener("click", closeEdit);
  ui.editSave.addEventListener("click", saveEdit);
  ui.editFocusX.addEventListener("input", syncFocusLabels);
  ui.editFocusY.addEventListener("input", syncFocusLabels);
  ui.editDialog.addEventListener("close", () => { editingId = null; });
  ui.confirmCancel.addEventListener("click", closeConfirm);
  ui.confirmOk.addEventListener("click", confirmDelete);
  ui.confirmDialog.addEventListener("close", () => { deletingId = null; });

  // Enter inside the name field would submit the <form method="dialog"> and close
  // the sheet without saving; treat it as the save button instead.
  ui.editForm.addEventListener("submit", (event) => {
    event.preventDefault();
    saveEdit();
  });

  (async () => {
    try { await magpie.ready; } catch {}
    await poll();
    setInterval(poll, POLL_MS);
  })();
})();
