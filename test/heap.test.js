import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Env } from '../src/env.js';
import { Handle, Heap, HeapError } from '../src/heap.js';
import { Journal, NO_JOURNAL } from '../src/journal.js';
import { compile } from '../src/compile.js';
import { parse } from '../src/parser.js';
import { globals } from '../src/builtins.js';

/** @returns {Heap} */
function heap() {
  return new Heap(NO_JOURNAL);
}

test('numbers, booleans and nothing stay in the slot they are stored in', () => {
  const h = heap();
  for (const value of [0, 1, -3.5, true, false, undefined]) {
    assert.equal(h.write(value), value, `${String(value)} should not need a cell`);
    assert.equal(h.read(value), value);
  }
  assert.equal(h.liveCount, 0, 'an immediate should not have allocated anything');
});

test('a string goes into a cell and comes back out the same string', () => {
  const h = heap();
  const word = h.write('hello');
  assert.ok(word instanceof Handle);
  assert.equal(h.read(word), 'hello');
  assert.equal(h.liveCount, 1);
});

test('two equal strings get two cells, because nothing here interns', () => {
  const h = heap();
  const a = h.write('x');
  const b = h.write('x');
  assert.notEqual(a, b);
  assert.notEqual(/** @type {Handle} */ (a).addr, /** @type {Handle} */ (b).addr);
  assert.equal(h.read(a), h.read(b), 'and equality is still about what they say');
});

test('writing a handle again hands the same one back', () => {
  const h = heap();
  const word = h.write('once');
  assert.equal(h.write(word), word);
  assert.equal(h.liveCount, 1, 'the second write should not have allocated');
});

test('reading a freed slot fails loudly rather than quietly', () => {
  const h = heap();
  const word = /** @type {Handle} */ (h.write('gone'));
  h.free(word);
  assert.throws(() => h.read(word), HeapError);
  assert.equal(h.liveCount, 0);
});

test('a handle to a reused slot is stale, not an alias for whatever moved in', () => {
  const h = heap();
  const first = /** @type {Handle} */ (h.write('first'));
  h.free(first);
  // Standing in for the free list Phase 7b adds: the same address, handed out
  // again. Without the generation, `first` would now read "second".
  h.cells[first.addr] = { k: 'str', text: 'second' };
  h.gens[first.addr]++;
  assert.throws(() => h.read(first), /stale/);
});

test('a scope is not a value, and asking for it as one says so', () => {
  const h = heap();
  const root = h.intern(new Env());
  assert.throws(() => h.read(root), /not a value/);
  assert.ok(h.envOf(root) instanceof Env);
});

test('a child scope links to its parent through the heap and through the env alike', () => {
  const h = heap();
  const root = h.intern(new Env());
  const child = h.childEnv(root);
  assert.equal(h.parentOf(child), root, 'the cell should point at the parent cell');
  assert.equal(h.envOf(child).parent, h.envOf(root), 'and the env at the parent env');
  assert.equal(h.parentOf(root), null);
});

test('interning keeps the scopes it was given and moves their bindings into cells', () => {
  const h = heap();
  const env = globals().child();
  const before = env.parent;
  const handle = h.intern(env);

  assert.equal(h.envOf(handle), env, 'the scope itself should not have been copied');
  assert.equal(h.envOf(/** @type {Handle} */ (h.parentOf(handle))), before);
  const print = /** @type {Env} */ (before).vars.get('print');
  assert.ok(print instanceof Handle, 'print should have moved into a cell');
  assert.equal(/** @type {any} */ (h.read(print)).name, 'print');
});

test('interning the same chain twice gives the same cells', () => {
  const h = heap();
  const env = globals().child();
  assert.equal(h.intern(env), h.intern(env));
  assert.equal(h.liveCount, 3, 'two scopes and one builtin, counted once each');
});

test('a constant is allocated once however often its instruction runs', () => {
  const h = heap();
  const chunk = compile(parse('"tick"'));
  const index = chunk.constants.indexOf('tick');
  assert.equal(h.constant(chunk, index), h.constant(chunk, index));
  assert.equal(h.liveCount, 1);
});

test('stepping back takes back what the step allocated', () => {
  const journal = new Journal(10);
  const h = new Heap(journal);
  const machine = /** @type {any} */ ({ stack: [], frames: [], heap: h });

  const permanent = h.write('a constant', true);
  journal.mark(/** @type {any} */ ({ pc: 0 }));
  const temporary = h.write('made by an instruction');
  assert.equal(h.liveCount, 2);

  journal.undo(machine);
  assert.equal(h.liveCount, 1, 'only the instruction\'s cell should have gone');
  assert.equal(h.read(permanent), 'a constant');
  assert.throws(() => h.read(temporary), HeapError);
});
