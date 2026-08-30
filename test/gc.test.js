import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.js';
import { compile } from '../src/compile.js';
import { execute, load } from '../src/vm.js';
import { globals } from '../src/builtins.js';
import { Journal } from '../src/journal.js';
import { BLACK, collect, collectNow, GREY, WHITE } from '../src/gc.js';
import { Handle, HeapError, MIN_HEAP } from '../src/heap.js';
import { isCallable } from '../src/values.js';

/** @typedef {import('../src/vm.js').Machine} Machine */
/** @typedef {import('../src/vm.js').VmResult} VmResult */
/** @typedef {import('../src/values.js').Value} Value */

/**
 * Run a program to the end and hand back the machine it ran on, so a test can
 * ask the heap what is left.
 * @param {string} source
 * @param {Journal} [journal]
 * @returns {{machine: Machine, result: VmResult, output: string[]}}
 */
function ran(source, journal) {
  /** @type {string[]} */
  const output = [];
  const env = globals({ write: (line) => output.push(line) }).child();
  const machine = load(compile(parse(source)), env, journal);
  const iter = execute(machine);
  let step = iter.next();
  while (!step.done) step = iter.next();
  return { machine, result: step.value, output };
}

/**
 * The top-level scope's binding for `name`, as the program would see it.
 * @param {Machine} machine
 * @param {string} name
 * @returns {Value}
 */
function binding(machine, name) {
  const env = machine.heap.envOf(machine.frames[0].env);
  return machine.heap.read(/** @type {Value} */ (env.vars.get(name)));
}

test('a string nothing points at any more is collected', () => {
  // Two strings are built; only the second is still bound when the program
  // ends, so the first is exactly what a collector is for.
  const { machine } = ran('let s = "a" + "a" s = "b" + "b" s');
  const before = machine.heap.liveCount;
  const { freed } = collectNow(machine);
  assert.ok(freed > 0, 'nothing was collected');
  assert.equal(machine.heap.liveCount, before - freed);
  assert.equal(binding(machine, 's'), 'bb', 'the surviving binding should be untouched');
});

test('a closure and the scope it captured are collected together, cycle and all', () => {
  // makeCounter's call scope holds `inc`, and `inc` holds that scope. Nothing
  // outside points at either once the result is discarded, and a reference
  // count would never reach zero. Marking does not care.
  const { machine } = ran('fn makeCounter() { let n = 0 fn inc() { n = n + 1 return n } return inc } makeCounter() 0');
  const { freed } = collectNow(machine);
  assert.ok(freed >= 2, `expected the closure and its scope to go, freed ${freed}`);
});

test('a closure still bound keeps its captured scope alive', () => {
  const { machine } = ran('fn makeCounter() { let n = 7 fn inc() { n = n + 1 return n } return inc } let a = makeCounter() 0');
  collectNow(machine);

  const closure = binding(machine, 'a');
  assert.ok(isCallable(closure) && closure.type === 'closure', 'a should be bound to a closure');
  if (!isCallable(closure) || closure.type !== 'closure') return;
  // Reading through the captured scope is the assertion: if the collector had
  // swept it, this would throw rather than come back with n.
  const captured = machine.heap.envOf(closure.env);
  assert.equal(machine.heap.read(/** @type {Value} */ (captured.vars.get('n'))), 7);
});

test('constants and builtins are pinned, so a collection never takes them', () => {
  const { machine, output } = ran('print("hello") let junk = "x" + "y" 0');
  assert.deepEqual(output, ['hello']);
  const pinned = [...machine.heap.pinnedAddrs];
  collectNow(machine);
  for (const addr of pinned) {
    assert.notEqual(machine.heap.cells[addr], null, `pinned cell #${addr} was swept`);
  }
  assert.equal(binding(machine, 'print') === undefined, true, 'print lives in the builtins scope, not top level');
});

test('a value only on the operand stack survives a collection mid-expression', () => {
  // Paused between instructions with "ab" built and "cd" not yet started, the
  // only thing holding "ab" is the operand stack. Collecting from anywhere
  // that did not count it would lose it and the program would end wrong.
  const env = globals().child();
  const machine = load(compile(parse('("a" + "b") + ("c" + "d")')), env);
  const iter = execute(machine);

  let step = iter.next();
  let collected = false;
  while (!step.done) {
    if (!collected && machine.stack.some((word) => word instanceof Handle && machine.heap.read(word) === 'ab')) {
      collectNow(machine);
      collected = true;
    }
    step = iter.next();
  }
  assert.ok(collected, 'the test never found the intermediate on the stack');
  assert.deepEqual(step.value, { ok: true, value: 'abcd' });
});

test('the journal keeps a value the program has already overwritten', () => {
  const journal = new Journal(500);
  const { machine } = ran('let s = "ke" + "pt" s = "re" + "placed" s', journal);

  // Nothing in the machine points at "kept" any more. The journal does, and
  // stepping back has to be able to put it back.
  collectNow(machine);

  let found = false;
  while (journal.undo(machine)) {
    const word = machine.heap.envOf(machine.frames[0].env).vars.get('s');
    if (word !== undefined && machine.heap.read(word) === 'kept') {
      found = true;
      break;
    }
  }
  assert.ok(found, 'the value the journal was holding did not survive the collection');
});

