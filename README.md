# Pip

A small dynamic language whose evaluator is a generator, so single-stepping,
breakpoints, and step-back fall out of the design instead of being bolted on.

See `plan.md` for the roadmap.

## Values (Phase 2)

Numbers, strings, and booleans. `Identifier`, functions, and everything else
that needs scope arrives in Phase 3.

## Truthiness

Falsy is exactly `false`, `0`, and `""`. Every other value — including every
nonzero number and every non-empty string — is truthy.

## Operators

- `+` concatenates if either side is a string, otherwise adds two numbers.
  `"x" + 1` is `"x1"`; `1 + "x"` is `"1x"`.
- `- * / %` require both sides to be numbers.
- `== !=` are strict — no coercion. `1 == "1"` is `false`.
- `< <= > >=` compare two numbers or two strings (by UTF-16 code unit); mixing
  types, or ordering a boolean, is a runtime `EvalError`.
- `&& ||` short-circuit and return whichever operand decided the result
  (not necessarily a boolean) — the untaken side is never evaluated, so it
  never yields its enter/exit steps either.
- Unary `!` returns the boolean negation of truthiness; unary `-` requires a
  number.
