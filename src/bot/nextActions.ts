import { InlineKeyboard } from "grammy";

/**
 * "Next-step" suggestions shown as inline buttons under a finished result.
 *
 * The bot infers the user's likely next move *from the final answer itself*
 * (file paths it mentions, error/failure language, test output, shell hints)
 * and always offers a couple of universal follow-ups. Each suggestion is a
 * short label plus a prompt that, when tapped, is fed back to Claude Code as a
 * new interactive message — so the conversation continues in context.
 *
 * This is intentionally heuristic (no second LLM call) so it is fast, free, and
 * works offline. A model-backed generator can later replace `generateSuggestions`
 * without touching the store / keyboard / callback plumbing below.
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
