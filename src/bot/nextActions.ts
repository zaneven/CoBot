import { InlineKeyboard } from "grammy";

/**
 * "Next-step" suggestions shown as inline buttons under a finished result.
 *
 * Primary path (model-driven): we ask Claude Code, when we dispatch a task, to
 * end its final answer with a fixed-format `<next-actions>` block listing 2-4
 * concrete follow-up steps (`- label | instruction`). We then extract that block
 * from the response and turn it into buttons. Because the model itself knows the
 * semantic intent of what it just did, these suggestions are far more accurate
 * than guessing from keywords.
 *
 * Fallback path (heuristic): if a response has no block, we infer next actions
 * from the answer text (file paths, error/failure language, test output, shell
 * hints) plus universal follow-ups. Each suggestion is a short label plus a
 * prompt that, when tapped, is fed back to Claude Code as a new interactive
 * message — so the conversation continues in context.
 *
 * The store / keyboard / callback plumbing below is shared by both paths; only
 * `buildNextActions` decides which source to use.
 */

export interface SuggestedAction {
  /** Short button label (emoji + verb + noun). */
  label: string;
  /** The prompt sent to Claude Code when the button is tapped. */
  prompt: string;
}

/** Universal follow-ups always offered (keep the conversation moving). */
const UNIVERSAL: SuggestedAction[] = [
  { label: "➡️ 继续深入", prompt: "继续，把上面的内容再深入展开讲解" },
  { label: "📝 总结要点", prompt: "请用清晰的要点总结上面的结论" },
];

const MAX_SUGGESTIONS = 4;
/** Suggestions older than this are rejected (the button belongs to a stale run). */
const TTL_MS = 10 * 60 * 1000;

/**
 * Infer likely next actions from the final answer text.
 *
 * Pure and side-effect free — the same answer always yields the same list, so
 * it is trivially unit-testable. Returns 1–MAX_SUGGESTIONS actions; the universal
 * follow-ups guarantee the list is never empty.
 */
