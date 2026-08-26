import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.js';
import { evaluate, run, isTruthy, EvalError } from '../src/evaluate.js';

/** @typedef {import('../src/evaluate.js').Step} Step */

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
  return phase === 'exit' ? `exit ${tag}=${step.value}` : `enter ${tag}`;
}

/**
 * Drive an iterator by hand, collecting a label per step plus the final
 * (drained) return value.
 * @param {Generator<Step, unknown, void>} iter
 * @returns {{steps: string[], value: unknown}}
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
  const { steps, value } = drain(evaluate(program, {}));

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

test('truthiness: only false, 0 and "" are falsy', () => {
  assert.equal(isTruthy(false), false);
  assert.equal(isTruthy(0), false);
  assert.equal(isTruthy(''), false);
  assert.equal(isTruthy(true), true);
  assert.equal(isTruthy(1), true);
  assert.equal(isTruthy('a'), true);
});

test('&& and || short-circuit: the untaken side is never entered', () => {
  const falsyAnd = drain(evaluate(parse('0 && 5'), {}));
  assert.equal(falsyAnd.value, 0);
  assert.ok(!falsyAnd.steps.some((s) => s.includes('Number(5)')));

  const truthyOr = drain(evaluate(parse('1 || 5'), {}));
  assert.equal(truthyOr.value, 1);
  assert.ok(!truthyOr.steps.some((s) => s.includes('Number(5)')));

  const falsyOr = drain(evaluate(parse('0 || 5'), {}));
  assert.equal(falsyOr.value, 5);
  assert.ok(falsyOr.steps.some((s) => s.includes('Number(5)')));
});

test('run() drains the iterator and returns the final value', () => {
  assert.equal(run(parse('1 + 2 * 3')), 7);
});

test('nodes without a Phase 2 rule raise EvalError', () => {
  assert.throws(() => run(parse('x')), EvalError);
});
