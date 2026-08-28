// @ts-check

/**
 * The corpus both backends are held to. Keeping the tree-walker alive past
 * Phase 5 is only worth it if something actually compares them, and this is
 * that something: one list of programs, run twice, with the two answers
 * asserted equal to each other *and* to what is written here.
 *
 * `result` is the program's value in `describe` form, which distinguishes
 * `1` from `"1"` and names a function without caring which backend built it.
 * `output` is what `print` wrote. `error` is the message, whichever kind of
 * error it turned out to be.
 * @typedef {{name: string, source: string, result?: string, output?: string[], error?: string}} Case
 */

/** @type {Case[]} */
export const PROGRAMS = [
  // ---- arithmetic and precedence -----------------------------------------
  { name: 'multiplication binds tighter than addition', source: '1 + 2 * 3', result: 'number 7' },
  { name: 'parentheses override precedence', source: '2 * (3 + 4)', result: 'number 14' },
  { name: 'subtraction is left-associative', source: '7 - 2 - 1', result: 'number 4' },
  { name: 'division is not integer division', source: '10 / 4', result: 'number 2.5' },
  { name: 'modulo', source: '10 % 3', result: 'number 1' },
  { name: 'unary minus binds tighter than binary', source: '-3 + 1', result: 'number -2' },
  { name: 'unary minus nests', source: '- -5', result: 'number 5' },
  { name: 'an empty program has no value', source: '', result: 'nothing' },

  // ---- strings ------------------------------------------------------------
  { name: 'string concatenation', source: '"a" + "b"', result: 'string "ab"' },
  { name: 'a number splices into a string on the right', source: '"n=" + 1', result: 'string "n=1"' },
  { name: 'a number splices into a string on the left', source: '1 + "n"', result: 'string "1n"' },
  { name: 'a boolean splices into a string', source: 'true + ""', result: 'string "true"' },
  { name: 'strings order by code unit', source: '"apple" < "banana"', result: 'boolean true' },

  // ---- comparison and equality -------------------------------------------
  { name: 'less than', source: '1 < 2', result: 'boolean true' },
  { name: 'greater or equal', source: '2 >= 2', result: 'boolean true' },
  { name: 'equality does not coerce', source: '1 == "1"', result: 'boolean false' },
  { name: 'inequality', source: '1 != 2', result: 'boolean true' },

  // ---- truthiness ---------------------------------------------------------
  {
    name: 'falsy is exactly false, zero, the empty string and nothing',
    source: 'print(!false) print(!0) print(!"") print(!print(""))',
    output: ['true', 'true', 'true', '', 'true'],
    result: 'nothing',
  },
  {
    name: 'everything else is truthy',
    source: 'print(!1) print(!-1) print(!"x") print(!true) print(!print)',
    output: ['false', 'false', 'false', 'false', 'false'],
    result: 'nothing',
  },

  // ---- short-circuiting ---------------------------------------------------
  { name: 'and keeps the falsy left operand and skips the right', source: 'false && print("no")', result: 'boolean false', output: [] },
  { name: 'or keeps the truthy left operand and skips the right', source: 'true || print("no")', result: 'boolean true', output: [] },
  { name: 'and yields the right operand when the left is truthy', source: '1 && 2', result: 'number 2' },
  { name: 'or yields the right operand when the left is falsy', source: '0 || "fallback"', result: 'string "fallback"' },
  { name: 'and yields the empty string rather than false', source: '"" && 1', result: 'string ""' },

  // ---- let, assignment and scope -----------------------------------------
  { name: 'a let statement evaluates to what it bound', source: 'let x = 5', result: 'number 5' },
  { name: 'assignment reads and writes the same binding', source: 'let x = 1 x = x + 1 x', result: 'number 2' },
  { name: 'a block scope shadows and then goes away', source: 'let x = 1 { let x = 2 print(x) } print(x)', output: ['2', '1'], result: 'nothing' },
  { name: 'a block binding is gone afterwards', source: '{ let a = 1 } a', error: "undefined variable 'a'" },
  { name: 'an empty block has no value', source: '{ }', result: 'nothing' },
  { name: 'a block evaluates to its last statement', source: '{ 1 2 }', result: 'number 2' },
  { name: 'redeclaring in one scope is an error', source: 'let x = 1 let x = 2', error: "'x' is already declared in this scope" },

  // ---- if -----------------------------------------------------------------
  { name: 'if takes the consequent', source: 'if (1) { 2 } else { 3 }', result: 'number 2' },
  { name: 'if takes the alternate', source: 'if (0) { 2 } else { 3 }', result: 'number 3' },
  { name: 'a missing else produces nothing', source: 'if (false) { 1 }', result: 'nothing' },
  { name: 'else-if chains', source: 'let n = 2 if (n == 1) { "one" } else if (n == 2) { "two" } else { "many" }', result: 'string "two"' },

  // ---- while, break, continue --------------------------------------------
  { name: 'a while loop accumulates', source: 'let i = 0 let s = 0 while (i < 5) { s = s + i i = i + 1 } s', result: 'number 10' },
  { name: 'a loop itself has no value', source: 'let i = 0 while (i < 1) { i = 1 }', result: 'nothing' },
  { name: 'break leaves the loop', source: 'let i = 0 while (true) { i = i + 1 if (i == 3) { break } } i', result: 'number 3' },
  { name: 'continue skips to the next test', source: 'let i = 0 let s = 0 while (i < 5) { i = i + 1 if (i % 2 == 0) { continue } s = s + i } s', result: 'number 9' },
  { name: 'break unwinds the scopes opened inside the loop', source: 'let i = 0 while (true) { { let j = 1 break } } i', result: 'number 0' },
  { name: 'continue unwinds the scopes opened inside the loop', source: 'let i = 0 while (i < 3) { i = i + 1 { let j = i continue } } i', result: 'number 3' },
  { name: 'break leaves only the innermost loop', source: 'let n = 0 let i = 0 while (i < 3) { i = i + 1 let j = 0 while (true) { j = j + 1 break } n = n + j } n', result: 'number 3' },
  { name: 'break outside a loop is an error', source: 'break', error: "'break' outside of a loop" },
  { name: 'continue outside a loop is an error', source: 'continue', error: "'continue' outside of a loop" },
  { name: 'return outside a function is an error', source: 'return 1', error: "'return' outside of a function" },

  // ---- functions and closures --------------------------------------------
  { name: 'a declaration evaluates to the function', source: 'fn f() { return 1 }', result: 'function f' },
  { name: 'a call runs the body', source: 'fn double(n) { return n * 2 } double(21)', result: 'number 42' },
  { name: 'falling off the end produces nothing', source: 'fn f() { 1 } f()', result: 'nothing' },
  { name: 'an empty body produces nothing', source: 'fn f() { } f()', result: 'nothing' },
  { name: 'a bare return produces nothing', source: 'fn f() { return } f()', result: 'nothing' },
  { name: 'return leaves a loop and the function together', source: 'fn first() { let i = 0 while (true) { i = i + 1 if (i == 2) { return i } } } first()', result: 'number 2' },
  { name: 'a let in the body may shadow a parameter', source: 'fn f(x) { let x = 2 return x } f(1)', result: 'number 2' },
  { name: 'recursion', source: 'fn fib(n) { if (n < 2) { return n } return fib(n - 1) + fib(n - 2) } fib(10)', result: 'number 55' },
  { name: 'a function can be passed and called', source: 'fn twice(f, x) { return f(f(x)) } fn inc(n) { return n + 1 } twice(inc, 1)', result: 'number 3' },
  {
    name: 'two closures from one factory keep separate state',
    source: `
      fn makeCounter() {
        let n = 0
        fn inc() {
          n = n + 1
          print(n)
        }
        return inc
      }
      let a = makeCounter()
      let b = makeCounter()
      a() a() b()
    `,
    output: ['1', '2', '1'],
    result: 'nothing',
  },
  {
    name: 'a closure captures by reference, not by value',
    source: 'fn make() { let n = 1 fn get() { return n } n = 2 return get } make()()',
    result: 'number 2',
  },
  {
    name: 'a call resolves names through the defining chain, not the caller',
    source: 'let x = "outer" fn get() { return x } fn shadowed() { let x = "inner" return get() } shadowed()',
    result: 'string "outer"',
  },

  // ---- builtins -----------------------------------------------------------
  { name: 'print writes and returns nothing', source: 'print(print("x"))', output: ['x', 'nothing'], result: 'nothing' },
  { name: 'print renders each kind of value', source: 'print("hi") print(42) print(1.5) print(true)', output: ['hi', '42', '1.5', 'true'], result: 'nothing' },
  { name: 'print names a function rather than showing its innards', source: 'fn f(x) { return x } print(f) print(print)', output: ['<fn f>', '<fn print>'], result: 'nothing' },
  { name: 'builtins sit in a scope the program can shadow', source: '{ fn print(x) { return x } } print("still the builtin")', output: ['still the builtin'], result: 'nothing' },

  // ---- runtime errors -----------------------------------------------------
  { name: 'adding a number to a boolean', source: '1 + true', error: "'+' expects two numbers or a string, got number 1 and boolean true" },
  { name: 'concatenating a function', source: '"a" + print', error: `'+' cannot concatenate string "a" and function print` },
  { name: 'multiplying a boolean', source: '1 * false', error: "'*' expects two numbers, got number 1 and boolean false" },
  { name: 'ordering across types', source: `1 < "a"`, error: `'<' expects two numbers or two strings, got number 1 and string "a"` },
  { name: 'negating a string', source: '-"x"', error: `unary '-' expects a number, got string "x"` },
  { name: 'reading an unbound name', source: 'x', error: "undefined variable 'x'" },
  { name: 'assigning an unbound name', source: 'x = 1', error: "assignment to undeclared variable 'x'" },
  { name: 'calling a number', source: '1()', error: 'number 1 is not a function' },
  { name: 'too many arguments to a builtin', source: 'print(1, 2)', error: 'print expects 1 argument, got 2' },
  { name: 'too few arguments to a function', source: 'fn f(a, b) { return a } f(1)', error: 'f expects 2 arguments, got 1' },
  { name: 'an error stops the program where it happened', source: 'print("before") 1 + true print("after")', error: "'+' expects two numbers or a string, got number 1 and boolean true", output: ['before'] },
];
