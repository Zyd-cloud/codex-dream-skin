/* Codex++ "Safe CSS" compiler — ported verbatim from
   BigPizzaV3/CodexPlusPlus crates/codex-plus-core/src/dream_skin_package.rs

   The package format deliberately forbids `!important`; the client adds it
   only after validation so community rules cannot smuggle arbitrary
   declarations in. Rules may only target parts registered by the Skin API
   ([data-ds-part="..."]) with an optional :hover / :focus-visible suffix. */

const ALLOWED_PARTS = [
  "root", "sidebar", "main", "header", "home", "home-hero",
  "project-list", "thread", "message", "composer", "composer-toolbar", "dialog",
];
const COLOR_PROPERTIES = [
  "color", "background-color", "border-color", "border-top-color",
  "border-right-color", "border-bottom-color", "border-left-color",
];
const WIDTH_PROPERTIES = [
  "border-width", "border-top-width", "border-right-width",
  "border-bottom-width", "border-left-width",
];
const STYLE_PROPERTIES = [
  "border-style", "border-top-style", "border-right-style",
  "border-bottom-style", "border-left-style",
];
const RADIUS_PROPERTIES = [
  "border-radius", "border-top-left-radius", "border-top-right-radius",
  "border-bottom-right-radius", "border-bottom-left-radius",
];
const SPACING_PROPERTIES = ["gap", "row-gap", "column-gap"];

// The ten palette variables the Skin API publishes from theme.colors.
const COLOR_VARIABLES = [
  "--ds-theme-color-background",
  "--ds-theme-color-panel",
  "--ds-theme-color-panel-alt",
  "--ds-theme-color-accent",
  "--ds-theme-color-accent-alt",
  "--ds-theme-color-secondary",
  "--ds-theme-color-highlight",
  "--ds-theme-color-text",
  "--ds-theme-color-muted",
  "--ds-theme-color-line",
];

const CSS_LIMIT = 256 * 1024;
const HEX_COLOR = /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i;
const FUNC_COLOR =
  /^(?:rgba?|hsla?|oklch|oklab|color-mix|hwb|lab|lch)\([^;{}]{1,160}\)$/i;
const CSS_NAMED = new Set([
  "transparent", "currentcolor", "inherit", "initial", "unset", "none",
]);

// Mirrors Codex++ `forbidden_css_character`: C0 controls except tab/LF/FF,
// C1 controls, and bidi/line-separator/BOM characters that can smuggle
// direction changes into the injected cascade.
const FORBIDDEN_RANGES = [
  [0x0000, 0x0008], [0x000b, 0x000b], [0x000e, 0x001f],
  [0x007f, 0x009f], [0x2028, 0x2028], [0x2029, 0x2029],
  [0x200e, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff],
];

function forbiddenCharacter(code) {
  for (const [low, high] of FORBIDDEN_RANGES) {
    if (code >= low && code <= high) return true;
  }
  return false;
}

// Whitespace split that respects parentheses, so `rgba(0, 0, 0, .28)` stays one
// token. Mirrors Codex++ `split_whitespace`.
function splitValues(value) {
  const items = [];
  let start = null;
  let depth = 0;
  const chars = [...value];
  for (let index = 0; index < chars.length; index += 1) {
    const ch = chars[index];
    if (ch === "(") depth += 1;
    if (ch === ")") {
      depth -= 1;
      if (depth < 0) return [];
    }
    if (/\s/.test(ch) && depth === 0) {
      if (start !== null) {
        items.push(cps_join(chars, start, index));
        start = null;
      }
    } else if (start === null) {
      start = index;
    }
  }
  if (depth !== 0) return [];
  if (start !== null) items.push(cps_join(chars, start, chars.length));
  return items;
}

function cps_join(chars, from, to) {
  let out = "";
  for (let i = from; i < to; i += 1) out += chars[i];
  return out;
}

function zeroOrPx(item, min, max) {
  const match = /^(-?\d+(?:\.\d+)?)(px|em|rem|%)?$/.exec(item);
  if (!match) return false;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < min || amount > max) return false;
  // Codex++ only accepts px-less zero or px lengths; em/rem/% are rejected.
  return match[2] === undefined ? amount === 0 : match[2] === "px";
}

function repeatedValues(value, minCount, maxCount, predicate) {
  const items = splitValues(value);
  if (items.length < minCount || items.length > maxCount) return false;
  return items.every(predicate);
}

function validCssColor(value, property) {
  const item = value.trim();
  if (registeredVar(item, COLOR_VARIABLES)) return true;
  if (CSS_NAMED.has(item.toLowerCase())) return true;
  if (HEX_COLOR.test(item)) return true;
  return FUNC_COLOR.test(item);
}

function registeredVar(value, names) {
  const item = value.trim();
  return names.some(
    (name) => item === `var(${name})` || item.startsWith(`var(${name},`),
  );
}

