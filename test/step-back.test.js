import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.js';
import { compile } from '../src/compile.js';
import { execute, load } from '../src/vm.js';
import { Journal } from '../src/journal.js';
import { globals } from '../src/builtins.js';
import { describe } from '../src/values.js';

/** @typedef {import('../src/env.js').Env} Env */
/** @typedef {import('../src/heap.js').Handle} Handle */
/** @typedef {import('../src/vm.js').Machine} Machine */
/** @typedef {import('../src/vm.js').VmStep} VmStep */

const COUNTER = `fn makeCounter() {
  let n = 0
  fn inc() {
    n = n + 1
    return n
  }
  return inc
}

let a = makeCounter()
print(a())
print(a())
`;

/**
 * A machine you can walk in either direction.
 *
 * Going back is two moves, not one: undo the journal, then throw away the
 * generator and start another over the same machine. The second half is the
 * part that only works because the machine holds the position. A suspended
 * generator has no seek.
 * @param {string} source
 * @param {Journal} [journal]
 */
function walk(source, journal = new Journal(1000)) {
  /** @type {string[]} */
  const output = [];
  const env = globals({ write: (line) => output.push(line) }).child();
  const machine = load(compile(parse(source)), env, journal);
  let iter = execute(machine);
  /** @type {import('../src/vm.js').VmResult|null} */
  let result = null;

  return {
    machine,
    output,
    get result() {
      return result;
    },
    /** @returns {VmStep|null} the next pause, or null once the program is over */
    next() {
      const step = iter.next();
      if (!step.done) return step.value;
      result = step.value;
      return null;
    },
    /** @returns {VmStep|null} the pause one instruction back, or null if the journal cannot reach it */
    back() {
      if (!machine.journal.undo(machine)) return null;
      iter = execute(machine);
      result = null;
      // Costs nothing: the loop yields before it runs anything, so this is
      // the machine describing where it is rather than taking a step.
      const step = iter.next();
      return step.done ? null : step.value;
    },
  };
}

/**
 * Everything about a machine that a program could tell had changed. Values
 * go in as text so a mismatch reads as one, and the scope chains come out
 * separately below to be compared by identity, because restoring a variable to the
 * right value in the wrong scope is exactly the bug this is watching for.
 * @param {Machine} machine
 */
function snapshot(machine) {
  return {
    stack: machine.stack.map(describe),
    frames: machine.frames.map((frame) => ({
      name: frame.name,
      chunk: frame.chunk.name,
      pc: frame.pc,
      base: frame.base,
      scopes: chain(machine, frame.env).map((env) => [...env.vars].map(([name, value]) => `${name}=${describe(machine.heap.read(value))}`)),
    })),
  };
}

/**
 * A frame's scope chain, walked through the heap rather than through the
 * `Env` objects' own `parent` links. Both routes lead to the same scopes,
 * and this is the one the machine itself uses: a chain of addresses.
 * @param {Machine} machine
 * @param {Handle} env
 * @returns {Env[]}
 */
function chain(machine, env) {
  /** @type {Env[]} */
  const scopes = [];
  /** @type {Handle|null} */
  let handle = env;
  while (handle !== null) {
    scopes.push(machine.heap.envOf(handle));
    handle = machine.heap.parentOf(handle);
  }
  return scopes;
}

/**
 * @param {Machine} machine
 * @returns {Env[]}
 */
function scopeObjects(machine) {
  return machine.frames.flatMap((frame) => chain(machine, frame.env));
}

test('stepping back twenty instructions restores the machine exactly', () => {
  const walker = walk(COUNTER);
  for (let i = 0; i < 15; i++) assert.ok(walker.next() !== null, 'the counter demo is shorter than this test assumes');

  const before = snapshot(walker.machine);
  const scopes = scopeObjects(walker.machine);

  for (let i = 0; i < 20; i++) assert.ok(walker.next() !== null, 'the program ended before it could be stepped back');
  for (let i = 0; i < 20; i++) assert.ok(walker.back() !== null, 'the journal ran out inside its own limit');

  assert.deepEqual(snapshot(walker.machine), before);
  const restored = scopeObjects(walker.machine);
  assert.equal(restored.length, scopes.length);
  // Identity, not contents: a closure shares the scope it captured, so a
  // rebuilt-but-equal env would quietly split the two counters apart.
  restored.forEach((env, index) => assert.equal(env, scopes[index], `scope ${index} came back as a different object`));
});

