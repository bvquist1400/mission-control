/**
 * A small Markdown parser for record pages (/r/[kind]/[id]).
 *
 * It covers what agents and Brent actually write in Baseline notes and task
 * descriptions: headings, paragraphs, bold/italic/strikethrough, inline code,
 * fenced code, links and bare URLs, bullet/numbered/task lists (nested),
 * blockquotes, rules and GFM pipe tables. It returns a plain tree that the
 * React renderer walks, so no HTML string is ever injected: raw HTML in the
 * source renders as text, and links are limited to http(s), mailto and
 * same-site paths.
 *
 * Single newlines inside a paragraph become line breaks (as in GitHub
 * comments), because that's how these notes are written.
 */

export type MdInline =
  | { type: "text"; value: string }
  | { type: "strong"; children: MdInline[] }
  | { type: "em"; children: MdInline[] }
  | { type: "del"; children: MdInline[] }
  | { type: "code"; value: string }
  | { type: "link"; href: string; children: MdInline[] }
  | { type: "br" };

export type MdAlign = "left" | "center" | "right" | null;

export interface MdListItem {
  /** null for a plain item; true/false for a "- [x]" / "- [ ]" task item. */
  checked: boolean | null;
  children: MdBlock[];
}

export type MdBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: MdInline[] }
  | { type: "paragraph"; children: MdInline[] }
  | { type: "code"; lang: string | null; value: string }
  | { type: "blockquote"; children: MdBlock[] }
  | { type: "list"; ordered: boolean; start: number; items: MdListItem[] }
  | { type: "table"; align: MdAlign[]; header: MdInline[][]; rows: MdInline[][][] }
  | { type: "hr" };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const EMPTY_LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const TASK_BOX = /^\[([ xX])\]\s+/;

/** Nesting deeper than this renders the rest as plain paragraphs (no runaway recursion). */
const MAX_DEPTH = 12;

function indentWidth(line: string): number {
  let width = 0;
  for (const ch of line) {
    if (ch === " ") width += 1;
    else if (ch === "\t") width += 4 - (width % 4);
    else break;
  }
  return width;
}

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

function isTableStart(lines: string[], i: number): boolean {
  return (
    i + 1 < lines.length &&
    lines[i].includes("|") &&
    TABLE_SEPARATOR.test(lines[i + 1]) &&
    lines[i + 1].includes("-")
  );
}

/** A line that begins a block other than a paragraph (so it ends the paragraph above it). */
function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i];
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    HR.test(line) ||
    QUOTE.test(line) ||
    LIST_ITEM.test(line) ||
    isTableStart(lines, i)
  );
}

function splitTableRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  for (let k = 0; k < row.length; k += 1) {
    const ch = row[k];
    if (ch === "\\" && row[k + 1] === "|") {
      current += "|";
      k += 1;
    } else if (ch === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseAlign(cell: string): MdAlign {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

function dedent(lines: string[], amount: number): string[] {
  return lines.map((line) => {
    let removed = 0;
    let k = 0;
    while (k < line.length && removed < amount) {
      if (line[k] === " ") removed += 1;
      else if (line[k] === "\t") removed += 4;
      else break;
      k += 1;
    }
    return line.slice(k);
  });
}

function parseList(lines: string[], start: number, depth: number): { block: MdBlock; next: number } {
  const first = LIST_ITEM.exec(lines[start]) ?? EMPTY_LIST_ITEM.exec(lines[start]);
  const baseIndent = indentWidth(lines[start]);
  const ordered = first ? /\d/.test(first[2]) : false;
  const startNumber = ordered && first ? Number.parseInt(first[2], 10) : 1;
  const items: MdListItem[] = [];
  let i = start;

  while (i < lines.length) {
    const match = LIST_ITEM.exec(lines[i]) ?? EMPTY_LIST_ITEM.exec(lines[i]);
    if (!match || indentWidth(lines[i]) !== baseIndent || /\d/.test(match[2]) !== ordered) break;

    let text = match[3] ?? "";
    let checked: boolean | null = null;
    const box = TASK_BOX.exec(text);
    if (box) {
      checked = box[1] !== " ";
      text = text.slice(box[0].length);
    } else if (/^\[([ xX])\]$/.test(text.trim())) {
      checked = text.trim() !== "[ ]";
      text = "";
    }

    const itemLines = [text];
    i += 1;
    // Lines indented past the marker belong to this item (nested lists, extra
    // paragraphs); unindented lines that don't start a block are lazy
    // continuations of the item's first paragraph.
    const childLines: string[] = [];
    while (i < lines.length) {
      const line = lines[i];
      if (isBlank(line)) {
        const nextContent = lines.slice(i + 1).findIndex((l) => !isBlank(l));
        const nextLine = nextContent === -1 ? null : lines[i + 1 + nextContent];
        if (nextLine !== null && indentWidth(nextLine) > baseIndent) {
          childLines.push("");
          i += 1;
          continue;
        }
        break;
      }
      if (indentWidth(line) > baseIndent) {
        childLines.push(line);
        i += 1;
        continue;
      }
      if (childLines.length === 0 && !startsBlock(lines, i)) {
        itemLines[0] = `${itemLines[0]}\n${line.trim()}`;
        i += 1;
        continue;
      }
      break;
    }

    if (childLines.length > 0) {
      const minIndent = Math.min(...childLines.filter((l) => !isBlank(l)).map(indentWidth));
      itemLines.push(...dedent(childLines, minIndent));
    }

    const children = itemLines.join("\n").trim().length > 0 ? parseBlocks(itemLines, depth + 1) : [];
    items.push({ checked, children });

    // A blank line between items of the same list keeps the list going.
    if (i < lines.length && isBlank(lines[i])) {
      const nextContent = lines.slice(i).findIndex((l) => !isBlank(l));
      if (nextContent !== -1) {
        const candidate = i + nextContent;
        const again = LIST_ITEM.exec(lines[candidate]);
        if (again && indentWidth(lines[candidate]) === baseIndent && /\d/.test(again[2]) === ordered) {
          i = candidate;
        }
      }
    }
  }

  return { block: { type: "list", ordered, start: startNumber, items }, next: i };
}

function parseBlocks(lines: string[], depth: number): MdBlock[] {
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) {
      i += 1;
      continue;
    }

    if (depth >= MAX_DEPTH) {
      blocks.push({ type: "paragraph", children: parseInline(lines.slice(i).join("\n").trim()) });
      break;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence (or end of input)
      blocks.push({ type: "code", lang: fence[2] || null, value: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        children: parseInline(heading[2] ?? ""),
      });
      i += 1;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && !isBlank(lines[i])) {
        body.push(lines[i].replace(QUOTE, ""));
        i += 1;
      }
      blocks.push({ type: "blockquote", children: parseBlocks(body, depth + 1) });
      continue;
    }

    if (isTableStart(lines, i)) {
      const header = splitTableRow(lines[i]);
      const align = splitTableRow(lines[i + 1]).map(parseAlign);
      const rows: MdInline[][][] = [];
      i += 2;
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes("|")) {
        const cells = splitTableRow(lines[i]);
        rows.push(header.map((_, c) => parseInline(cells[c] ?? "")));
        i += 1;
      }
      blocks.push({
        type: "table",
        align: header.map((_, c) => align[c] ?? null),
        header: header.map((cell) => parseInline(cell)),
        rows,
      });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const { block, next } = parseList(lines, i, depth);
      blocks.push(block);
      i = next;
      continue;
    }

    const body: string[] = [line.trim()];
    i += 1;
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines, i)) {
      body.push(lines[i].trim());
      i += 1;
    }
    blocks.push({ type: "paragraph", children: parseInline(body.join("\n")) });
  }

  return blocks;
}

export function parseMarkdown(source: string | null | undefined): MdBlock[] {
  if (!source) return [];
  return parseBlocks(source.replace(/\r\n?/g, "\n").split("\n"), 0);
}

/** Only these reach an href; anything else (javascript:, data:, …) stays text. */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (/^(https?:|mailto:)/i.test(href)) return href;
  // "//host" and "/\host" are protocol-relative in browsers ("\" is read as "/").
  if (href.startsWith("/") && href[1] !== "/" && href[1] !== "\\") return href;
  if (href.startsWith("#")) return href;
  return null;
}

const ESCAPABLE = "\\`*_{}[]()#+-.!|~<>";
const BARE_URL = /^https?:\/\/[^\s<>]+/i;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

