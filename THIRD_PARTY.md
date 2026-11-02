# Third-party notices

This project is **unofficial**. It is not affiliated with, endorsed by, or
sponsored by OpenAI. "Codex", "ChatGPT" and their logos are trademarks of their
owners. This repository ships none of their artwork: the launcher icon is copied
at runtime from the copy of Codex already installed on the user's own machine.

## License of this repository: AGPL-3.0-only

`LICENSE` holds the full GNU Affero General Public License v3.0. It applies to the
whole work because `engine/assets/safe-css.js` is a port of an AGPL-3.0 file (see
below). Everything else bundled here is MIT, so replacing that single file with
an independent implementation would let this repository move to MIT.

## Bundled components

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

Modifications, stated as the license requires:

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

### `engine/assets/` — from Codex Dream Skin (MIT)

Upstream: [Fei-Away/Codex-Dream-Skin](https://github.com/Fei-Away/Codex-Dream-Skin).
MIT. Obtained through the community market at [dreamskin.cc](https://dreamskin.cc).

| File | Provenance |
| --- | --- |
| `renderer-inject.js` | **byte-identical** to upstream `windows/assets/renderer-inject.js` (61,079 bytes, SHA-256 match) |
| `dream-skin.css` | the same file's lineage: begins with the upstream v1.5.20 content and continues with ~1.7 KB of later rules (comments reference Codex 26.930, upstream issues #176 and #244), i.e. a newer build than any tag in the public tree |
| `dream-skin-native-shell-compat.css` | same distribution, `@layer theme` shell overrides |
| `dream-skin-community-compat.css` | same distribution, Windows `application-menu` chrome paint |
| `theme.json`, `dream-reference.jpg` | **written for this repository.** The upstream files were removed on purpose: their `theme.json` describes a preset named after a real person and points at `dream-reference.jpg`, which the upstream NOTICE explicitly excludes from its MIT grant. Both are replaced here with original generated artwork. |

### `engine/assets/safe-css.js` — from Codex++ (AGPL-3.0)

A port of the Safe CSS compiler in
[BigPizzaV3/CodexPlusPlus](https://github.com/BigPizzaV3/CodexPlusPlus),
`crates/codex-plus-core/src/dream_skin_package.rs`. Codex++ is AGPL-3.0 as a whole
repository, which is why this repository is too.

Nothing else here comes from Codex++. In particular the skin renderer and its
CSS are **not** Codex++ files; they belong to the Codex Dream Skin project above.
The two projects are unrelated apart from this one ported helper.

## Written for this repository

- `index.mjs`, `worker.mjs`, `page/*`, `launcher/*`
- `engine/scripts/bootstrap-dream-skin.ps1`, `control-dream-skin.ps1`,
  `ensure-injector.ps1`, `watch-codex.ps1`
- `default-theme/*` — generated procedurally from gradients and arcs; no
  characters, photographs or third-party artwork
- `docs/screenshot.png` — the page captured with generated demo data
- `tests/*`

## Bundled themes

`themes/` ships a 14-theme starter library. Thirteen come from the
[dreamskin.cc](https://dreamskin.cc/gallery) community market — each with its author,
version and license recorded, and a link to its own page, in
[themes/PROVENANCE.md](themes/PROVENANCE.md). The fourteenth,
`dream-skin-default`, is generated art written for this repository.

The market has no blanket terms: a package's `manifest.json` `license` field is the
entire statement, and authors fill it in freely (MIT, CC BY, Personal Use, All Rights
Reserved, and in one case literally `1`). Themes that are not licensed for
redistribution are listed in `themes/PROVENANCE.md` with the exact folders to delete
before publishing this repository.

`dream-skin-original` and `glass-vision` have no market record and no
`manifest.json` — they predate the current package format and their origin is not
recorded.

## Deliberately not included

| Excluded | Why |
| --- | --- |
| `chatgpt-tray-*.ico`, `icon-chatgpt.ico` | OpenAI artwork. Bootstrap copies one out of the user's own Codex installation into `%LOCALAPPDATA%` at first run; it is never redistributed here. |
| upstream `assets/dream-reference.jpg` | The upstream NOTICE explicitly excludes it from their MIT grant (third-party likeness), and it is in any case user-supplied artwork. |
| upstream `presets/preset-romantic-rose/*` | Same exclusion: portrait of a real person. |
| Community market themes | Downloaded at runtime by the user from the community service; each carries its own author and license. |

## Runtime downloads

The theme market (`api.dreamskin.cc`, the catalog Codex++ itself uses) is queried
only when the user asks for it, from the user's machine. Package integrity is
verified against the catalog's `packageBytes` and `packageSha256` before a theme
is installed.