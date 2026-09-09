-- @author ygw
-- @author ygw
import Mathlib.Data.Nat.Basic
import Lean4Harness

namespace Lean4Harness

example (p q : Prop) (hp : p) (hq : q) : p ∧ q := by
  constructor
  · exact hp
  · exact hq

example : (1 : Nat) + 2 = 2 + 1 := by
  exact Nat.add_comm 1 2

end Lean4Harness
