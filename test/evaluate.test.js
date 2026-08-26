import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.js';
import { Env } from '../src/env.js';
import { evaluate, run, isTruthy, isSignal, EvalError } from '../src/evaluate.js';

/** @typedef {import('../src/evaluate.js').Step} Step */
/** @typedef {import('../src/evaluate.js').Completion} Completion */

/**
 * @param {Completion} result
 * @returns {string}
 */
function show(result) {
  if (isSignal(result)) return `${result.kind}${result.kind === 'return' ? `(${show(result.value)})` : ''}`;
  if (typeof result === 'object') return `fn ${result.name}`;
  return `${result}`;
}

/**
 * Render a step as a short label for sequence assertions: exit steps
 * include the value so short-circuiting and arithmetic are both visible.
 * @param {Step} step
 * @returns {string}
 */
function label(step) {
  const { node, phase } = step;
  const tag = node.type === 'NumberLiteral' ? `Number(${node.value})`
    : node.type === 'BinaryExpression' ? `Binary(${node.operator})`
    : node.type;
  return phase === 'exit' ? `exit ${tag}=${show(step.value)}` : `enter ${tag}`;
}

/**
 * Drive an iterator by hand, collecting a label per step plus the final
 * (drained) return value.
 * @param {Generator<Step, Completion, void>} iter
 * @returns {{steps: string[], value: Completion}}
 */
function drain(iter) {
  /** @type {string[]} */
  const steps = [];
  let result = iter.next();
  while (!result.done) {
    steps.push(label(result.value));
    result = iter.next();
  }
  return { steps, value: result.value };
}

test('steps through 1 + 2 * 3 in evaluation order', () => {
  const program = parse('1 + 2 * 3');
  const { steps, value } = drain(evaluate(program, new Env()));

  assert.equal(value, 7);
  assert.deepEqual(steps, [
    'enter Program',
    'enter ExpressionStatement',
    'enter Binary(+)',
    'enter Number(1)',
    'exit Number(1)=1',
    'enter Binary(*)',
    'enter Number(2)',
    'exit Number(2)=2',
    'enter Number(3)',
    'exit Number(3)=3',
    'exit Binary(*)=6',
    'exit Binary(+)=7',
    'exit ExpressionStatement=7',
    'exit Program=7',
  ]);
});

test('arithmetic: + - * / %', () => {
  assert.equal(run(parse('2 * (3 + 4)')), 14);
  assert.equal(run(parse('10 / 4')), 2.5);
  assert.equal(run(parse('10 % 3')), 1);
  assert.equal(run(parse('7 - 2 - 1')), 4);
});

test('+ concatenates when either side is a string', () => {
  assert.equal(run(parse('"a" + "b"')), 'ab');
  assert.equal(run(parse('"x" + 1')), 'x1');
  assert.equal(run(parse('1 + "x"')), '1x');
});

test('other arithmetic operators require numbers', () => {
  assert.throws(() => run(parse('"a" - 1')), EvalError);
  assert.throws(() => run(parse('true + 1')), EvalError);
});

test('comparison is strict, no coercion', () => {
  assert.equal(run(parse('1 == 1')), true);
  assert.equal(run(parse('1 == "1"')), false);
  assert.equal(run(parse('"a" != "b"')), true);
});

test('ordering compares two numbers or two strings, never mixed', () => {
  assert.equal(run(parse('1 < 2')), true);
  assert.equal(run(parse('"a" < "b"')), true);
  assert.equal(run(parse('2 >= 2')), true);
  assert.throws(() => run(parse('1 < "a"')), EvalError);
});

test('unary - and !', () => {
  assert.equal(run(parse('-5')), -5);
  assert.equal(run(parse('!true')), false);
  assert.equal(run(parse('!0')), true);
  assert.throws(() => run(parse('-"a"')), EvalError);
});

test('truthiness: only false, 0, "" and nothing are falsy', () => {
  assert.equal(isTruthy(false), false);
  assert.equal(isTruthy(0), false);
  assert.equal(isTruthy(''), false);
  assert.equal(isTruthy(undefined), false);
  assert.equal(isTruthy(true), true);
  assert.equal(isTruthy(1), true);
  assert.equal(isTruthy('a'), true);
});

test('&& and || short-circuit: the untaken side is never entered', () => {
  const falsyAnd = drain(evaluate(parse('0 && 5'), new Env()));
  assert.equal(falsyAnd.value, 0);
  assert.ok(!falsyAnd.steps.some((s) => s.includes('Number(5)')));

  const truthyOr = drain(evaluate(parse('1 || 5'), new Env()));
  assert.equal(truthyOr.value, 1);
  assert.ok(!truthyOr.steps.some((s) => s.includes('Number(5)')));

  const falsyOr = drain(evaluate(parse('0 || 5'), new Env()));
  assert.equal(falsyOr.value, 5);
  assert.ok(falsyOr.steps.some((s) => s.includes('Number(5)')));
});

test('run() drains the iterator and returns the final value', () => {
  assert.equal(run(parse('1 + 2 * 3')), 7);
});

test('let binds a name and an identifier reads it back', () => {
  assert.equal(run(parse('let x = 2 x * 3')), 6);
  assert.equal(run(parse('let x = 1 x = x + 4 x')), 5);
});