test('and is collected once nothing is recording history', () => {
  // The same program with no journal. This is the contrast that shows the
  // root above is load-bearing rather than incidental.
  const { machine } = ran('let s = "ke" + "pt" s = "re" + "placed" s');
  const survivors = new Set();
  collectNow(machine);
  for (const cell of machine.heap.cells) if (cell !== null && cell.k === 'str') survivors.add(cell.text);
  assert.ok(!survivors.has('kept'), 'the overwritten string should have gone');
  assert.ok(survivors.has('replaced'), 'the current one should not have');
});

test('the free list hands the same address back, so undo and redo agree', () => {
  const journal = new Journal(200);
  const env = globals().child();
  const machine = load(compile(parse('let a = "x" + "y" let b = "p" + "q" b')), env, journal);

  const iter = execute(machine);
  let step = iter.next();
  while (!step.done) step = iter.next();

  const first = /** @type {Handle} */ (machine.heap.envOf(machine.frames[0].env).vars.get('b'));
  for (let i = 0; i < 6; i++) journal.undo(machine);

  const replay = execute(machine);
  let again = replay.next();
  while (!again.done) again = replay.next();
  const second = /** @type {Handle} */ (machine.heap.envOf(machine.frames[0].env).vars.get('b'));

  assert.equal(second.addr, first.addr, 'the same value landed at a different address after a step back');
  assert.notEqual(second.gen, first.gen, 'and the old handle should not still be valid');
  assert.throws(() => machine.heap.read(first), HeapError);
});

test('marking greys a cell before it blackens it, and ends with neither left', () => {
  const { machine } = ran('fn f() { return 1 } let g = f "s" + "s"');
  const iter = collect(machine);

  /** @type {Set<number>} */
  const seenGrey = new Set();
  let sawMark = false;
  let sawSweep = false;
  let step = iter.next();
  while (!step.done) {
    if (step.value.phase === 'mark') {
      sawMark = true;
      // The cell being worked on is grey at the moment it is yielded: it has
      // been reached, and this is the step that looks through it.
      assert.equal(machine.heap.colors[step.value.addr], GREY);
      seenGrey.add(step.value.addr);
    } else {
      sawSweep = true;
    }
    step = iter.next();
  }
  assert.ok(sawMark && sawSweep, 'the collection skipped a phase');
  assert.ok(seenGrey.size > 0);
  // Every surviving cell is back to white, ready for the next cycle.
  for (let addr = 0; addr < machine.heap.cells.length; addr++) {
    if (machine.heap.cells[addr] !== null) assert.equal(machine.heap.colors[addr], WHITE, `#${addr} was left marked`);
  }
  assert.notEqual(BLACK, WHITE);
});

test('the threshold grows with what survives', () => {
  const { machine } = ran('let s = "a" + "b" s');
  collectNow(machine);
  assert.equal(machine.heap.threshold, Math.max(MIN_HEAP, machine.heap.liveCount * 2));

  // A machine holding a lot has to be allowed to hold a lot before the next
  // walk, or the collection cost scales with the live set squared.
  machine.heap.liveCount = 5000;
  machine.heap.retarget();
  assert.equal(machine.heap.threshold, 10000);
});

test('stepping back over a collection restores the machine rather than crashing', () => {
  const journal = new Journal(1000);
  const source = 'let i = 0 let last = "" while (i < 60) { let s = "x" + i last = s i = i + 1 } last';
  const { machine, result } = ran(source, journal);
  assert.deepEqual(result, { ok: true, value: 'x59' });
  assert.ok(machine.heap.collections > 0, 'the loop never grew the heap enough to collect');

  // Every step back reads through handles the collector has already walked
  // past. A missed root shows up here as a HeapError, not as a wrong number.
  let steps = 0;
  while (journal.undo(machine)) steps++;
  assert.ok(steps > 100, `only ${steps} steps were undone`);

  const again = execute(machine);
  let step = again.next();
  while (!step.done) step = again.next();
  assert.deepEqual(step.value, { ok: true, value: 'x59' }, 'the replay disagreed with the first run');
});

test('a churn loop allocating 100k objects holds steady live-set size', () => {
  // Phase 7's "Done when". Every turn of the loop builds a string and a scope
  // and drops the previous ones, so the program allocates 100k times over and
  // is reachable from about twenty cells throughout.
  const source = 'let i = 0 let last = "" while (i < 100000) { let s = "x" + i last = s i = i + 1 } last';
  const env = globals().child();
  const machine = load(compile(parse(source)), env);
  const iter = execute(machine);

  let peakLive = 0;
  let step = iter.next();
  while (!step.done) {
    if (machine.heap.liveCount > peakLive) peakLive = machine.heap.liveCount;
    step = iter.next();
  }

  assert.deepEqual(step.value, { ok: true, value: 'x99999' });
  assert.ok(machine.heap.collections > 100, `only ${machine.heap.collections} collections ran`);
  // Steady: the live set never leaves the band the threshold sets, and the
  // free list means the heap never asks for more slots than that either.
  assert.ok(peakLive <= MIN_HEAP, `live set peaked at ${peakLive}`);
  assert.ok(machine.heap.size <= MIN_HEAP, `the heap grew to ${machine.heap.size} slots`);
});
