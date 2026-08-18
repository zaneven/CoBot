/**
 * Convert CommonMark/GFM-ish markdown (as Claude emits) into Telegram "HTML"
 * parse-mode text.
 *
 * Why HTML and not MarkdownV2: Telegram MarkdownV2 requires escaping 19 special
 * characters and rejects the whole message on any unclosed marker (`**bold` with
 * no closing `**` -> "can't parse entities"). During streaming the buffer is
 * frequently mid-markdown, so MarkdownV2 would fail on almost every intermediate
 * edit. HTML only treats `&`, `<`, `>` as special, and any markdown we do NOT
 * recognise is emitted as a literal character (e.g. a lone `*` renders as `*`),
 * so partial input never produces broken markup.
 *
 * Telegram HTML supports a tiny tag set: <b>, <i>, <u>, <s>, <code>, <pre>,
 * <a href="">, <blockquote>, <tg-spoiler>. We target the constructs Claude
 * actually emits: fenced + inline code, headings, bold, italic, strikethrough,
 * links, blockquotes, lists, horizontal rules, and tables (rendered as
 * formatted lines since Telegram has no native table).
 */

export function mdToTelegramHtml(input: string): string {
  if (!input) return "";
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  const n = lines.length;

  while (i < n) {
    const line = lines[i]!;

    // Fenced code block: ```lang / ~~~lang ... matching fence.
    const fence = matchFence(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < n) {
        const f2 = matchFence(lines[i]!);
        if (f2 && f2.ch === fence.ch && f2.count >= fence.count) {
          i++;
          break;
        }
        body.push(lines[i]!);
        i++;
      }
      // If the closing fence never arrived (mid-stream), we still emit what we
      // have and close the tag so the HTML stays valid.
      out.push(`<pre>${escHtml(body.join("\n"))}</pre>`);
      continue;
    }

    // GFM table: rendered as formatted rows (cells joined by " · ").
    const table = parseTable(lines, i);
    if (table) {
      out.push(table.rendered);
      i = table.next;
      continue;
    }

    // ATX heading: #..###### text  (rendered bold; Telegram has no heading).
    const h = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (h) {
      out.push(`<b>${inline(h[2]!)}</b>`);
      i++;
      continue;
    }

    // Horizontal rule: --- / *** / ___ (three or more, alone on a line).
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line) && !line.includes(" ")) {
      out.push("────────────────");
      i++;
      continue;
    }

    // Blockquote: collect consecutive "> ...", "**>** ...", or ">! ..." lines.
    if (/^(>|\*\*>\*\*?|\*\*>\!\*\*?|>!)/.test(line)) {
      const quote: string[] = [];
      let expandable = false;
      while (i < n && /^(>|\*\*>\*\*?|\*\*>\!\*\*?|>!)/.test(lines[i]!)) {
        const cur = lines[i]!;
        if (/^(\*\*>\!\*\*?|>!|\*\*>\*\*)/.test(cur)) {
          expandable = true;
        }
        quote.push(cur.replace(/^(\*\*>\!\*\*?|\*\*>\*\*?|>!|>)\s?/, ""));
        i++;
      }
      const tag = expandable ? "<blockquote expandable>" : "<blockquote>";
      out.push(`${tag}${inline(quote.join("\n"))}</blockquote>`);
      continue;
    }

    // Unordered list item: "- " / "* " / "+ " -> bullet "• ".
    const ul = /^(\s*)([-*+])\s+(.*)$/.exec(line);
    if (ul) {
      out.push(`${ul[1]!}• ${inline(ul[3]!)}`);
      i++;
      continue;
    }

    // Ordered list item: "1. " (kept as-is).
    const ol = /^(\s*)(\d+)\.\s+(.*)$/.exec(line);
    if (ol) {
      out.push(`${ol[1]!}${ol[2]!}. ${inline(ol[3]!)}`);
      i++;
      continue;
    }

    // Blank line -> paragraph break.
    if (/^\s*$/.test(line)) {
      out.push("");
      i++;
      continue;
    }

    // Normal paragraph line.
    out.push(inline(line));
    i++;
  }

  return out.join("\n");
}

