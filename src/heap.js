// @ts-check

/** @typedef {import('./env.js').Env} Env */
/** @typedef {import('./values.js').Value} Value */
/** @typedef {import('./values.js').Callable} Callable */
/** @typedef {import('./compile.js').Chunk} Chunk */
/** @typedef {import('./journal.js').Journal} Journal */

/**
 * The three colours a cell can be during a collection. They live here because
 * the array that holds them does; what they *mean*, and the invariant that
 * keeps a mark phase honest, belong to `gc.js`.
 */
export const WHITE = 0;
export const GREY = 1;
export const BLACK = 2;

/** @type {Record<number, string>} */
export const COLOR_NAME = { [WHITE]: 'white', [GREY]: 'grey', [BLACK]: 'black' };

/**
 * The smallest the collection threshold ever gets. Below this a program is
 * cheaper to leave alone than to walk, and a threshold that can reach zero
 * collects on every allocation.
 */
export const MIN_HEAP = 64;

/**
 * How much the live set has to grow before the next collection. Two is the
 * usual answer: it bounds the wasted space at the size of the live set and
 * gives each collection twice as much garbage to justify its walk.
 */
export const HEAP_GROWTH = 2;

/**
 * A pointer into the heap, and the only way to reach anything in it.
 *
 * `addr` is the slot. `gen` is how many times that slot has been handed out,
 * which is what stops a freed handle from quietly aliasing whatever moved in
 * afterwards. Reuse a slot without it and a stale pointer starts reading a
 * live object of some other shape. The check costs one comparison and turns
 * the worst class of collector bug into an exception with an address on it.
 */
export class Handle {
  /**
   * @param {number} addr
   * @param {number} gen
   */
  constructor(addr, gen) {
    this.addr = addr;
    this.gen = gen;
  }

  /** @returns {string} */
  toString() {
    return `#${this.addr}`;
  }
}

/**
 * What a slot holds. Three kinds, which is every kind of thing in Pip that
 * is bigger than a machine word:
 *
 * - `str`: an immutable string. Immutable, and still allocated: `"x" + i`
 *   in a loop is where a program makes garbage fastest.
 * - `fn`: anything callable. A closure carries the address of the scope it
 *   captured, which is the one edge in here a collector has to follow; a
 *   builtin carries none.
 * - `env`: a scope. `parent` duplicates the link `Env` already holds, in
 *   handle form, because a collector tracing the chain needs to reach the
 *   *cell*, not the JS object. Both links are written in one place, so they
 *   cannot drift apart.
 *
 * @typedef {{k: 'str', text: string}} StringCell
 * @typedef {{k: 'fn', fn: Callable}} FnCell
 * @typedef {{k: 'env', env: Env, parent: Handle|null}} EnvCell
 * @typedef {StringCell|FnCell|EnvCell} Cell
 */

/**
 * A pointer that no longer points anywhere: either the slot was freed, or it
 * was freed and handed out again to something else. Not a Pip error, since no
 * program can cause one. It means the VM or the collector has a bug, and the
 * address is the first thing you would want to know about it.
 */
export class HeapError extends Error {
  /**
   * @param {string} message
   * @param {Handle} handle
   */
  constructor(message, handle) {
    super(message);
    this.name = 'HeapError';
    this.handle = handle;
  }
}

/**
 * The VM's own storage, and, once Phase 7b lands a collector, the thing it can
 * reclaim from. An array of slots with a generation counter each.
 *
 * The point of moving off JS references is not to be faster. It is that a
 * reference you cannot see is a reference you cannot trace: with values
 * behind handles, every edge between two objects is an integer in a cell,
 * so "what is still reachable" becomes a question something can walk and a
 * UI can draw. JS keeps owning the bytes; we own the graph.
 *
 * The tree-walker has no heap and needs none. It keeps plain JS values, JS
 * collects them, and the contrast is half of what makes the VM's heap worth
 * looking at.
 */
