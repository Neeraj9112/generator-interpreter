import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Debugger, inspect } from '../web/driver.js';

/** @typedef {import('../web/driver.js').Scope} Scope */

// Lines are 1-based and referred to by number all through this file, so the
// leading newline is deliberate: line 1 is blank, `fn makeCounter()` is 2.
const COUNTER = `
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
print(a())
print(a())
print(b())
`;

const ADD = `
fn add(x, y) {
  return x + y
}
let sum = add(1, 2)
let next = sum + 1
`;

/**
 * Step until `predicate` holds, with a cap so a wrong predicate fails the
 * test instead of hanging the suite.
 * @param {Debugger} dbg
 * @param {(dbg: Debugger) => boolean} predicate
 * @returns {Debugger}
 */
function advanceTo(dbg, predicate) {
  for (let i = 0; i < 10000; i++) {
    if (!dbg.step()) break;
    if (predicate(dbg)) return dbg;
  }
  assert.fail('never reached the requested pause point');
}

/**
 * @param {string} type
 * @param {number} line
 * @returns {(dbg: Debugger) => boolean}
 */
function atEnterOf(type, line) {
  return (dbg) => dbg.current !== null
    && dbg.current.phase === 'enter'
    && dbg.current.node.type === type
    && dbg.line === line;
}

/**
 * @param {Scope[]} scopes
 * @returns {string[]}
 */
function scopeLabels(scopes) {
  return scopes.map((scope) => scope.label);
}

test('a fresh debugger is ready and has not moved', () => {
  const dbg = new Debugger(COUNTER);
  assert.equal(dbg.status, 'ready');
  assert.equal(dbg.current, null);
  assert.equal(dbg.line, null);
  assert.equal(dbg.stepCount, 0);
  assert.deepEqual(dbg.output, []);
});

test('run drains the program and collects what it printed', () => {
  const dbg = new Debugger(COUNTER);
  dbg.run();
  assert.equal(dbg.status, 'done');
  assert.deepEqual(dbg.output, ['1', '2', '1']);
  assert.equal(dbg.canStep, false);
});

test('the first step is the program enter, and steps come in enter/exit pairs', () => {
  const dbg = new Debugger('1 + 2');
  dbg.step();
  assert.equal(dbg.current?.phase, 'enter');
  assert.equal(dbg.current?.node.type, 'Program');
  assert.equal(dbg.status, 'paused');

  const seen = [];
  while (dbg.step()) seen.push(`${dbg.current?.phase} ${dbg.current?.node.type}`);
  assert.deepEqual(seen.slice(0, 4), [
    'enter ExpressionStatement',
    'enter BinaryExpression',
    'enter NumberLiteral',
    'exit NumberLiteral',
  ]);
  assert.equal(dbg.result, 3);
});

test('reset rewinds execution and clears output but keeps breakpoints', () => {
  const dbg = new Debugger(COUNTER);
  dbg.toggleBreakpoint(12);
  dbg.run();
  assert.equal(dbg.status, 'paused');

  dbg.reset();
  assert.equal(dbg.status, 'ready');
  assert.equal(dbg.stepCount, 0);
  assert.deepEqual(dbg.output, []);
  assert.deepEqual([...dbg.breakpoints], [12]);
});

test('reset gives the program a clean env rather than the one it dirtied', () => {
  const dbg = new Debugger(COUNTER);
  dbg.run();
  dbg.reset();
  dbg.run();
  assert.deepEqual(dbg.output, ['1', '2', '1']);
});

test('stepLine crosses exactly one line', () => {
  const dbg = new Debugger(ADD);
  advanceTo(dbg, atEnterOf('LetStatement', 5));
  dbg.stepLine();
  assert.notEqual(dbg.line, 5);
});

