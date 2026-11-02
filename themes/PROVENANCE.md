# Bundled themes — provenance

`themes/` ships a starter library so a fresh install opens with themes to
browse instead of an empty grid. Every folder is a complete theme package
(`theme.json`, `theme.css`, one background image, and — for market packages — a
`manifest.json`).

Source of every market theme: **[dreamskin.cc](https://dreamskin.cc/gallery)**, the
community catalog this plugin also downloads from. The link on each row opens the
theme's own page there, which shows the author, version and license.

| Theme | Name | Author | License | Source |
| --- | --- | --- | --- | --- |
| `b-5` ¹ | 慵懒温存 | xxxdgonb马来西亚 | `DGON` | [ver_753c0d…](https://dreamskin.cc/themes/ver_753c0d2623b35e980e71) |
| `chatgpt-2026-10-20-22-47-18` | ChatGPT 图像 2026年10月20日 22 47 18 | youarep1g7 | **MIT** | [ver_ac0907…](https://dreamskin.cc/themes/ver_ac09076d97ef7a2545a4) |
| `codex-ice-blue` | Codex · 冰蓝矩阵 | thinktoomuch7 | **All Rights Reserved** | [ver_728953…](https://dreamskin.cc/themes/ver_728953d407991b927ef7) |
| `codex-shell-paper` | 纸墨 | naomikeee | **CC-BY-4.0 AND MIT** | [ver_25b1dc…](https://dreamskin.cc/themes/ver_25b1dc6199cb16a61eee) |
| `dream-skin-default` | Dream Skin Default | this plugin | AGPL-3.0-only | generated here |
| `dream-skin-original` ¹ | Dream Skin 原版 | — | unknown | no market record |
| `firefly-sunny-sea-20261027` | 流萤·与你晴海 | 莫 | **Personal Use** | [ver_55851f…](https://dreamskin.cc/themes/ver_55851f0b5f9930880d08) |
| `glass-vision` ¹ | Glass Vision | — | unknown | no market record |
| `renminwansui` | 中华人民共和国万岁 | 安德森 | `1` ² | [ver_dc9f70…](https://dreamskin.cc/themes/ver_dc9f7033af6a2e0ff39b) |
| `seabreeze-jadeink` | 海风翡翠_青墨 | Wachyon | **MIT** | [ver_e2dda4…](https://dreamskin.cc/themes/ver_e2dda4c152706d173ac9) |
| `waves-summer-rendezvous-20261027` | 浪花赴约 | 莫 | **Personal Use** | [ver_526554…](https://dreamskin.cc/themes/ver_5265548d994dcbd32197) |
| `xishi` | 西施 | Belate | **MIT** | [ver_609616…](https://dreamskin.cc/themes/ver_609616992e0d8f5371ae) |
| `zafa` ¹ | 夏日+扎发 | liuj | **MIT** | [ver_8241a6…](https://dreamskin.cc/themes/ver_8241a6a61d632d797901) |
| `z-hou-qingmei` | 周青眉 | Lim Yan | **All Rights Reserved** | [ver_80340c…](https://dreamskin.cc/themes/ver_80340c7c5cc9b6182d39) |

¹ Older package format: no `manifest.json`, the background is `image.*` instead
of `background.*`. The engine reads `theme.json`'s `image` field, so they install
and apply normally; they simply predate the manifest spec the market now expects.

² `renminwansui`'s license field reads `1` — a value its author typed by hand.
Treat it as "no usable license statement".

## Default theme

`z-hou-qingmei` is the theme this build activates on a fresh install — see
`-DefaultThemeId` in `engine/scripts/bootstrap-dream-skin.ps1`, which is
passed `z-hou-qingmei` by `worker.mjs`. It applies only on the run that seeds
the library, so a user who later picks another theme is not switched back.

If you remove this folder (it is one of the themes whose license does not permit
redistribution), also clear `-DefaultThemeId`; bootstrap then leaves the engine's
own initial theme active and nothing breaks.

## What this means for redistribution

The market has **no blanket terms**: `/docs` states that `LICENSE.txt` inside a
package is reserved and unused, so each theme's `manifest.json` `license` field is
the whole statement, and authors fill it in freely.

Reading the table:

- **MIT** — reusable with attribution. (`xishi`, `zafa`, `chatgpt-2026-10-20…`)
- **CC-BY-4.0 AND MIT** — reusable with attribution. (`codex-shell-paper`)
- **Personal Use / All Rights Reserved / `DGON` / `1` / unknown** — **bundled here
  for convenience, not licensed for redistribution**: `b-5`, `codex-ice-blue`,
  `dream-skin-original`, `firefly-sunny-sea-20261027`, `glass-vision`,
  `renminwansui`, `waves-summer-rendezvous-20261027`, `z-hou-qingmei`.

If this repository is ever published, delete the folder for any theme whose
license does not permit it. Removing a theme is just deleting its directory; the
plugin seeds whatever is present and nothing references a fixed set.

`dream-skin-default` is the only theme written for this repository: gradients and
arcs generated procedurally, no characters or photographs.

## Credit

Market themes belong to their authors, credited in the table above and on their
`dreamskin.cc` pages. Themes are downloaded and applied by the user; this plugin
verifies a package's size and SHA-256 against the catalog before installing it and
changes nothing inside the package.