function numeric(value, unit, min, max) {
  const match = new RegExp(`^(-?\\d+(?:\\.\\d+)?)(${unit})?$`).exec(value.trim());
  if (!match) return false;
  const amount = Number(match[1]);
  return Number.isFinite(amount) && amount >= min && amount <= max;
}

// Split on commas that are not inside parentheses, so rgba(0, 0, 0, .28)
// survives as one token. Mirrors Codex++ `split_top_level`.
function splitTopLevel(value) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((item) => item.trim());
}

function validBoxShadow(value) {
  if (value.trim().toLowerCase() === "none") return true;
  if (registeredVar(value, ["--ds-theme-shadow"])) return true;
  const shadows = splitTopLevel(value);
  if (shadows.length < 1 || shadows.length > 2) return false;
  return shadows.every((shadow) => {
    const values = splitValues(shadow);
    if (values.first?.() === "inset" || values[0]?.toLowerCase() === "inset") {
      values.shift();
    }
    if (values.length < 3 || values.length > 5) return false;
    const color = values.pop();
    if (!validCssColor(color, "box-shadow")) return false;
    if (values.length < 2 || values.length > 4) return false;
    if (!zeroOrPx(values[0], -32, 32)) return false;
    if (!zeroOrPx(values[1], -32, 32)) return false;
    if (values[2] !== undefined && !zeroOrPx(values[2], 0, 48)) return false;
    if (values[3] !== undefined && !zeroOrPx(values[3], -8, 16)) return false;
    return true;
  });
}

const TRANSITION_TARGETS = [
  "color", "background-color", "border-color", "border-top-color",
  "border-right-color", "border-bottom-color", "border-left-color",
  "border-width", "border-top-width", "border-right-width",
  "border-bottom-width", "border-left-width", "border-radius",
  "border-top-left-radius", "border-top-right-radius",
  "border-bottom-right-radius", "border-bottom-left-radius",
  "gap", "row-gap", "column-gap", "box-shadow", "opacity",
  "backdrop-filter", "font-size", "font-weight", "line-height",
  "letter-spacing",
];

function validTransitionProperty(value) {
  const items = splitTopLevel(value);
  return (
    items.length > 0 &&
    items.length <= 4 &&
    items.every((item) => TRANSITION_TARGETS.includes(item.toLowerCase()))
  );
}

function validTransitionDuration(value) {
  const items = splitTopLevel(value);
  return (
    items.length > 0 &&
    items.length <= 4 &&
    items.every(
      (item) =>
        item === "0" || numeric(item, "ms", 0, 400) || numeric(item, "s", 0, 0.4),
    )
  );
}

function validBackdropFilter(value) {
  const item = value.trim().toLowerCase();
  if (item === "none") return true;
  const match = /^blur\((\d+(?:\.\d+)?)px\)$/.exec(item);
  if (!match) return false;
  const amount = Number(match[1]);
  return amount >= 0 && amount <= 24;
}

function validFontFamily(value) {
  const item = value.trim();
  if (!item || item.length > 200) return false;
  if (/[<>{};]/.test(item)) return false;
  return true;
}

function validatePropertyValue(property, value) {
  if (COLOR_PROPERTIES.includes(property)) return validCssColor(value, property);
  if (WIDTH_PROPERTIES.includes(property)) {
    return repeatedValues(value, 1, 4, (item) => zeroOrPx(item, 0, 4));
  }
  if (STYLE_PROPERTIES.includes(property)) {
    return repeatedValues(value, 1, 4, (item) =>
      ["none", "solid", "dashed", "dotted"].includes(item.toLowerCase()),
    );
  }
  if (RADIUS_PROPERTIES.includes(property)) {
    return (
      registeredVar(value, ["--ds-theme-surface-radius"]) ||
      repeatedValues(value, 1, 4, (item) => zeroOrPx(item, 0, 28))
    );
  }
  if (SPACING_PROPERTIES.includes(property)) return zeroOrPx(value, 0, 24);
  switch (property) {
    case "box-shadow":
      return validBoxShadow(value);
    case "opacity":
      return (
        registeredVar(value, ["--ds-theme-surface-opacity"]) ||
        numeric(value, "", 0.65, 1)
      );
    case "backdrop-filter":
      return validBackdropFilter(value);
    case "font-family":
      return validFontFamily(value);
    case "font-size":
      return numeric(value, "px", 12, 20);
    case "transition-property":
      return validTransitionProperty(value);
    case "transition-duration":
      return validTransitionDuration(value);
    case "background-image":
      return value.trim().toLowerCase() === "none";
    case "text-align":
      return ["left", "center", "right", "justify"].includes(value.trim().toLowerCase());
    case "font-weight":
      return ["400", "500", "600", "700", "normal", "bold"].includes(
        value.trim().toLowerCase(),
      );
    case "letter-spacing":
      return value.trim() === "0" || numeric(value, "px", 0, 2);
    case "line-height":
      return numeric(value, "", 1.1, 1.8);
    default:
      return false;
  }
}