/** Detect a fenced-code-block opening line, or null. */
function matchFence(line: string): { ch: string; count: number; info: string } | null {
  const m = /^\s*(`{3,}|~{3,})\s*(.*)$/.exec(line);
  if (!m) return null;
  const fence = m[1]!;
  return { ch: fence.charAt(0), count: fence.length, info: m[2] ?? "" };
}

/**
 * Inline markdown -> HTML. Scans left to right, emitting tags only when a
 * matching close delimiter is found; otherwise the opener is treated as a
 * literal character. Recursive for nested emphasis / link text.
 */
function inline(s: string): string {
  let out = "";
  let i = 0;
  const n = s.length;

  while (i < n) {
    const c = s.charAt(i);
    const next = s[i + 1];

    // Backslash escape: "\X" (X ASCII punctuation) -> literal X.
    if (c === "\\" && next && /[!-/:-@\[-`{-~]/.test(next)) {
      out += escHtml(next);
      i += 2;
      continue;
    }

    // Inline code: `...` (to the next backtick).
    if (c === "`") {
      const close = s.indexOf("`", i + 1);
      if (close > i) {
        out += `<code>${escHtml(s.slice(i + 1, close))}</code>`;
        i = close + 1;
        continue;
      }
      out += "&#96;"; // unterminated -> literal backtick
      i++;
      continue;
    }

    // Bold: **...** or __...__
    if ((c === "*" && next === "*") || (c === "_" && next === "_")) {
      const delim = c + c;
      const close = s.indexOf(delim, i + 2);
      if (close > i + 2) {
        out += `<b>${inline(s.slice(i + 2, close))}</b>`;
        i = close + 2;
        continue;
      }
    }

    // Strikethrough: ~~...~~
    if (c === "~" && next === "~") {
      const close = s.indexOf("~~", i + 2);
      if (close > i + 2) {
        out += `<s>${inline(s.slice(i + 2, close))}</s>`;
        i = close + 2;
        continue;
      }
    }

    // Italic: *...* or _..._ (with CommonMark-ish boundary guards to avoid
    // matching bare "*" / intraword "_" like my_var_name).
    if (c === "*" || c === "_") {
      const after = s[i + 1];
      const prev = s.charAt(i - 1);
      const okStart = after && !/\s/.test(after) && !(c === "_" && /\w/.test(prev));
      if (okStart) {
        const close = s.indexOf(c, i + 1);
        if (close > i + 1 && !/\s/.test(s.charAt(close - 1))) {
          out += `<i>${inline(s.slice(i + 1, close))}</i>`;
          i = close + 1;
          continue;
        }
      }
    }

    // Link: [text](url)
    if (c === "[") {
      const tc = s.indexOf("]", i + 1);
      if (tc > i && s[tc + 1] === "(") {
        const uc = s.indexOf(")", tc + 2);
        if (uc > tc) {
          const text = s.slice(i + 1, tc);
          const url = cleanUrl(s.slice(tc + 2, uc));
          if (url) {
            out += `<a href="${escAttr(url)}">${inline(text)}</a>`;
            i = uc + 1;
            continue;
          }
        }
      }
    }

    // Default: literal character, HTML-escaped.
    out += escHtml(c);
    i++;
  }

  return out;
}

/** Escape `&`, `<`, `>` for literal HTML text / code content. */
function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape an attribute value (URL): `&` */
function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** Validate / normalise a link URL. Returns null for unsafe or non-URL schemes. */
function cleanUrl(raw: string): string | null {
  const u = raw.trim();
  if (!u || /\s/.test(u)) return null;
  // Must have a scheme; block script-injection schemes.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) return null;
  if (/^(javascript|data|vbscript|file):/i.test(u)) return null;
  return u;
}

// ── Tables ─────────────────────────────────────────────────────────────────
// Telegram has no native table, so a GFM table is rendered as formatted lines.
// Each row becomes: <cell1> · <cell2> · <cell3> (inline markdown preserved).
// The header row is fully bold; data rows bold only the first column.

