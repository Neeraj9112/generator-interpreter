// @ts-check
import { BLACK, GREY, Handle, WHITE } from './heap.js';

// Re-exported so anything watching a collection imports the vocabulary from
// the module that owns the algorithm rather than from the one that owns the
// array of numbers.
export { BLACK, COLOR_NAME, GREY, WHITE } from './heap.js';

/** @typedef {import('./heap.js').Heap} Heap */
/** @typedef {import('./heap.js').Cell} Cell */
/** @typedef {import('./journal.js').Journal} Journal */
/** @typedef {import('./values.js').Value} Value */
/** @typedef {import('./vm.js').Machine} Machine */

/*
 * What the three colours mean, and the whole of the invariant a mark phase
 * maintains:
 *
 * - white: not known to be reachable. When marking ends, white means garbage
 *   and the sweep is allowed to take it.
 * - grey: reached, but not yet looked *through*. The worklist.
 * - black: reached, and everything it points at is at least grey.
 *
 * The rule that makes it work is that no black cell ever points at a white
 * one. Marking ends when no grey cells are left, and at that moment every
 * cell is black or white with nothing in between.
 */

/**
 * One observable moment inside a collection, so the collector can be watched
 * the same way the program can. `addr` is the cell the phase is working on,
 * and the counts are what a pane would put in its header.
 * @typedef {{
 *   phase: 'mark'|'sweep',
 *   addr: number,
 *   grey: number,
 *   marked: number,
 *   freed: number,
 * }} GcStep
 */

/** @typedef {{marked: number, freed: number, live: number}} GcResult */

/**
 * Every handle the machine can reach without going through another cell.
 *
 * Four sources, and the fourth is the one that is easy to miss:
 *
 * 1. The operand stack. Anything mid-expression lives here.
 * 2. Every frame's scope. Locals are bindings in a scope, so the scope chain
 *    is how "frame locals" are actually reachable, and a frame's cell knows
 *    its parent's address.
 * 3. Pinned cells: constants, builtins, the scope chain the machine was
 *    loaded with. Globals are in here, which is why they are not a separate
 *    case.
 * 4. **The journal.** A value the program has already overwritten is not
 *    reachable from the machine any more, and stepping back has to be able to
 *    put it back, so as long as the journal remembers a write it is holding
 *    the old value alive. Collect without this and the heap stays correct
 *    right up until you press back, at which point a binding is restored to
 *    an address that has been swept and handed to something else.
 *
 * That last one is the price of Phase 6 being real: history is a root set. It
 * is also why a debugger's heap frees less than a script's, since a thousand
 * instructions of undo keep a thousand instructions of garbage. The garbage
 * does eventually go, because entries fall off the front of the journal as the
 * program runs on.
 * @param {Machine} machine
 * @param {boolean} [history] whether the journal counts. Always true for a
 *   real collection; the heap view passes false to work out which cells are
 *   alive *only* because you can still step back to them.
 * @returns {Generator<Handle, void, void>}
 */
export function* roots(machine, history = true) {
  for (const word of machine.stack) if (word instanceof Handle) yield word;
  for (const frame of machine.frames) yield frame.env;

  const { heap } = machine;
  for (const addr of heap.pinnedAddrs) {
    if (heap.cells[addr] !== null) yield new Handle(addr, heap.gens[addr]);
  }

  if (history) yield* journalRoots(machine.journal);
}

/**
 * What the undo log is still holding on to. An entry records what a write
 * overwrote, so the values in here are exactly the ones the machine has
 * forgotten and the journal has not.
 * @param {Journal} journal
 * @returns {Generator<Handle, void, void>}
 */
function* journalRoots(journal) {
  for (const step of journal.steps) {
    for (const entry of step) {
      switch (entry.k) {
        case 'pc':
          // The frame this step moved. Usually on the machine already; not so
          // for a frame that has since returned, whose `framePop` entry below
          // is what puts it back.
          yield entry.frame.env;
          break;
        case 'pop':
          if (entry.value instanceof Handle) yield entry.value;
          break;
        case 'truncate':
          for (const value of entry.values) if (value instanceof Handle) yield value;
          break;
        case 'bind':
          if (entry.was instanceof Handle) yield entry.was;
          break;
        case 'scope':
          yield entry.env;
          break;
        case 'framePop':
          yield entry.frame.env;
          break;
        case 'alloc':
          // The cell this step created. Undoing the step frees it, and `free`
          // refuses a slot that is already empty, so sweeping it here would
          // turn a step backwards into a crash.
          yield entry.handle;
          break;
      }
    }
  }
}

/**
 * Everything a cell points at. Three kinds, and only two of them have edges:
 * a string is a leaf, a closure holds the scope it captured, and a scope
 * holds its parent plus whatever its names are bound to.
 * @param {Cell} cell
 * @returns {Generator<Handle, void, void>}
 */
