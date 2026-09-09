import assert from "node:assert/strict";
import test from "node:test";
import { LeanFormatter } from "../utils/formatter.js";

// @author ygw

test("解析 Lean 诊断信息", () => {
  const diagnostics = LeanFormatter.parseDiagnostics("Main.lean:4:7: error: unknown identifier 'x'\n");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.severity, "error");
  assert.equal(diagnostics[0]?.position?.line, 4);
});

test("解析并格式化多个 tactic 目标", () => {
  const state = LeanFormatter.parseTacticState("case left\na b : Nat\n⊢ a = b\n\ncase right\nh : True\n⊢ True");
  assert.equal(state.goals.length, 2);
  assert.equal(state.goals[0]?.caseName, "left");
  assert.equal(state.goals[1]?.target, "True");
  assert.match(LeanFormatter.formatTacticStateMarkdown(state), /目标 1/);
});
