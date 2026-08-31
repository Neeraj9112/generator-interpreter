import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.js';
import { run as runTree } from '../src/evaluate.js';
import { compile, disassemble, META, OP } from '../src/compile.js';
import { execute, load, run as runVm, MAX_FRAMES, VmError } from '../src/vm.js';
import { globals } from '../src/builtins.js';
import { Handle } from '../src/heap.js';
import { Journal, JOURNAL_LIMIT } from '../src/journal.js';

/** @typedef {import('../src/vm.js').VmStep} VmStep */
/** @typedef {import('../src/vm.js').VmResult} VmResult */
/** @typedef {import('../src/vm.js').VmSuccess} VmSuccess */
/** @typedef {import('../src/values.js').Value} Value */

/**
 * @param {string} source
 * @param {(step: VmStep) => T} pick what to record at each pause point
 * @returns {{steps: T[], result: VmResult, output: string[]}}
 * @template T
 */
function trace(source, pick) {
  /** @type {string[]} */
  const output = [];
  const env = globals({ write: (line) => output.push(line) }).child();
  const iter = execute(load(compile(parse(source)), env));
  /** @type {T[]} */
  const steps = [];
  let step = iter.next();
  while (!step.done) {
    steps.push(pick(step.value));
    step = iter.next();
  }
  return { steps, result: step.value, output };
}

/**
 * @param {string} source
 * @returns {unknown}
 */
function evaluate(source) {
  return runVm(compile(parse(source)), globals().child());
}

test('the loop yields once per instruction, in the order they are listed', () => {
  const source = '1 + 2 * 3';
  const { steps, result } = trace(source, (step) => META[step.op].name);
  assert.deepEqual(steps, ['CONST', 'CONST', 'CONST', 'MUL', 'ADD', 'HALT']);
  assert.deepEqual(steps, disassemble(compile(parse(source))).map((line) => line.name));
  assert.deepEqual(result, { ok: true, value: 7 });
});

test('a pause happens before its instruction runs, not after', () => {
  const iter = execute(load(compile(parse('1 + 2')), globals().child()));
  const first = /** @type {VmStep} */ (iter.next().value);
  assert.equal(first.pc, 0);
  assert.equal(first.op, OP.CONST);
  assert.deepEqual(first.stack, [], 'nothing has been pushed yet');

  const second = /** @type {VmStep} */ (iter.next().value);
  assert.deepEqual(second.stack, [1], 'the first instruction ran between the two pauses');
});

test('every pause point maps back to a slice of the source', () => {
  const source = 'let n = 2\nprint(n + 1)';
  const { steps } = trace(source, (step) => source.slice(step.span.start, step.span.end));
  assert.deepEqual(new Set(steps), new Set(['2', 'let n = 2', 'print', 'n', '1', 'n + 1', 'print(n + 1)', source]));
});

test('the env at a pause point is the live scope chain rather than a copy', () => {
  const source = 'let a = 1 let b = 2';
  const { steps } = trace(source, (step) => [...step.env.vars.keys()].join(','));
  assert.equal(steps[0], '', 'nothing is bound before the first instruction');
  assert.equal(steps[steps.length - 1], 'a,b');
});

test('a call pushes a frame and a return pops it', () => {
  const { steps, result } = trace('fn f(a) { return a + 1 } f(1)', (step) => step.frames.map((frame) => frame.name).join('>'));
  assert.ok(steps.includes('<program>>f'), 'the callee never appeared on the frame stack');
  assert.equal(steps[0], '<program>');
  assert.equal(steps[steps.length - 1], '<program>', 'the frame stack came back balanced');
  assert.deepEqual(result, { ok: true, value: 2 });
});