test('stepLine descends into a call, stepOver does not', () => {
  const into = new Debugger(ADD);
  advanceTo(into, atEnterOf('CallExpression', 5));
  into.stepLine();
  assert.equal(into.line, 2, 'stepping into add() should land in its header or body');

  const over = new Debugger(ADD);
  advanceTo(over, atEnterOf('CallExpression', 5));
  over.stepOver();
  assert.equal(over.line, 6, 'stepping over add() should land on the next line');
  assert.deepEqual(over.stack, [], 'and should leave no frame behind');
});

test('stepOver away from a call still advances one line', () => {
  const dbg = new Debugger(ADD);
  advanceTo(dbg, atEnterOf('LetStatement', 6));
  dbg.stepOver();
  assert.notEqual(dbg.line, 6);
});

test('stepOver past a return finishes the call and comes back to the caller', () => {
  const dbg = new Debugger(ADD);
  advanceTo(dbg, atEnterOf('ReturnStatement', 3));

  // The body block's span starts at its opening brace, so leaving the return
  // lands on line 2 with the whole body lit up. The frame is still pending:
  // it pops when the call expression itself exits, not when the body does.
  dbg.stepOver();
  assert.equal(dbg.line, 2);
  assert.equal(dbg.stack.length, 1);

  dbg.stepOver();
  assert.equal(dbg.stack.length, 0, 'the add frame has popped');
  assert.equal(dbg.line, 5, 'and we are back at the call site');
});

test('run halts on a breakpoint and a second run carries on', () => {
  const dbg = new Debugger(COUNTER);
  dbg.toggleBreakpoint(5);
  dbg.run();
  assert.equal(dbg.status, 'paused');
  assert.equal(dbg.line, 5);
  assert.deepEqual(dbg.output, [], 'the first print has not run yet');

  dbg.run();
  assert.equal(dbg.line, 5, 'the second call() hits the same line again');
  assert.deepEqual(dbg.output, ['1']);

  dbg.toggleBreakpoint(5);
  dbg.run();
  assert.equal(dbg.status, 'done');
  assert.deepEqual(dbg.output, ['1', '2', '1']);
});

test('a breakpoint fires once per arrival, not once per step on the line', () => {
  const dbg = new Debugger('let x = 1 + 2 * 3\nlet y = x\n');
  dbg.toggleBreakpoint(1);
  dbg.run();
  const first = dbg.stepCount;
  dbg.run();
  assert.equal(dbg.status, 'done', 'line 1 should not stop the run a second time');
  assert.ok(dbg.stepCount > first);
});

test('toggleBreakpoint reports the state it left the line in', () => {
  const dbg = new Debugger(ADD);
  assert.equal(dbg.toggleBreakpoint(3), true);
  assert.equal(dbg.toggleBreakpoint(3), false);
  assert.deepEqual([...dbg.breakpoints], []);
});

test('the call stack tracks pending calls and unwinds again', () => {
  const dbg = new Debugger(ADD);
  advanceTo(dbg, atEnterOf('ReturnStatement', 3));
  assert.deepEqual(dbg.stack.map((frame) => frame.name), ['add']);
  assert.deepEqual(dbg.stack.map((frame) => frame.line), [5]);
  dbg.run();
  assert.deepEqual(dbg.stack, []);
});

test('a frame is named after the callee source, whatever the expression', () => {
  const dbg = new Debugger('fn f() { fn g() { return 1 } return g }\nf()()\n');
  advanceTo(dbg, (d) => d.stack.length === 2);
  assert.deepEqual(dbg.stack.map((frame) => frame.name), ['f()', 'f']);
});

test('scopes read the live env, innermost first', () => {
  const dbg = new Debugger(COUNTER);
  advanceTo(dbg, atEnterOf('ReturnStatement', 6));
  const scopes = dbg.scopes();
  assert.deepEqual(scopeLabels(scopes).at(-1), 'builtins');
  assert.ok(scopeLabels(scopes).includes('top level'));

  const named = scopes.flatMap((scope) => scope.bindings.map((binding) => binding.name));
  assert.ok(named.includes('n'), 'the captured counter should be visible from inside inc');
  assert.ok(named.includes('print'), 'and so should the builtins at the far end of the chain');
});