function* edges(cell) {
  if (cell.k === 'fn') {
    if (cell.fn.type === 'closure') yield cell.fn.env;
    return;
  }
  if (cell.k === 'env') {
    if (cell.parent !== null) yield cell.parent;
    for (const value of cell.env.vars.values()) if (value instanceof Handle) yield value;
  }
}

/**
 * Mark and sweep, as a generator, so a collection can be watched a step at a
 * time for the same reason the evaluator can: the interesting thing about a
 * collector is not its answer, it is how it gets there.
 *
 * Marking is iterative rather than recursive. A deep scope chain would put a
 * frame on the JS stack per link otherwise, and the whole argument for the VM
 * in Phase 5 was that the host's call stack should not be what bounds us.
 * @param {Machine} machine
 * @returns {Generator<GcStep, GcResult, void>}
 */
export function* collect(machine) {
  const { heap } = machine;

  /** @type {number[]} */
  const grey = [];
  for (const root of roots(machine)) {
    // A stale root would mean the machine is holding a pointer to something
    // already freed, which is a bug in the VM rather than in the program.
    if (heap.cells[root.addr] === null || heap.colors[root.addr] !== WHITE) continue;
    heap.colors[root.addr] = GREY;
    grey.push(root.addr);
  }

  let marked = 0;
  while (grey.length > 0) {
    const addr = /** @type {number} */ (grey.pop());
    yield { phase: 'mark', addr, grey: grey.length, marked, freed: 0 };

    const cell = heap.cells[addr];
    if (cell === null || cell === undefined) continue;
    heap.colors[addr] = BLACK;
    marked++;

    for (const edge of edges(cell)) {
      if (heap.cells[edge.addr] === null || heap.colors[edge.addr] !== WHITE) continue;
      heap.colors[edge.addr] = GREY;
      grey.push(edge.addr);
    }
  }

  let freed = 0;
  for (let addr = 0; addr < heap.cells.length; addr++) {
    if (heap.cells[addr] === null) continue;
    yield { phase: 'sweep', addr, grey: 0, marked, freed };
    if (heap.pinned[addr]) {
      // Never collected, and still reset: a pinned cell has to start the next
      // cycle white like everything else or the second collection would treat
      // the first one's marks as its own.
      heap.colors[addr] = WHITE;
      continue;
    }
    if (heap.colors[addr] === WHITE) {
      heap.release(addr);
      freed++;
      continue;
    }
    heap.colors[addr] = WHITE;
  }

  heap.collections++;
  heap.retarget();
  return { marked, freed, live: heap.liveCount };
}

/**
 * Which cells are reachable right now, without touching the colours a
 * collection uses. Answers a question rather than reclaiming anything, which
 * is why it keeps its own marks: asking must not disturb a collection the
 * debugger has half-stepped through.
 * @param {Machine} machine
 * @param {boolean} [history] whether the journal counts as a root
 * @returns {Set<number>}
 */
export function reachable(machine, history = true) {
  const { heap } = machine;
  /** @type {Set<number>} */
  const seen = new Set();
  /** @type {number[]} */
  const grey = [];
  for (const root of roots(machine, history)) {
    if (heap.cells[root.addr] === null || seen.has(root.addr)) continue;
    seen.add(root.addr);
    grey.push(root.addr);
  }
  while (grey.length > 0) {
    const cell = heap.cells[/** @type {number} */ (grey.pop())];
    if (cell === null || cell === undefined) continue;
    for (const edge of edges(cell)) {
      if (heap.cells[edge.addr] === null || seen.has(edge.addr)) continue;
      seen.add(edge.addr);
      grey.push(edge.addr);
    }
  }
  return seen;
}

/**
 * Cells that are alive only because the journal remembers them: garbage by
 * the program's reckoning, and not yet collectable because stepping back has
 * to be able to put them back.
 *
 * Worth drawing rather than merely knowing. It is the cost of undo, made of
 * the same cells as everything else, and it explains why a debugger's heap
 * frees so much less than the same program run from a script.
 * @param {Machine} machine
 * @returns {Set<number>}
 */
export function heldByHistory(machine) {
  const withHistory = reachable(machine, true);
  const without = reachable(machine, false);
  for (const addr of without) withHistory.delete(addr);
  return withHistory;
}

/**
 * The collection a running machine performs on itself: same walk, drained
 * rather than watched. The VM calls this; the debugger steps the generator
 * above instead.
 * @param {Machine} machine
 * @returns {GcResult}
 */
export function collectNow(machine) {
  const iter = collect(machine);
  let step = iter.next();
  while (!step.done) step = iter.next();
  return step.value;
}
