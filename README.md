# Pip

A small dynamic language whose evaluator is a generator, so single-stepping,
breakpoints, and step-back fall out of the design instead of being bolted on.

See `plan.md` for the roadmap.

## Values

Numbers, strings, booleans, and functions. There is also *nothing*, which is
what a function that never returns hands back and what an empty program
evaluates to. The language has no literal for it, so the only way to get one
is to not return anything.

## Truthiness

Falsy is exactly `false`, `0`, `""`, and nothing. Every other value —
including every nonzero number, every non-empty string, and every function —
is truthy.

## Operators

- `+` concatenates if either side is a string, otherwise adds two numbers.
  `"x" + 1` is `"x1"`; `1 + "x"` is `"1x"`. Only numbers, strings and booleans
  splice into a string; a function or nothing on either side is an error.
- `- * / %` require both sides to be numbers.
- `== !=` are strict — no coercion. `1 == "1"` is `false`, and functions
  compare by identity.
- `< <= > >=` compare two numbers or two strings (by UTF-16 code unit); mixing
  types, or ordering a boolean, is a runtime `EvalError`.
- `&& ||` short-circuit and return whichever operand decided the result
  (not necessarily a boolean) — the untaken side is never evaluated, so it
  never yields its enter/exit steps either.
- Unary `!` returns the boolean negation of truthiness; unary `-` requires a
  number.

## Scope

A scope is a `Map` of its own bindings plus a link to the scope around it, so
resolving a name walks outward until some scope binds it.

- `let` binds in the current scope. A second `let` for the same name in the
  same scope is an error; a `let` in an inner scope shadows the outer binding
  for as long as the inner scope lives.
- Assignment writes to whichever scope already owns the name, and never
  declares one, so assigning to an unbound name is an error.
- Blocks push a scope. So do calls.

## Functions and closures

`fn` binds a function in the scope it was declared in, which is also the scope
the function captures. Two things follow from that: a function can call
itself, and it resolves free names where it was written rather than where it
was called.

A call pushes a scope whose parent is the captured one, so two functions built
by the same factory get separate parents and their captured variables never
meet.

```pip
fn makeCounter() {
  let n = 0
  fn inc() {
    n = n + 1
    return n
  }
  return inc
}

let a = makeCounter()
let b = makeCounter()

a()   // 1
a()   // 2
b()   // 1, because b has its own n
```

The closure and its defining scope share the binding itself rather than a copy
of the value, so a write on either side is visible to the other. Calls check
arity, and calling something that isn't a function is an error.

## Non-local exits

`return`, `break`, `continue`, and runtime errors are all one mechanism: a
sentinel that an evaluator returns in place of a value, and that every caller
passes outward until something catches it. Loops catch `break` and `continue`,
calls catch `return`, and `run()` catches an error and rethrows it as an
`EvalError`. A sentinel that reaches somewhere nothing catches it turns into
an error, because a `break` with no loop around it is a mistake.

The reason it is a value rather than a JS `throw`: a throw travelling up the
`yield*` chain would skip every pause point on the way out, so a debugger
would watch the interpreter vanish mid-expression. As a value it lands on the
exit step of every node it passes through, which makes an unwind something you
can step through like anything else.

## The debugger

```
npm run web
```

Then open <http://localhost:8080/>. The page is plain ESM with no build step,
so the browser loads `src/` directly; the server exists because module imports
over `file://` are blocked, not because anything gets compiled.

`print` is the one builtin, and it writes to the output pane. It takes a single
argument, renders strings bare, and hands back nothing.

Five controls, each with its keyboard letter lit in the label. `line` and
`over` are the ones that make the page usable; raw stepping on its own is too
fine-grained to navigate with:

- `step` takes one `yield`. Every node has an enter and an exit step, which
  makes `1 + 2 * 3` about ten of them.
- `line` runs until the current node starts on a different line, and will
  descend into a call to get there.
- `over` does the same but waits out any call that starts on the way, so you
  skip a function body instead of walking it.
- `run` goes to the end, or to the next breakpoint.
- `reset` rewinds to the first step. Breakpoints stay.

The strip across the top is the yield stream itself, one column per step,
rising with every enter and falling with every exit. A subtree comes out as an
arch, a loop as a row of identical teeth, and a deep call as a tall block, so
the shape of a run is readable at a glance rather than only one instant of it.
The cursor sits where execution is paused. Columns widen to fill the strip
while a run is short; past a few thousand steps the trace keeps only the most
recent window and says how many it dropped.

Click a line number to set a breakpoint. A breakpoint fires when execution
*arrives* at the line from somewhere else, so a run stops once per visit rather
than once per step taken while sitting there.

The scopes pane walks the env chain from the innermost scope outward and reads
each `Map` at the moment it draws, so what you see is the live binding rather
than a copy taken when the step was yielded.

A call pushes two scopes rather than one: the parameters go in the call frame,
and the body gets a scope of its own, because the body is an ordinary block.
Inside a closure those stack up and most of them are empty, so the pane leaves
empty scopes out until you tick `empty` in its header.

When something fails, the call-stack pane freezes the stack as it stood at the
moment of failure. The live stack has already unwound to nothing by the time
the program stops, so drawing that one instead would leave the pane empty.
