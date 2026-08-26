/**
 * One-shot diagnostic: does a headless SDK query route a "dangerous" Bash
 * command (node -e …) to the canUseTool callback under permissionMode
 * "acceptEdits", and does the allow result validate? Prints every DriverEvent
 * + every canUseTool invocation, so we can confirm the canUseTool→allow path
 * runs the tool (not a ZodError rejection). Optional cwd arg; defaults to the
 * project dir (which has allow rules in .claude/settings.local.json that
 * short-circuit canUseTool — pass a bare dir to exercise the callback).
 *
 *   npx tsx scripts/probe-canuse-tool.ts [cwd]
 */
import { runClaude } from "../src/claude/driver.js";
import { logger } from "../src/util/logger.js";

const canUseToolCalls: string[] = [];
const handler = async (req: { toolName: string; input: Record<string, unknown> }) => {
  const cmd = (req.input as { command?: string }).command ?? JSON.stringify(req.input).slice(0, 80);
  canUseToolCalls.push(`${req.toolName} :: ${cmd}`);
  console.log(`  [canUseTool CALLED] ${req.toolName} :: ${cmd}  → allow`);
  return { behavior: "allow" as const };
};

async function main() {
  const cwd = process.argv[2] ?? process.cwd();
  console.log(`=== probe: acceptEdits + canUseTool, running \`node -e\` in ${cwd} ===\n`);
  let toolResults = 0;
  try {
    for await (const ev of runClaude({
      prompt: { text: "Use the Bash tool to run exactly this command and report its stdout: node -e 'console.log(42)'" },
      cwd: process.argv[2] ?? process.cwd(),
      permissionMode: "acceptEdits",
      canUseToolHandler: handler as never,
      timeoutMs: 90_000,
    })) {
      switch (ev.kind) {
        case "init": console.log(`[init] session=${ev.sessionId} model=${ev.model}`); break;
        case "tool": console.log(`[tool] ${ev.name}: ${ev.summary}`); break;
        case "toolResult": console.log(`[toolResult] ${ev.name} isError=${ev.isError} :: ${ev.content.slice(0, 600)}`); toolResults++; break;
        case "text": process.stdout.write(ev.delta); break;
        case "done":
          console.log(`\n[done] aborted=${ev.aborted} reason=${ev.abortedReason ?? "-"} isError=${ev.isError} turnsExhausted=${ev.turnsExhausted ?? false}`);
          break;
        case "error": console.log(`[error] ${ev.message}`); break;
        case "status": console.log(`[status] ${ev.status}`); break;
        default: break;
      }
    }
  } catch (err) {
    console.log(`\n[throw] ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log(`\n=== summary ===`);
  console.log(`canUseTool invoked: ${canUseToolCalls.length} time(s)`);
  for (const c of canUseToolCalls) console.log(`  - ${c}`);
  console.log(`toolResult events: ${toolResults}`);
  if (canUseToolCalls.length === 0) {
    console.log("\n>>> canUseTool was NEVER called — claude pre-denied the Bash command");
    console.log(">>> before reaching the approval callback (the interactive-approval gap).");
  }
}

main().catch((e) => { logger.error({ err: String(e) }, "probe failed"); process.exit(1); });
