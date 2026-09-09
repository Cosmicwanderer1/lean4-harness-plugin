/-!
Lean 4 Harness 的默认验证入口。
作者：ygw
-/

namespace Lean4Harness

theorem and_commutative (p q : Prop) : p ∧ q → q ∧ p := by
  intro h
  exact And.intro h.right h.left

end Lean4Harness
