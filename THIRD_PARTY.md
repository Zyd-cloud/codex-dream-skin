# Third-party notices

This project is **unofficial**. It is not affiliated with, endorsed by, or
sponsored by OpenAI. "Codex", "ChatGPT" and their logos are trademarks of their
owners. This repository ships none of their artwork: the launcher icon is copied
at runtime from the copy of Codex already installed on the user's own machine.

## License of this repository: AGPL-3.0-only

`LICENSE` holds the full GNU Affero General Public License v3.0. It applies to
the whole work, because the skin renderer bundled here is AGPL-3.0.

## Bundled components

### `engine/assets/` — from Codex++ (AGPL-3.0)

| File | Upstream |
| --- | --- |
| `dream-skin.css` | [BigPizzaV3/CodexPlusPlus](https://github.com/BigPizzaV3/CodexPlusPlus) |
| `renderer-inject.js` | same |
| `safe-css.js` | same — the Safe CSS compiler, ported from the Rust side |
| `dream-skin-native-shell-compat.css` | same |
| `dream-skin-community-compat.css` | same |

These were taken from Codex++ and are redistributed here under AGPL-3.0, the
same license the upstream project uses. If you build on this repository, the
AGPL obligations travel with them.

### `engine/scripts/` — from Codex Dream Skin (MIT), with modifications

Upstream: [axdlee/Codex-Dream-Skin](https://github.com/axdlee/Codex-Dream-Skin),
`windows/` tree. MIT, Copyright (c) 2026 Codex Dream Skin Studio contributors.

| File | State |
| --- | --- |
| `common-windows.ps1` | unmodified |
| `config-utf8.ps1` | unmodified |
| `image-metadata.mjs` | unmodified |
| `injector.mjs` | **modified** (see below) |
| `theme-windows.ps1` | **modified** (see below) |

Modifications, as AGPL-3.0 requires being stated:

- `injector.mjs` — accepted `safeArea` values narrowed to `left | right | none`
  and `taskMode` to `ambient | full | off`; `probeSession` additionally requires
  `document.readyState === "complete"` before a page counts as ready; the probe
  runs before the early payload is registered; `runWatch` re-anchors to a new
  browser identity instead of exiting when Codex restarts.
- `theme-windows.ps1` — the block that re-created a bundled preset on every run
  was removed, so a theme the user deleted stays deleted.

The upstream standalone entry points (`start-`, `restore-`, `install-`,
`verify-`, `tray-dream-skin.ps1`) are **not** included: this plugin drives the
engine through its own scripts instead.

## Written for this repository

- `index.mjs`, `worker.mjs`, `page/*`, `launcher/*`
- `engine/scripts/bootstrap-dream-skin.ps1`, `control-dream-skin.ps1`,
  `ensure-injector.ps1`, `watch-codex.ps1`
- `default-theme/background.jpg` — generated procedurally for this repository
  from gradients and arcs; contains no characters, photographs or third-party
  artwork.

## Deliberately not included

| Excluded | Why |
| --- | --- |
| `chatgpt-tray-*.ico`, `icon-chatgpt.ico` | OpenAI artwork. Bootstrap copies one out of the user's own Codex installation into `%LOCALAPPDATA%` at first run; it is never redistributed here. |
| `assets/dream-reference.jpg` | The upstream NOTICE explicitly excludes it from their MIT grant (third-party likeness), and it is in any case user-supplied artwork. |
| `presets/preset-romantic-rose/*` | Same exclusion upstream: portrait of a real person. |
| Community market themes | Downloaded at runtime by the user from the community service; each carries its own author and license. |

## Runtime downloads

The theme market (`api.dreamskin.cc`, the catalog Codex++ itself uses) is queried
only when the user asks for it, from the user's machine. Package integrity is
verified against the catalog's `packageBytes` and `packageSha256` before a theme
is installed.