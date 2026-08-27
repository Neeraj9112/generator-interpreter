import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.js';
import { run, EvalError } from '../src/evaluate.js';
import { globals, format } from '../src/builtins.js';

/**
 * Run a program against a fresh set of builtins, collecting whatever it
 * printed. The program gets a child of the globals so its own top-level
 * bindings stay separate from the builtins, which is how the debugger
 * mounts it too.
 * @param {string} source
 * @returns {{value: unknown, output: string[]}}
 */
function runCollecting(source) {
  /** @type {string[]} */
  const output = [];
  const env = globals({ write: (line) => output.push(line) }).child();
  return { value: run(parse(source), env), output };
}

test('print writes to the sink it was given, not the console', () => {
  const { output } = runCollecting('print("hello")');
  assert.deepEqual(output, ['hello']);
});

test('print renders strings bare and numbers and booleans as written', () => {
  const { output } = runCollecting('print("hi") print(42) print(1.5) print(true)');
  assert.deepEqual(output, ['hi', '42', '1.5', 'true']);
});

test('print names a function rather than showing its innards', () => {
  const { output } = runCollecting('fn f(x) { return x } print(f) print(print)');
  assert.deepEqual(output, ['<fn f>', '<fn print>']);
});

test('print hands back nothing, so printing its result says so', () => {
  const { output } = runCollecting('print(print("x"))');
  assert.deepEqual(output, ['x', 'nothing']);
});

test('a builtin checks arity like any other call', () => {
  assert.throws(
    () => runCollecting('print(1, 2)'),
    (/** @type {EvalError} */ err) => err instanceof EvalError && err.message === 'print expects 1 argument, got 2',
  );
});

test('builtins live in an outer scope the program can shadow', () => {
  const { output } = runCollecting('{ fn print(x) { return x } } print("still the builtin")');
  assert.deepEqual(output, ['still the builtin']);
});

test('a top-level let shadows a builtin rather than clashing with it', () => {
  assert.throws(
    () => runCollecting('let print = 1 print("x")'),
    (/** @type {EvalError} */ err) => err instanceof EvalError && err.message === 'number 1 is not a function',
  );
});

test('assigning a builtin name writes through the chain and replaces it', () => {
  assert.throws(() => runCollecting('print = 1 print("x")'), EvalError);
});

test('a call inside a closure reaches the builtin through the captured chain', () => {
  const { output } = runCollecting(`
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
  `);
  assert.deepEqual(output, ['1', '2', '1']);
});

test('format covers every value the language can produce', () => {
  assert.equal(format(undefined), 'nothing');
  assert.equal(format(0), '0');
  assert.equal(format(''), '');
  assert.equal(format(false), 'false');
  assert.equal(format('a\nb'), 'a\nb');
});