export class Heap {
  /**
   * @param {Journal} journal the log allocations are recorded in, so stepping
   *   backwards over an allocation takes the cell back too
   */
  constructor(journal) {
    /** Slot contents; `null` is a slot nothing lives in. @type {(Cell|null)[]} */
    this.cells = [];
    /** How many times each slot has been handed out. @type {number[]} */
    this.gens = [];
    this.journal = journal;
    /**
     * Envs handed in from outside, so interning a chain twice doesn't give
     * the same scope two cells. Weak because a scope the program has finished
     * with should not be kept alive by the table that remembers it.
     * @type {WeakMap<Env, Handle>}
     */
    this.interned = new WeakMap();
    /**
     * A chunk's constants, allocated once and shared by every execution of
     * the instruction that names them. That is what a constant pool is for:
     * `while (…) { print("tick") }` allocates the string once, not once per
     * turn of the loop, and the cell is immortal because the code holds it.
     * @type {WeakMap<Chunk, Value[]>}
     */
    this.pools = new WeakMap();
    /** How many slots hold something, kept as a count rather than recomputed. */
    this.liveCount = 0;
    /**
     * Cells the code owns rather than the program: constants, builtins, the
     * scope chain the machine was loaded with. They are never swept and are
     * always traced, which is how the collector reaches a top-level binding
     * without having to enumerate a `WeakMap` it cannot iterate.
     * @type {number[]}
     */
    this.pinnedAddrs = [];
    /** Which slots are pinned, by address. @type {boolean[]} */
    this.pinned = [];
    /**
     * Addresses a sweep gave back, newest first. Reuse is deliberately
     * last-in-first-out: undoing an instruction and then redoing it then
     * lands the same value at the same address, so a heap view does not show
     * cells wandering every time you scrub the ribbon.
     * @type {number[]}
     */
    this.freeList = [];
    /**
     * The tricolor mark, by address, using the constants in `gc.js`. Kept on
     * the heap rather than inside the collector because the point of Phase 7
     * is to watch a collection happen: the pane reads these between steps.
     * @type {number[]}
     */
    this.colors = [];
    /**
     * The live count that triggers the next collection. Grows with the live
     * set after every sweep, so a program with a genuinely large working set
     * stops paying for collections that free nothing.
     */
    this.threshold = MIN_HEAP;
    /** Collections run, which is the number the churn loop is judged on. */
    this.collections = 0;
  }

  /** How many slots have ever been handed out. @returns {number} */
  get size() {
    return this.cells.length;
  }

  /**
   * Whether the heap has grown enough since the last sweep to be worth
   * walking again.
   * @returns {boolean}
   */
  get due() {
    return this.liveCount >= this.threshold;
  }

  /**
   * Set the bar for the next collection from what survived this one. A
   * multiple rather than a fixed step: the cost of a collection is a function
   * of the live set, so the interval between them has to be too, or a program
   * holding a million cells collects a million times.
   */
  retarget() {
    this.threshold = Math.max(MIN_HEAP, Math.ceil(this.liveCount * HEAP_GROWTH));
  }

  /**
   * Put a cell in a slot and hand back a pointer to it, without telling the
   * journal. For cells that belong to the *code* rather than to the step that
   * happened to reach them first: a constant, a builtin, the scope chain the
   * machine was loaded with. Stepping backwards past the instruction that
   * first touched a constant must not take the constant away. The pool still
   * points at it, and the next time round it would be reading a free slot.
   * @param {Cell} cell
   * @returns {Handle}
   */
  place(cell) {
    const handle = this.slot(cell);
    this.pinned[handle.addr] = true;
    this.pinnedAddrs.push(handle.addr);
    return handle;
  }

  /**
   * Take a slot, reusing one the sweep gave back if there is one. The
   * generation on a reused slot is whatever `free` left it at, which is what
   * makes the handle handed out here distinguishable from the one that
   * pointed at the same address before.
   * @param {Cell} cell
   * @returns {Handle}
   */
  slot(cell) {
    const reused = this.freeList.pop();
    const addr = reused === undefined ? this.cells.length : reused;
    this.cells[addr] = cell;
    if (reused === undefined) this.gens[addr] = 0;
    this.pinned[addr] = false;
    this.colors[addr] = WHITE;
    this.liveCount++;
    return new Handle(addr, this.gens[addr]);
  }

  /**
   * An allocation an instruction made, which stepping back over that
   * instruction should therefore undo. Everything a running program creates
   * comes through here.
   * @param {Cell} cell
   * @returns {Handle}
   */
  alloc(cell) {
    const handle = this.slot(cell);
    this.journal.allocated(handle);
    return handle;
  }

  /**
   * Empty a slot. Bumping the generation is what makes this safe: any handle
   * still pointing here now fails a check instead of reading whatever lands
   * in the slot next.
   * @param {Handle} handle
   */
  free(handle) {
    // Through the same check a read goes through, so freeing a slot twice or
    // freeing one through a stale pointer says so here rather than showing up
    // later as a live cell that has quietly gone missing.
    this.cell(handle);
    this.release(handle.addr);
  }

  /**
   * Empty a slot by address, skipping the handle check. The sweep is the one
   * caller entitled to this: it is holding the cell itself rather than a
   * pointer to it, and half the point of a collector is to reclaim cells no
   * live handle names any more.
   * @param {number} addr
   */
  release(addr) {
    this.cells[addr] = null;
    this.gens[addr]++;
    this.colors[addr] = WHITE;
    this.freeList.push(addr);
    this.liveCount--;
  }