/** Finds a closing delimiter for emphasis: not preceded by whitespace, not empty. */
function findClose(s: string, from: number, delim: string): number {
  let k = from;
  while (k < s.length) {
    const at = s.indexOf(delim, k);
    if (at === -1) return -1;
    if (at > from && !/\s/.test(s[at - 1]) && s[at - 1] !== "\\") {
      // For single "*"/"_", skip a "**"/"__" run so "*a **b** c*" nests.
      if (delim.length === 1 && s[at + 1] === delim) {
        const pairClose = s.indexOf(delim + delim, at + 2);
        if (pairClose !== -1) {
          k = pairClose + 2;
          continue;
        }
      }
      if (delim === "_" && isWordChar(s[at + 1])) {
        k = at + 1;
        continue;
      }
      return at;
    }
    k = at + delim.length;
  }
  return -1;
}

export function parseInline(source: string): MdInline[] {
  const out: MdInline[] = [];
  let text = "";
  const flush = () => {
    if (text) {
      out.push({ type: "text", value: text });
      text = "";
    }
  };

  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const rest = source.slice(i);

    if (ch === "\\" && i + 1 < source.length && ESCAPABLE.includes(source[i + 1])) {
      text += source[i + 1];
      i += 2;
      continue;
    }

    if (ch === "\n") {
      flush();
      out.push({ type: "br" });
      i += 1;
      continue;
    }

    if (ch === "`") {
      const run = /^`+/.exec(rest)![0];
      const close = source.indexOf(run, i + run.length);
      if (close !== -1) {
        flush();
        out.push({ type: "code", value: source.slice(i + run.length, close).replace(/\n/g, " ").trim() || " " });
        i = close + run.length;
        continue;
      }
      text += run;
      i += run.length;
      continue;
    }

    if (ch === "[") {
      const link = /^\[((?:[^\[\]\\]|\\.|\[[^\]]*\])*)\]\(\s*<?([^\s)<>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(rest);
      if (link) {
        const href = safeHref(link[2]);
        flush();
        const children = parseInline(link[1]);
        if (href) out.push({ type: "link", href, children });
        else out.push(...children);
        i += link[0].length;
        continue;
      }
    }

    if (ch === "<") {
      const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(rest);
      if (auto) {
        flush();
        out.push({ type: "link", href: auto[1], children: [{ type: "text", value: auto[1].replace(/^mailto:/i, "") }] });
        i += auto[0].length;
        continue;
      }
    }

    if ((ch === "h" || ch === "H") && !isWordChar(source[i - 1])) {
      const bare = BARE_URL.exec(rest);
      if (bare) {
        // Trailing punctuation belongs to the sentence, not the URL.
        let url = bare[0];
        while (/[.,;:!?'"]$/.test(url) || (url.endsWith(")") && (url.match(/\(/g) ?? []).length < (url.match(/\)/g) ?? []).length)) {
          url = url.slice(0, -1);
        }
        flush();
        out.push({ type: "link", href: url, children: [{ type: "text", value: url }] });
        i += url.length;
        continue;
      }
    }

    if (ch === "~" && source[i + 1] === "~") {
      const close = findClose(source, i + 2, "~~");
      if (close > i + 2) {
        flush();
        out.push({ type: "del", children: parseInline(source.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    }

    if ((ch === "*" || ch === "_") && source[i + 1] === ch) {
      const delim = ch + ch;
      const canOpen = !/\s/.test(source[i + 2] ?? " ") && !(ch === "_" && isWordChar(source[i - 1]));
      if (canOpen) {
        const close = findClose(source, i + 2, delim);
        if (close > i + 2) {
          flush();
          out.push({ type: "strong", children: parseInline(source.slice(i + 2, close)) });
          i = close + 2;
          continue;
        }
      }
      text += delim;
      i += 2;
      continue;
    }

    if (ch === "*" || ch === "_") {
      const canOpen = !/\s/.test(source[i + 1] ?? " ") && !(ch === "_" && isWordChar(source[i - 1]));
      if (canOpen) {
        const close = findClose(source, i + 1, ch);
        if (close > i + 1) {
          flush();
          out.push({ type: "em", children: parseInline(source.slice(i + 1, close)) });
          i = close + 1;
          continue;
        }
      }
    }

    text += ch;
    i += 1;
  }

  flush();
  return out;
}