test('a block shadows an outer binding without disturbing it', () => {
  const source = `
    let x = "outer"
    let seen = ""
    {
      let x = "inner"
      seen = x
    }
    seen + "/" + x
  `;
  assert.equal(run(parse(source)), 'inner/outer');
});

test('assignment writes through to the scope that owns the name', () => {
  assert.equal(run(parse('let n = 0 { n = 7 } n')), 7);
});

test('redeclaring in the same scope is an error, shadowing is not', () => {
  assert.throws(() => run(parse('let x = 1 let x = 2')), { name: 'EvalError', message: /already declared/ });
  assert.equal(run(parse('let x = 1 { let x = 2 } x')), 1);
});

test('reading or assigning an unbound name is an error', () => {
  assert.throws(() => run(parse('x')), { name: 'EvalError', message: /undefined variable 'x'/ });
  assert.throws(() => run(parse('x = 1')), { name: 'EvalError', message: /undeclared variable 'x'/ });
});

test('if takes the branch truthiness picks', () => {
  assert.equal(run(parse('let r = 0 if (1 < 2) { r = "yes" } else { r = "no" } r')), 'yes');
  assert.equal(run(parse('let r = 0 if ("") { r = "yes" } else { r = "no" } r')), 'no');
  assert.equal(run(parse('let r = "untouched" if (false) { r = "yes" } r')), 'untouched');
});

test('while runs to a falsy test, and break and continue steer it', () => {
  const source = `
    let i = 0
    let total = 0
    while (i < 5) {
      i = i + 1
      if (i == 2) { continue }
      if (i == 4) { break }
      total = total + i
    }
    total
  `;
  assert.equal(run(parse(source)), 4);
});

test('return exits the function through any loop in the way', () => {
  const source = `
    fn firstOver(limit) {
      let i = 0
      while (true) {
        i = i + 1
        if (i > limit) { return i }
      }
    }
    firstOver(3)
  `;
  assert.equal(run(parse(source)), 4);
});

test('a function that never returns produces nothing, which is falsy', () => {
  assert.equal(run(parse('fn f() {} f()')), undefined);
  assert.equal(run(parse('fn f() {} !f()')), true);
  assert.equal(run(parse('fn f() { return } f()')), undefined);
});

test('a function is bound in the env it captured, so it can recurse', () => {
  const source = `
    fn fact(n) {
      if (n <= 1) { return 1 }
      return n * fact(n - 1)
    }
    fact(5)
  `;
  assert.equal(run(parse(source)), 120);
});

test('a call resolves names in the defining scope, not the calling one', () => {
  const source = `
    let x = "global"
    fn show() { return x }
    fn caller() {
      let x = "local"
      return show()
    }
    caller()
  `;
  assert.equal(run(parse(source)), 'global');
});

test('a closure captures the variable, not a copy of its value', () => {
  const source = `
    let n = 0
    fn bump() {
      n = n + 1
      return n
    }
    n = 10
    bump()
  `;
  assert.equal(run(parse(source)), 11);
});

test('a counter factory hands out counters that do not share state', () => {
  const source = `
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
  `;
  const env = new Env();
  run(parse(source), env);

  assert.equal(run(parse('a()'), env), 1);
  assert.equal(run(parse('a()'), env), 2);
  assert.equal(run(parse('b()'), env), 1);
  assert.equal(run(parse('a()'), env), 3);
  assert.equal(run(parse('b()'), env), 2);
});

test('calls check the callee and its arity', () => {
  assert.throws(() => run(parse('let x = 1 x()')), { name: 'EvalError', message: /is not a function/ });
  assert.throws(() => run(parse('fn f(a) {} f()')), { name: 'EvalError', message: /expects 1 argument, got 0/ });
  assert.throws(() => run(parse('fn f() {} f(1, 2)')), { name: 'EvalError', message: /expects 0 arguments, got 2/ });
});

test('a non-local exit with nothing to catch it becomes an error', () => {
  assert.throws(() => run(parse('break')), { name: 'EvalError', message: /'break' outside of a loop/ });
  assert.throws(() => run(parse('continue')), { name: 'EvalError', message: /'continue' outside of a loop/ });
  assert.throws(() => run(parse('return 1')), { name: 'EvalError', message: /'return' outside of a function/ });
  assert.throws(() => run(parse('while (true) { fn f() { break } f() }')), { name: 'EvalError', message: /'break' outside of a loop/ });
});

test('an unwind is a value on the exit steps, not an invisible throw', () => {
  const { steps } = drain(evaluate(parse('fn f() { return 1 } f()'), new Env()));

  assert.ok(steps.includes('exit ReturnStatement=return(1)'));
  assert.ok(steps.includes('exit Block=return(1)'));
  assert.ok(steps.includes('exit CallExpression=1'));
});

test('a runtime error unwinds the same way and surfaces at the boundary', () => {
  const { steps, value } = drain(evaluate(parse('fn f() { return 1 - "a" } f()'), new Env()));

  assert.ok(isSignal(value) && value.kind === 'error');
  assert.ok(steps.includes('exit Block=error'));
  assert.throws(() => run(parse('fn f() { return 1 - "a" } f()')), EvalError);
});