test('a returning frame unwinds the operand stack to where its call began', () => {
  // The `1 +` leaves an operand pending across the call, which is exactly the
  // value `base` protects: a return truncates to it and pushes one thing.
  const { steps, result } = trace('fn f() { return 2 } 1 + f()', (step) => step.stack.length);
  assert.equal(Math.max(...steps), 2, 'nothing should pile up beyond the pending 1 and the callee');
  assert.deepEqual(result, { ok: true, value: 3 });
});

test('recursion is bounded by an array, not by the host call stack', () => {
  const source = 'fn down(n) { if (n == 0) { return 0 } return down(n - 1) } down(5000)';
  assert.equal(evaluate(source), 0);
  // The same program on the tree-walker, whose depth is a chain of suspended
  // generators on the JS stack. This is the limit Phase 5 exists to remove.
  assert.throws(() => runTree(parse(source), globals().child()), RangeError);
});

test('runaway recursion reports itself instead of exhausting memory', () => {
  assert.throws(
    () => evaluate('fn f() { return f() } f()'),
    (/** @type {VmError} */ error) => {
      assert.ok(error instanceof VmError);
      assert.equal(error.message, `too much recursion, over ${MAX_FRAMES} calls deep`);
      assert.equal(error.frames.length, MAX_FRAMES);
      return true;
    },
  );
});

test('a failure names the instruction it happened at', () => {
  const source = 'let n = 1\nn + true';
  const { result, output } = trace(source, (step) => step.pc);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(source.slice(result.span.start, result.span.end), 'n + true');
  assert.deepEqual(output, []);
});

test('the iterator can be abandoned halfway and its state still reads', () => {
  const iter = execute(load(compile(parse('let a = 1 let b = 2 let c = 3')), globals().child()));
  /** @type {import('../src/vm.js').VmStep|null} */
  let last = null;
  for (let i = 0; i < 6; i++) last = /** @type {VmStep} */ (iter.next().value);
  assert.ok(last !== null);
  assert.deepEqual([...last.env.vars.keys()], ['a', 'b']);
  // And it picks up again from exactly there.
  let step = iter.next();
  while (!step.done) step = iter.next();
  assert.deepEqual(step.value, { ok: true, value: 3 });
});

test('every value the machine can reach is a word, never a bare string', () => {
  const source = 'fn greet(who) { return "hi " + who } let g = greet("pip") g';
  const { steps } = trace(source, (step) => step.stack.every((word) => typeof word !== 'string' && typeof word !== 'object' || word instanceof Handle));
  assert.ok(steps.every(Boolean), 'something was pushed without going through the heap');
});

test('a closure and the scope it captured point at each other', () => {
  // The cycle that makes reference counting the wrong answer and marking the
  // right one: the scope binds the closure, and the closure holds the scope.
  const env = globals().child();
  const machine = load(compile(parse('fn f() { return 1 } f')), env);
  const iter = execute(machine);
  let step = iter.next();
  while (!step.done) step = iter.next();

  const { heap } = machine;
  const value = /** @type {VmSuccess} */ (step.value);
  const closure = /** @type {any} */ (value.value);
  assert.equal(closure.type, 'closure');
  const scope = heap.envOf(closure.env);
  assert.equal(heap.read(/** @type {Value} */ (scope.vars.get('f'))), closure, 'the scope should bind the closure back');
});

test('stepping back over a loop leaves the heap the size it was', () => {
  const journal = new Journal(JOURNAL_LIMIT);
  const machine = load(compile(parse('let i = 0 let s = "" while (i < 5) { s = s + i i = i + 1 } s')), globals().child(), journal);
  let iter = execute(machine);

  for (let i = 0; i < 30; i++) iter.next();
  const before = machine.heap.liveCount;

  for (let i = 0; i < 20; i++) iter.next();
  assert.ok(machine.heap.liveCount > before, 'the loop should have been making garbage');

  for (let i = 0; i < 20; i++) assert.ok(journal.undo(machine), 'the journal ran out inside its own limit');
  assert.equal(machine.heap.liveCount, before, 'stepping back should hand the cells back too');
});