test('a rewound machine walks forward over exactly the steps it took the first time', () => {
  const walker = walk(COUNTER);
  /** @type {string[]} */
  const seen = [];
  for (let step = walker.next(); step !== null; step = walker.next()) seen.push(fingerprint(step));
  const finished = walker.result;

  /** @type {VmStep|null} */
  let step = null;
  for (let i = 0; i < 20; i++) step = walker.back();
  assert.ok(step !== null);

  /** @type {string[]} */
  const again = [];
  // `back` has already landed on a pause, so the walk forward starts from
  // where it put us rather than by taking another step.
  for (; step !== null; step = walker.next()) again.push(fingerprint(step));

  assert.equal(again.length, 20);
  assert.deepEqual(again, seen.slice(-20));
  assert.deepEqual(walker.result, finished, 'the rerun did not come to the same end');
});

/**
 * @param {VmStep} step
 * @returns {string}
 */
function fingerprint(step) {
  return `${step.chunk.name}@${step.pc} frames=${step.frames.length} stack=${step.stack.map(describe).join(',')}`;
}

test('stepping back from a finished program lands on the instruction that ended it', () => {
  const walker = walk('1 + 2');
  while (walker.next() !== null) {
    // run it out
  }
  assert.deepEqual(walker.result, { ok: true, value: 3 });

  const step = walker.back();
  assert.ok(step !== null);
  assert.deepEqual(step.stack, [3], 'HALT should be about to take the answer off the stack again');
  assert.equal(walker.next(), null, 'and running on should end the program the same way');
  assert.deepEqual(walker.result, { ok: true, value: 3 });
});

test('stepping back from a failure lands on the instruction that failed', () => {
  const walker = walk('let n = 1\nn + true');
  while (walker.next() !== null) {
    // run it out
  }
  const failed = walker.result;
  assert.ok(failed !== null && !failed.ok);

  const step = walker.back();
  assert.ok(step !== null);
  // The failing instruction popped two operands before it found out they
  // would not add, and those pops were journalled like any other.
  assert.deepEqual(step.stack.map(describe), ['number 1', 'boolean true']);
  assert.equal(walker.next(), null);
  const again = walker.result;
  assert.ok(again !== null && !again.ok);
  assert.equal(again.message, failed.message, 'and it fails again the same way');
});

test('there is nothing to step back to before the first instruction', () => {
  const walker = walk('1 + 2');
  walker.next();
  assert.equal(walker.machine.journal.canUndo, false);
  assert.equal(walker.back(), null);
});

test('the journal keeps a bounded window, and says so by refusing to go past it', () => {
  const walker = walk('let n = 0\nwhile (n < 200) { n = n + 1 }', new Journal(8));
  while (walker.next() !== null) {
    // run it out
  }
  const journal = walker.machine.journal;
  assert.ok(journal.steps.length <= 8, `kept ${journal.steps.length} steps for a limit of 8`);
  assert.ok(journal.dropped > 100, 'a two-hundred-iteration loop should have dropped most of its history');

  let reached = 0;
  while (walker.back() !== null) reached++;
  assert.ok(reached > 0 && reached <= 8, `stepped back ${reached} times against a limit of 8`);
});

test('what a native did to the world is not the journal to undo', () => {
  const walker = walk('print("once")');
  while (walker.next() !== null) {
    // run it out
  }
  assert.deepEqual(walker.output, ['once']);

  // Stepping back over the call puts the stack back but not the line that
  // was printed: the journal never saw the sink. Whoever owns an append-only
  // log owns putting it back, and for a log that is a truncation, which is
  // what the debugger does with its output pane.
  while (walker.back() !== null) {
    // all the way to the start
  }
  assert.deepEqual(walker.output, ['once']);
});