test('scopes see a binding appear as the program runs', () => {
  const dbg = new Debugger('let x = 1\nlet y = 2\n');
  advanceTo(dbg, atEnterOf('LetStatement', 2));
  const before = dbg.scopes()[0].bindings.map((binding) => binding.name);
  assert.deepEqual(before, ['x']);
  dbg.run();
  assert.deepEqual(dbg.programEnv.vars.get('y'), 2);
});

test('a runtime error stops the run and keeps the failing node and stack', () => {
  const dbg = new Debugger('fn boom() {\n  return 1 + missing\n}\nboom()\n');
  dbg.run();
  assert.equal(dbg.status, 'error');
  assert.equal(dbg.failure?.message, "undefined variable 'missing'");
  assert.equal(dbg.failure?.node.type, 'Identifier');
  assert.deepEqual(dbg.failure?.stack.map((frame) => frame.name), ['boom']);
});

test('the failure snapshot survives the unwind that follows it', () => {
  const dbg = new Debugger('fn a() { return b() }\nfn b() { return 1 % "x" }\na()\n');
  dbg.run();
  assert.equal(dbg.status, 'error');
  assert.match(dbg.failure?.message ?? '', /^'%' expects two numbers/);
  assert.deepEqual(dbg.failure?.stack.map((frame) => frame.name), ['a', 'b']);
});

test('a call that fails on arity reports itself as the frame', () => {
  const dbg = new Debugger('fn one(x) { return x }\none(1, 2)\n');
  dbg.run();
  assert.equal(dbg.status, 'error');
  assert.equal(dbg.failure?.message, 'one expects 1 argument, got 2');
  assert.deepEqual(dbg.failure?.stack.map((frame) => frame.name), ['one']);
});

test('inspect quotes strings so they read apart from numbers', () => {
  assert.equal(inspect('1'), '"1"');
  assert.equal(inspect(1), '1');
  assert.equal(inspect(undefined), 'nothing');
});

test('the trace records one mark per step, enters and exits balanced', () => {
  const dbg = new Debugger('1 + 2');
  dbg.run();
  assert.equal(dbg.trace.length, dbg.stepCount);
  const enters = dbg.trace.filter((mark) => mark.phase === 'enter').length;
  assert.equal(enters, dbg.trace.length / 2, 'every enter should have its exit');
  assert.equal(dbg.depth, 0, 'and the tree should be fully closed by the end');
});

test('a node enters and exits at the same depth, so a subtree reads as an arch', () => {
  const dbg = new Debugger('1 + 2');
  dbg.run();
  // Program, ExpressionStatement, BinaryExpression, then each operand in turn
  // at the same level: up to 4 and back twice, not a staircase.
  const depths = dbg.trace.map((mark) => mark.depth);
  assert.deepEqual(depths, [1, 2, 3, 4, 4, 4, 4, 3, 2, 1]);
});

test('depth grows with the call stack', () => {
  const dbg = new Debugger(ADD);
  advanceTo(dbg, atEnterOf('ReturnStatement', 3));
  const insideCall = dbg.depth;
  dbg.run();
  const outermost = dbg.trace[0].depth;
  assert.ok(insideCall > outermost + 3, 'a call should nest several levels deeper than the program');
});

test('reset clears the trace with everything else', () => {
  const dbg = new Debugger(COUNTER);
  dbg.run();
  assert.ok(dbg.trace.length > 0);
  dbg.reset();
  assert.deepEqual(dbg.trace, []);
  assert.equal(dbg.depth, 0);
  assert.equal(dbg.dropped, 0);
});

test('a long run caps the trace and counts what fell off the front', () => {
  const dbg = new Debugger('let i = 0\nwhile (i < 400) {\n  i = i + 1\n}\n');
  dbg.run();
  assert.equal(dbg.status, 'done');
  assert.ok(dbg.stepCount > 4000, 'the loop should outrun the cap');
  assert.ok(dbg.trace.length <= 4000);
  assert.equal(dbg.dropped + dbg.trace.length, dbg.stepCount);
});