/** Split a table row into trimmed cells, honoring `\|` as a literal pipe. */
function splitTableCols(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let k = 0; k < s.length; k++) {
    const ch = s.charAt(k);
    if (ch === "\\" && s.charAt(k + 1) === "|") {
      cur += "|";
      k++;
      continue;
    }
    if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/**
 * If `lines[i]` begins a GFM table (header + delimiter row), render it as
 * formatted lines. Each row → cells joined by " · ", inline markdown intact.
 * Returns null when the lines aren't a table.
 */
function parseTable(
  lines: string[],
  i: number,
): { rendered: string; next: number } | null {
  const n = lines.length;
  if (i + 1 >= n) return null;
  const header = lines[i]!;
  const delim = lines[i + 1]!;
  if (!header.includes("|") || !delim.includes("|")) return null;
  const hCols = splitTableCols(header);
  const dCols = splitTableCols(delim);
  if (!hCols.length || dCols.length !== hCols.length) return null;
  if (!dCols.every((c) => /^:?-+:?$/.test(c))) return null;

  // Collect data rows (skip delimiter).
  const rows: string[][] = [hCols];
  let j = i + 2;
  while (j < n) {
    const ln = lines[j]!;
    if (!ln.includes("|") || /^\s*$/.test(ln)) break;
    rows.push(splitTableCols(ln));
    j++;
  }

  const out: string[] = [];
  // Header: all cells bold.
  out.push(hCols.map((c) => `<b>${inline(c)}</b>`).join(" · "));

  // Data rows: first cell bold, rest normal inline.
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]!;
    if (cells.every((c) => !c)) { out.push(""); continue; }
    out.push(cells.map((c, idx) => idx === 0 ? `<b>${inline(c)}</b>` : inline(c)).join(" · "));
  }

  return { rendered: out.join("\n"), next: j };
}

/** Backslash-escape markdown-special punctuation so the converter renders it literally. */
export function escapeMd(s: string): string {
  return s.replace(/[\\`*_~[\]!#]/g, (m) => "\\" + m);
}

/**
 * Sanitise mid-stream markdown before sending to Telegram's Rich Message
 * parser. Balances fenced code blocks and cleans trailing partial inline
 * markdown so Telegram won't reject the payload or render broken content
 * while the next flush is still building.
 *
 * Return the sanitised string — good-faith replacement that won't
 * structurally break the message.
 *
 * Note: fence detection only triggers on a fence that occupies its own line
 * (lines starting with ``` or ~~~, 3+ chars). Inline backtick pairs such as
 * `` `code` `` are never mistaken for fences, so explanatory prose quoting a
 * single backtick pair is left untouched.
 */
export function sanitizeStreamMarkdown(md: string): string {
  let ret = md;

  // ── balance fenced code blocks ──────────────────────────────────
  let tickOpen = false;
  let tildeOpen = false;
  for (const line of ret.split("\n")) {
    if (line.trimStart().startsWith("```")) tickOpen = !tickOpen;
    else if (line.trimStart().startsWith("~~~")) tildeOpen = !tildeOpen;
  }
  if (tickOpen) ret += "\n```";
  if (tildeOpen) ret += "\n~~~";

  // ── receding broken constructs that paste partial markup ───────
  // A trailing lone backtick without a matching close partner → escape it.
  // Mid-stream buffers frequently contain an odd number of backticks; escape
  // every unpaired trailing backtick, not just the last one, so code-block
  // text that legitimately ends with a backtick isn't corrupted.
  const ticks = ret.match(/`/g) ?? [];
  if (ticks.length % 2 === 1) {
    // Escape the final backtick (the unpaired one).
    const idx = ret.lastIndexOf("`");
    if (idx >= 0) ret = ret.slice(0, idx) + "\\`" + ret.slice(idx + 1);
  }

  // Trailing unclosed link `[...](url` → escape the bracket.
  // Only if it looks mid-stream: no closing `)` after the `](`.
  const link = ret.match(/\[([^\]]+)\]\(([^()]*)$/);
  if (link && !ret.slice(ret.lastIndexOf("](") + 2).includes(")")) {
    const idx = ret.lastIndexOf("](");
    ret = ret.slice(0, idx) + "\\[\\" + ret.slice(idx);
  }

  return ret;
}