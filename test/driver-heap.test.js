import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Debugger } from '../web/driver.js';
import { BLACK, GREY, WHITE } from '../src/gc.js';

const COUNTER = `fn makeCounter() {
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
print(b())
`;

const CHURN = `let i = 0
let last = ""
while (i < 400) {
  let s = "x" + i
  last = s
  i = i + 1
}
print(last)
`;

/**
 * @param {string} source
 * @param {string} backend
 * @returns {Debugger}
 */
function make(source, backend) {
  return new Debugger(source, { backend });
}

test('the tree-walker has no heap to show, and the VM does', () => {
  assert.equal(make(COUNTER, 'tree').heapView(), null);
  const view = make(COUNTER, 'vm').heapView();
  assert.notEqual(view, null);
  assert.ok(/** @type {NonNullable<typeof view>} */ (view).size > 0, 'the machine should be loaded before the first step');
});

test('the heap view names what is in every slot', () => {
  const dbg = make(COUNTER, 'vm');
  dbg.run();
  const view = /** @type {NonNullable<ReturnType<Debugger['heapView']>>} */ (dbg.heapView());

  const kinds = new Set(view.cells.map((cell) => cell.kind));
  assert.ok(kinds.has('fn'), 'the closures should be cells');
  assert.ok(kinds.has('env'), 'so should the scopes');
  assert.ok(view.cells.some((cell) => cell.pinned), 'print and the constants are pinned');
  assert.ok(view.cells.some((cell) => cell.label.startsWith('<fn ')), 'a cell should say what it holds');
  assert.equal(view.live, view.cells.filter((cell) => cell.kind !== 'free').length);
});

test('stepping the collector greys and blackens cells before sweeping', () => {
  const dbg = make(COUNTER, 'vm');
  dbg.run();

  assert.equal(dbg.collecting, false);
  assert.ok(dbg.stepCollect(), 'a collection should have started');
  assert.equal(dbg.collecting, true);

  let sawGrey = false;
  let sawBlack = false;
  let guard = 0;
  while (dbg.collecting && guard++ < 10000) {
    const view = /** @type {NonNullable<ReturnType<Debugger['heapView']>>} */ (dbg.heapView());
    if (view.cells.some((cell) => cell.color === GREY)) sawGrey = true;
    if (view.cells.some((cell) => cell.color === BLACK)) sawBlack = true;
    dbg.stepCollect();
  }
  assert.ok(sawGrey, 'nothing was ever grey');
  assert.ok(sawBlack, 'nothing was ever blackened');

  // Every cell is back to white once it is over, ready for the next cycle.
  const after = /** @type {NonNullable<ReturnType<Debugger['heapView']>>} */ (dbg.heapView());
  assert.ok(after.cells.every((cell) => cell.color === WHITE), 'a mark was left behind');
  assert.equal(after.collections, 1);
});

test('finishing a collection is the same as stepping it to the end', () => {
  const stepped = make(COUNTER, 'vm');
  stepped.run();
  while (stepped.stepCollect());

  const finished = make(COUNTER, 'vm');
  finished.run();
  finished.stepCollect();
  finished.settleCollection();

  assert.equal(finished.collecting, false);
  const a = /** @type {NonNullable<ReturnType<Debugger['heapView']>>} */ (stepped.heapView());
  const b = /** @type {NonNullable<ReturnType<Debugger['heapView']>>} */ (finished.heapView());
  assert.equal(b.live, a.live);
  assert.equal(b.collections, a.collections);
});

test('moving the program settles a half-stepped collection first', () => {
  // A heap left marked but not swept is not one an instruction may run
  // against, and a user who clicks step mid-collection means to run the
  // program, not to be told they cannot.
  const dbg = make(COUNTER, 'vm');
  for (let i = 0; i < 20; i++) dbg.step();
  dbg.stepCollect();
  assert.equal(dbg.collecting, true);

  dbg.step();
  assert.equal(dbg.collecting, false, 'stepping should have finished the collection');
  const view = /** @type {NonNullable<ReturnType<Debugger['heapView']>>} */ (dbg.heapView());
  assert.ok(view.cells.every((cell) => cell.color === WHITE));
});

test('reset abandons a collection along with everything else', () => {
  const dbg = make(COUNTER, 'vm');
  dbg.run();
  dbg.stepCollect();
  dbg.reset();
  assert.equal(dbg.collecting, false);
  assert.equal(/** @type {NonNullable<ReturnType<Debugger['heapView']>>} */ (dbg.heapView()).collections, 0);
});

test('the heap view says how much of itself the undo log is holding', () => {
  // The debugger records history, and history is a root, so a program that
  // has made garbage still cannot free it while stepping back would need it.
  // Drawing that is the honest way to explain why a debugger's heap frees so
  // much less than the same program run from a script.
  const dbg = make(CHURN, 'vm');
  dbg.run();

  const view = /** @type {NonNullable<ReturnType<Debugger['heapView']>>} */ (dbg.heapView());
  assert.ok(view.held > 0, 'the journal should be holding some of the churn alive');
  assert.ok(view.cells.some((cell) => cell.history), 'and the view should say which cells');
  assert.ok(view.held < view.live, 'but not the whole heap');
});

test('a collection during a run leaves stepping back working', () => {
  const dbg = make(CHURN, 'vm');
  dbg.run();
  assert.equal(dbg.status, 'done');
  assert.deepEqual(dbg.output, ['x399']);
  assert.ok(/** @type {NonNullable<ReturnType<Debugger['heapView']>>} */ (dbg.heapView()).collections > 0);

  // Reads through handles the collector has already walked past. A root it
  // missed shows up here rather than as a wrong number on screen.
  const target = dbg.stepCount - 200;
  assert.ok(dbg.back(target), 'stepping back should have moved');
  assert.equal(dbg.stepCount, target);
  assert.equal(dbg.status, 'paused');

  dbg.run();
  assert.deepEqual(dbg.output, ['x399'], 'the replay disagreed with the first run');
});