  /**
   * The cell a handle points at.
   * @param {Handle} handle
   * @returns {Cell}
   */
  cell(handle) {
    const cell = this.cells[handle.addr];
    if (cell === null || cell === undefined) throw new HeapError(`handle ${handle} points at a free slot`, handle);
    if (this.gens[handle.addr] !== handle.gen) throw new HeapError(`handle ${handle} is stale`, handle);
    return cell;
  }

  /**
   * A handle's value as the rest of the language understands it: a string, a
   * closure, a builtin. Anything that isn't a handle is already a value and
   * comes back untouched, so the VM can call this on any slot without first
   * asking what is in it.
   *
   * This is one half of the discipline the VM runs on: *read at the point of
   * use*. `values.js` never sees a handle, which is why the operators, the
   * error wording and the tree-walker's semantics all stayed exactly as they
   * were when the heap arrived underneath them.
   * @param {Value} word
   * @returns {Exclude<Value, Handle>} never a handle, which is the whole promise
   */
  read(word) {
    if (!(word instanceof Handle)) return word;
    const cell = this.cell(word);
    if (cell.k === 'str') return cell.text;
    if (cell.k === 'fn') return cell.fn;
    throw new HeapError(`handle ${word} points at a scope, which is not a value`, word);
  }

  /**
   * The other half: *write at the point of storage*. A value that needs a
   * cell gets one; numbers, booleans and nothing are small enough to live in
   * the slot they are stored in and pass straight through.
   *
   * Idempotent on handles, so a value that has already been through here can
   * be passed again without allocating a second cell for it.
   * @param {Value} value
   * @param {boolean} [permanent] whether the cell belongs to the code rather
   *   than to the instruction storing it, see `place`
   * @returns {Value} a word: the value itself, or the address of its cell
   */
  write(value, permanent = false) {
    if (value instanceof Handle) return value;
    /** @type {Cell|null} */
    let cell = null;
    if (typeof value === 'string') cell = { k: 'str', text: value };
    else if (typeof value === 'object' && value !== null) cell = { k: 'fn', fn: value };
    if (cell === null) return value;
    return permanent ? this.place(cell) : this.alloc(cell);
  }

  /**
   * @param {Handle} handle
   * @returns {EnvCell}
   */
  scope(handle) {
    const cell = this.cell(handle);
    if (cell.k !== 'env') throw new HeapError(`handle ${handle} is not a scope`, handle);
    return cell;
  }

  /**
   * The scope a handle points at. The VM holds handles; everything that
   * *reads* a scope (name resolution, the inspector, a stack trace) wants the
   * `Env` itself, and gets it here.
   * @param {Handle} handle
   * @returns {Env}
   */
  envOf(handle) {
    return this.scope(handle).env;
  }

  /**
   * @param {Handle} handle
   * @returns {Handle|null}
   */
  parentOf(handle) {
    return this.scope(handle).parent;
  }

  /**
   * A fresh scope enclosed by `parent`, which is what a block entry and a
   * call both push. The `Env` link and the cell link are both set here, in this one
   * expression, which is the only reason keeping two copies of the same edge
   * is defensible.
   * @param {Handle} parent
   * @returns {Handle}
   */
  childEnv(parent) {
    return this.alloc({ k: 'env', env: this.envOf(parent).child(), parent });
  }

  /**
   * Take a scope chain built outside the VM (the builtins, and the scope a
   * program's own top-level bindings go in) and move it into the heap.
   *
   * The `Env` objects are kept, not copied, so anything else holding one
   * still holds the same scope. What changes is what is *in* them: every
   * binding is rewritten through `write`, so `print` becomes a cell like any
   * other function and the VM has no values left that live outside its heap.
   *
   * The machine takes ownership of the chain it is loaded with. That is worth
   * saying out loud, because it means the same globals cannot afterwards be
   * handed to the tree-walker, which would find handles where it expects
   * values. Every caller builds a fresh one per run.
   * @param {Env} env
   * @returns {Handle}
   */
  intern(env) {
    const existing = this.interned.get(env);
    if (existing !== undefined) return existing;
    const parent = env.parent === null ? null : this.intern(env.parent);
    const handle = this.place({ k: 'env', env, parent });
    this.interned.set(env, handle);
    for (const [name, value] of env.vars) env.vars.set(name, this.write(value, true));
    return handle;
  }

  /**
   * Constant `index` of `chunk`, allocated on first use and shared after
   * that. Only constants that `CONST` pushes come through here. The ones
   * `GET`, `SET` and `DEFINE` name are variable names rather than values,
   * and a name is not something a Pip program can hold.
   * @param {Chunk} chunk
   * @param {number} index
   * @returns {Value}
   */
  constant(chunk, index) {
    let pool = this.pools.get(chunk);
    if (pool === undefined) {
      pool = [];
      this.pools.set(chunk, pool);
    }
    if (!(index in pool)) pool[index] = this.write(chunk.constants[index], true);
    return pool[index];
  }
}