export function generateSuggestions(answer: string, max: number = MAX_SUGGESTIONS): SuggestedAction[] {
  const text = answer ?? "";
  const found: SuggestedAction[] = [];
  const seen = new Set<string>();

  const add = (a: SuggestedAction): void => {
    if (seen.has(a.prompt)) return;
    seen.add(a.prompt);
    found.push(a);
  };

  // ── Error / failure language → troubleshoot or retry ──
  if (/(?:❌|error|失败|failed|exception|traceback|报错|崩溃)/i.test(text)) {
    add({ label: "🔧 排查这个错误", prompt: "请帮我排查上面出现的错误，并给出修复方案" });
    add({ label: "🔁 重试一次", prompt: "请重试上面的操作" });
  }

  // ── Test output → run or fix tests ──
  if (/(?:✓|✗|pass|fail|test|测试|spec|断言|assert)/i.test(text)) {
    add({ label: "🧪 运行测试", prompt: "请运行项目的测试套件" });
    add({ label: "🩹 修复失败的测试", prompt: "请修复上面失败的测试" });
  }

  // ── File paths mentioned → open / edit them ──
  for (const f of extractFilePaths(text).slice(0, 2)) {
    const name = f.split(/[\\/]/).pop() ?? f;
    add({ label: `📂 打开 ${name}`, prompt: `请打开并展示文件 ${f} 的内容` });
    add({ label: `✏️ 编辑 ${name}`, prompt: `请编辑文件 ${f}` });
  }

  // ── Shell / build hints → run the commands ──
  if (/(?:```(?:bash|sh|shell|zsh|console)|\$\s|npm run|pnpm |yarn |cargo |pytest|tsc\b|make\b|docker)/im.test(text)) {
    add({ label: "💻 运行相关命令", prompt: "请把上面提到的命令整理好并运行" });
  }

  // Universal follow-ups are always available.
  for (const u of UNIVERSAL) add(u);

  return found.slice(0, Math.max(1, max));
}

// ── Model-driven path: a <next-actions> block the model is asked to emit ─────

/** Literal tags the model wraps its "next actions" block in. */
export const NEXT_ACTIONS_OPEN = "<next-actions>";
export const NEXT_ACTIONS_CLOSE = "</next-actions>";

/**
 * Appended to every prompt we send to Claude Code. Asks the model to finish its
 * final answer with a fixed-format `<next-actions>` block listing 2-4 concrete
 * follow-up steps, each as `- label | instruction`. We then parse that block
 * into inline buttons. This is more accurate than pure heuristics because the
 * model itself knows the semantic intent of what it just did.
 */
export const NEXT_ACTIONS_DIRECTIVE = `

[指令] 在你最终回答的正文之后，请追加一个原始标签块（不要放进代码块，也不要在正文里提及它），列出 2-4 个用户最可能想继续执行的后续操作。每行一个，用 - 开头；可在标签后用 | 分隔给出点击后要执行的具体指令（不写 | 则默认用标签本身作为指令）。示例（仅演示格式，请按实际情况填写，不要照搬）：
<next-actions>
- 排查刚才的报错 | 帮我排查上一步出现的错误并给出修复方案
- 运行测试 | 运行 npm test 看是否通过
</next-actions>`;

/** Pull the `<next-actions>…</next-actions>` block out of a model response and
 *  return the surrounding text with the block removed. When no block is present
 *  `block` is null and `cleaned` equals the input. Pure + testable. */
export function extractNextActions(text: string): { cleaned: string; block: string | null } {
  const start = text.indexOf(NEXT_ACTIONS_OPEN);
  if (start < 0) return { cleaned: text, block: null };
  const close = text.indexOf(NEXT_ACTIONS_CLOSE, start);
  const blockEnd = close >= 0 ? close + NEXT_ACTIONS_CLOSE.length : text.length;
  const block = text.slice(start, blockEnd);
  const after = close >= 0 ? text.slice(blockEnd) : "";
  const cleaned = (text.slice(0, start) + after).replace(/\s+$/, "");
  return { cleaned, block };
}

/** Parse the inner lines of a `<next-actions>` block into actions.
 *  `- label | instruction` or `- label` (instruction defaults to label).
 *  Bullet (-/*) and leading `N.` numbering are tolerated. Pure + testable. */
export function parseNextActionsBlock(block: string): SuggestedAction[] {
  const inner = block.replace(NEXT_ACTIONS_OPEN, "").replace(NEXT_ACTIONS_CLOSE, "");
  const out: SuggestedAction[] = [];
  for (const rawLine of inner.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(/^[-*]\s+(.*)$/);
    const body = m ? (m[1] ?? "").trim() : line.replace(/^\d+[.)]\s*/, "").trim();
    if (!body) continue;
    const sep = body.indexOf("|");
    let label: string;
    let prompt: string;
    if (sep >= 0) {
      label = body.slice(0, sep).trim();
      prompt = body.slice(sep + 1).trim();
    } else {
      label = body;
      prompt = body;
    }
    if (!label) continue;
    out.push({ label, prompt: prompt || label });
  }
  return out;
}

/** Resolve the next-action buttons for a finished response.
 *  Primary: parse the model's `<next-actions>` block (semantic, accurate).
 *  Fallback: heuristic inference from the answer text (always yields ≥1). */
export function buildNextActions(rawText: string): SuggestedAction[] {
  const { cleaned, block } = extractNextActions(rawText);
  if (block) {
    const parsed = dedupeActions(parseNextActionsBlock(block));
    if (parsed.length) return parsed.slice(0, Math.max(1, MAX_SUGGESTIONS));
  }
  return generateSuggestions(cleaned);
}

function dedupeActions(actions: SuggestedAction[]): SuggestedAction[] {
  const seen = new Set<string>();
  const out: SuggestedAction[] = [];
  for (const a of actions) {
    const key = a.prompt.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

/**
 * Streaming filter that hides a trailing `<next-actions>` block from the live
 * ① message. `feed(delta)` returns only the display-safe portion of each delta;
 * once the opening tag is seen the rest is swallowed. A small tail is held back
 * until more data arrives (or `finish()`) so a tag split across deltas is never
 * leaked into chat.
 */
export class NextActionsStreamFilter {
  private raw = "";
  private pending = "";
  private forwarded = 0;
  private openIndex = -1;

  feed(delta: string): string {
    this.raw += delta;
    this.pending += delta;
    if (this.openIndex >= 0) return ""; // inside the block — suppress
    const idx = this.raw.indexOf(NEXT_ACTIONS_OPEN);
    if (idx >= 0) {
      this.openIndex = idx;
      const fwd = this.raw.slice(0, idx).slice(this.forwarded);
      this.forwarded = idx;
      this.pending = "";
      return fwd;
    }
    const holdBack = NEXT_ACTIONS_OPEN.length + 8;
    if (this.pending.length > holdBack) {
      const fwd = this.pending.slice(0, this.pending.length - holdBack);
      this.pending = this.pending.slice(this.pending.length - holdBack);
      this.forwarded += fwd.length;
      return fwd;
    }
    return "";
  }

  finish(): { trailing: string; block: string | null } {
    if (this.openIndex < 0) {
      const trailing = this.pending;
      this.forwarded += trailing.length;
      this.pending = "";
      return { trailing, block: null };
    }
    return { trailing: "", block: this.raw.slice(this.openIndex) };
  }
}

/** Extract file paths with an extension from free text (quotes/brackets safe). */
function extractFilePaths(text: string): string[] {
  // Match paths that start with /, ./, ../, ~/, or a Windows drive letter, and
  // contain a filename with an extension. Stop at whitespace / quotes / brackets.
  const re = /(?:^|[\s(\[])((?:\~?\/|\.\.?\/|[A-Za-z]:\\)[^\s"'`)\[\]]+\.[A-Za-z0-9]{1,6})/gm;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(re)) {
    const p = m[1]!;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

// ── one-shot store: id → action (per chat, with TTL) ───────────────────────

interface Stored {
  chatId: number;
  action: SuggestedAction;
  expires: number;
}

const store = new Map<string, Stored>();
let counter = 0;

/** Register an action and return a short id for the button's callback_data. */
export function registerSuggestion(chatId: number, action: SuggestedAction): string {
  const id = (++counter).toString(36) + Date.now().toString(36).slice(-4);
  store.set(id, { chatId, action, expires: Date.now() + TTL_MS });
  return id;
}

/**
 * Retrieve and consume a suggestion (one-shot). Returns undefined when the id
 * is unknown, expired, or belongs to a different chat — so a tapped button from
 * a stale/old run safely reports "expired" instead of firing a wrong prompt.
 */
export function consumeSuggestion(chatId: number, id: string): SuggestedAction | undefined {
  const s = store.get(id);
  if (!s) return undefined;
  // Validate ownership / freshness BEFORE removing, so a probe from the wrong
  // chat (or an expired id) never deletes a still-valid suggestion.
  if (s.expires < Date.now() || s.chatId !== chatId) return undefined;
  store.delete(id);
  return s.action;
}

/** Build an inline keyboard of `next:<id>` buttons for the given actions.
 *  Each action is registered in the store as its button is rendered. */
export function renderSuggestionKeyboard(actions: SuggestedAction[], chatId: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const a of actions) {
    const id = registerSuggestion(chatId, a);
    kb.text(truncateLabel(a.label), `next:${id}`).row();
  }
  return kb;
}

/** Telegram inline-button text is soft-capped; keep labels short. */
function truncateLabel(s: string): string {
  return s.length > 50 ? s.slice(0, 49) + "…" : s;
}
