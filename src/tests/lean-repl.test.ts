import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { LeanReplService } from "../services/lean-repl.js";

// @author ygw

/**
 * 验证常驻 Lean 服务会复用同一 LSP 文档的导入状态。
 * @returns {Promise<void>} 首次验证、增量验证和诊断映射均完成后返回。
 */
test("常驻 Lean 服务复用 Mathlib 导入并返回最新诊断", { timeout: 180000 }, async () => {
  const service = new LeanReplService({ cwd: join(process.cwd(), "lean") });
  const validSource = `import Mathlib.Data.Nat.Basic
example : (1 : Nat) + 2 = 2 + 1 := by
  exact Nat.add_comm 1 2
`;
  const invalidSource = `import Mathlib.Data.Nat.Basic
example : Nat := by
  exact definitely_unknown_name
`;
  try {
    const firstResult = await service.checkSource({
      source: validSource,
      fileName: "GeneratedProof.lean"
    });
    assert.equal(firstResult.success, true);
    assert.equal(firstResult.reusedProcess, false);

    const updatedResult = await service.checkSource({
      source: invalidSource,
      fileName: "RevisedProof.lean"
    });
    assert.equal(updatedResult.success, false);
    assert.equal(updatedResult.reusedProcess, true);
    assert.equal(updatedResult.diagnostics.length > 0, true);
    assert.equal(updatedResult.diagnostics[0]?.filePath, "RevisedProof.lean");
    assert.match(updatedResult.diagnostics[0]?.message ?? "", /Unknown identifier/);
  } finally {
    service.stop();
  }
});
