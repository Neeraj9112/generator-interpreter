import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.js';
import { compile } from '../src/compile.js';
import { execute, load } from '../src/vm.js';
import { Journal } from '../src/journal.js';
import { SemanticError } from '../src/validate.js';
import { globals } from '../src/builtins.js';
import { describe } from '../src/values.js';
import { PROGRAMS } from './programs.js';

/** @typedef {import('../src/journal.js').Entry} Entry */
/** @typedef {import('../src/vm.js').VmResult} VmResult */

/**
 * Run a program to the end, keeping the pc of every pause point alongside
 * the journal the run built.
 * @param {string} source
 * @param {Journal} [journal]
 */
function run(source, journal = new Journal(1000)) {
  /** @type {string[]} */
  const output = [];
  const env = globals({ write: (line) => output.push(line) }).child();
  const machine = load(compile(parse(source)), env, journal);
  const iter = execute(machine);
  /** @type {number[]} */
  const pauses = [];
  let step = iter.next();
  while (!step.done) {
    pauses.push(step.value.pc);
    step = iter.next();
  }
  return { journal: machine.journal, machine, pauses, result: step.value, output };
}

/**
 * @param {Entry[]} entries
 * @returns {string[]}
 */
function kinds(entries) {
  return entries.map((entry) => entry.k);
}

test('a machine records nothing unless it is asked to', () => {
  const { journal } = run('let a = 1 let b = a + 1', new Journal());
  assert.equal(journal.recording, false);
  assert.deepEqual(journal.steps, [], 'the default journal kept history nobody asked for');
});

test('a step opens at every pause point and nowhere else', () => {
  const { journal, pauses } = run('let n = 0\nwhile (n < 3) { n = n + 1 }');
  // The marks and the pause points are the same sequence seen from two
  // sides: one instruction announced, then that instruction recorded. A
  // backwards jump is the case that makes this worth asserting: the pc has
  // to be where execution *was*, not the offset it moved by.
  assert.deepEqual(journal.steps.map((step) => step[0].k === 'pc' && step[0].pc), pauses);
});

test('every entry says what was there before, not what the instruction did', () => {
  const { journal } = run('let n = 1\nn = 2');
  const binds = journal.steps.flat().flatMap((entry) => (entry.k === 'bind' ? [[entry.name, entry.had, entry.was]] : []));
  assert.deepEqual(binds, [
    ['n', false, undefined],
    ['n', true, 1],
  ]);
});

test('a call journals the frame it pushed and the operands it consumed', () => {
  const { journal } = run('fn add(x, y) { return x + y } add(1, 2)');
  const all = kinds(journal.steps.flat());
  assert.ok(all.includes('framePush'), 'the call left no record of the frame it pushed');
  assert.ok(all.includes('framePop'), 'the return left no record of the frame it popped');
  assert.ok(all.includes('truncate'), 'the arguments came off the stack unrecorded');
});

test('a scope change is journalled against the frame that changed it', () => {
  const { journal, machine } = run('let a = 1\nif (true) { let b = 2 }');
  const scopes = journal.steps.flat().flatMap((entry) => (entry.k === 'scope' ? [entry] : []));
  assert.equal(scopes.length, 2, 'the block should have pushed one scope and popped it');
  for (const entry of scopes) assert.equal(entry.frame, machine.frames[0]);
});

/**
 * What a program came to, in a form that compares.
 * @param {VmResult} result
 * @returns {string}
 */
function outcome(result) {
  return result.ok ? describe(result.value) : result.message;
}

// Recording has to be invisible to the program being recorded, so the corpus
// gets run twice and the two answers compared, the same bargain the two
// backends are held to in backends.test.js.
for (const program of PROGRAMS) {
  test(`recording changes nothing: ${program.name}`, () => {
    let plain;
    try {
      plain = run(program.source, new Journal());
    } catch (error) {
      // Rejected before it ran, so there is nothing to record either way.
      assert.ok(error instanceof SemanticError);
      return;
    }
    const journalled = run(program.source);
    assert.equal(outcome(journalled.result), outcome(plain.result));
    assert.deepEqual(journalled.output, plain.output);
    assert.deepEqual(journalled.pauses, plain.pauses);
  });
}
