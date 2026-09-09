-- @author ygw
import Lake

open Lake DSL

require mathlib from "D:/mathlib4"

package lean4_harness where
  version := v!"0.1.0"

@[default_target]
lean_lib Lean4Harness
