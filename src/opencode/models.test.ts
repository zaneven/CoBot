import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOpenCodeModelsOutput } from "./models.js";

test("parseOpenCodeModelsOutput: one provider/model id per line, order kept", () => {
  const out = parseOpenCodeModelsOutput("opencode/grok-code\nagent-plan/ark-code-latest\nopencode/mimo-v2.5-free\n");
  assert.deepEqual(out, ["opencode/grok-code", "agent-plan/ark-code-latest", "opencode/mimo-v2.5-free"]);
});

test("parseOpenCodeModelsOutput: skips blanks and whitespace, dedupes", () => {
  const out = parseOpenCodeModelsOutput("\n  a/b  \n\na/b\nc/d\n");
  assert.deepEqual(out, ["a/b", "c/d"]);
});

test("parseOpenCodeModelsOutput: skips lines without a provider separator", () => {
  const out = parseOpenCodeModelsOutput("header line\na/b\nAnother");
  assert.deepEqual(out, ["a/b"]);
});

test("parseOpenCodeModelsOutput: empty input yields empty list", () => {
  assert.deepEqual(parseOpenCodeModelsOutput(""), []);
});
