import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { extractLeanImports, LeanReplService } from "../services/lean-repl.js";

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

/**
 * 验证导入解析、已有 `.olean` 核验和受控构建对象身份边界。
 * @returns {Promise<void>} 本地缓存检查完成后返回。
 */
test("精确导入检查只允许服务自身产生的 Mathlib 构建目标", { timeout: 60000 }, async () => {
  const source = `import Mathlib.Data.Nat.Basic
import Mathlib.Data.Nat.Basic
import Mathlib.Algebra.Order.Ring.Nat
example : True := by trivial
`;
  assert.deepEqual(extractLeanImports(source), ["Mathlib.Data.Nat.Basic", "Mathlib.Algebra.Order.Ring.Nat"]);
  const service = new LeanReplService({ cwd: join(process.cwd(), "lean") });
  try {
    const cached = await service.inspectImports(source);
    assert.deepEqual(cached.missingImports, []);
    assert.deepEqual(cached.cachedImports, ["Mathlib.Data.Nat.Basic", "Mathlib.Algebra.Order.Ring.Nat"]);

    const missing = await service.inspectImports("import Mathlib.DefinitelyMissing\nexample : True := by trivial\n");
    assert.deepEqual(missing.buildTargets, ["Mathlib.DefinitelyMissing"]);
    await assert.rejects(
      service.buildMissingImports({ ...missing, buildTargets: [...missing.buildTargets] }),
      /刚刚产生且尚未使用/
    );

    const mutated = await service.inspectImports("import Mathlib.DefinitelyMissingAgain\nexample : True := by trivial\n");
    mutated.buildTargets[0] = "Mathlib.Data.Nat.Basic";
    await assert.rejects(
      service.buildMissingImports(mutated),
      /与检查时列出的精确模块不一致/
    );
  } finally {
    service.stop();
  }
});