export function parseSafeCss(css) {
  if (!css || css.length > CSS_LIMIT) {
    throw new Error("theme.css 为空或超过 256 KiB 限制");
  }
  if ([...css].some((ch) => forbiddenCharacter(ch.codePointAt(0)))) {
    throw new Error("theme.css 包含不允许的控制字符");
  }
  if (css.includes("/*") || css.includes("*/") || css.includes("\\")) {
    throw new Error("theme.css 包含不允许的注释或转义");
  }
  const rules = [];
  let declarations = 0;
  let rest = css;
  for (;;) {
    rest = rest.replace(/^[\s\u000c]+/, "");
    if (!rest) break;
    const open = rest.indexOf("{");
    if (open < 0) throw new Error("theme.css 规则缺少开始括号");
    const selector = rest.slice(0, open).trim();
    const closeOffset = rest.slice(open + 1).indexOf("}");
    if (closeOffset < 0) throw new Error("theme.css 规则缺少结束括号");
    const close = open + 1 + closeOffset;
    const nested = rest.slice(open + 1).indexOf("{");
    if (
      !selector ||
      /[,@;}]/.test(selector) ||
      (nested >= 0 && nested < closeOffset)
    ) {
      throw new Error("theme.css 选择器或规则语法无效");
    }
    const prefix = '[data-ds-part="';
    if (!selector.startsWith(prefix)) {
      throw new Error("theme.css 只能选择 Skin API 注册的 data-ds-part");
    }
    const afterPrefix = selector.slice(prefix.length);
    const split = afterPrefix.indexOf('"]');
    if (split < 0) throw new Error("theme.css data-ds-part 语法无效");
    const part = afterPrefix.slice(0, split);
    const suffix = afterPrefix.slice(split + 2);
    if (
      !ALLOWED_PARTS.includes(part) ||
      (suffix !== "" && suffix !== ":hover" && suffix !== ":focus-visible")
    ) {
      throw new Error("theme.css 使用了未注册的 Skin API part 或状态");
    }
    const seen = new Set();
    const parsedDeclarations = [];
    for (const declaration of rest
      .slice(open + 1, close)
      .split(";")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)) {
      const colon = declaration.indexOf(":");
      if (colon < 0) throw new Error("theme.css 声明语法无效");
      const property = declaration.slice(0, colon).trim();
      const value = declaration.slice(colon + 1).trim();
      if (
        !/^[a-z]+(?:-[a-z]+)*$/.test(property) ||
        !seen.has(property) === false
      ) {
        throw new Error(`theme.css CSS 属性无效或重复：${property}`);
      }
      if (seen.has(property)) {
        throw new Error(`theme.css CSS 属性无效或重复：${property}`);
      }
      seen.add(property);
      if (
        !value ||
        value.length > 512 ||
        /[{}<>!;]/.test(value) ||
        !validatePropertyValue(property, value)
      ) {
        throw new Error(`theme.css 属性值不受 Safe CSS 支持：${property}`);
      }
      parsedDeclarations.push([property, value]);
      declarations += 1;
    }
    if (parsedDeclarations.length === 0) {
      throw new Error("theme.css 规则不能为空");
    }
    rules.push({ part, selector, declarations: parsedDeclarations });
    rest = rest.slice(close + 1);
  }
  if (rules.length === 0) throw new Error("theme.css 没有任何规则");
  if (declarations > 512) throw new Error("theme.css 声明数量超过限制");
  return rules;
}

export function compileSafeCss(css) {
  const rules = parseSafeCss(css);
  const composerBaseBorders = new Set(
    rules
      .filter((rule) => rule.part === "composer" && !rule.selector.includes(":"))
      .flatMap((rule) => rule.declarations.map(([property]) => property))
      .filter(
        (property) =>
          property.startsWith("border-") &&
          (property.endsWith("color") ||
            property.endsWith("width") ||
            property.endsWith("style")),
      ),
  );
  let compiled = "@layer dreamskin-community {\n";
  for (const rule of rules) {
    compiled += `  ${rule.selector} {\n`;
    for (const [property, value] of rule.declarations) {
      compiled += `    ${property}: ${value} !important;\n`;
      if (rule.part === "composer" && composerBaseBorders.has(property)) {
        compiled += `    --ds-community-composer-${property}: ${value} !important;\n`;
      }
      if (
        property === "background-color" &&
        ["sidebar", "main", "home"].includes(rule.part)
      ) {
        compiled += "    background-image: none !important;\n";
      }
    }
    compiled += "  }\n";
  }
  compiled += "}\n";
  return compiled;
}
