// @ts-check

/** @typedef {import('./env.js').Env} Env */
/** @typedef {import('./values.js').Value} Value */
/** @typedef {import('./heap.js').Handle} Handle */
/** @typedef {import('./vm.js').Frame} Frame */
/** @typedef {import('./vm.js').Machine} Machine */

/**
 * One write, remembered by what it overwrote. Nothing here says what the
 * instruction *did*. A journal that recorded intentions would have to know
 * how to invert each one, and inverting `pop` needs the value that came off,
 * which the instruction no longer has. Recording the previous state instead
 * makes undo the same three lines for every opcode there will ever be.
 * @typedef {{k: 'pc', frame: Frame, pc: number}} PcEntry
 * @typedef {{k: 'push'}} PushEntry
 * @typedef {{k: 'pop', value: Value}} PopEntry
 * @typedef {{k: 'truncate', values: Value[]}} TruncateEntry
 * @typedef {{k: 'framePush'}} FramePushEntry
 * @typedef {{k: 'framePop', frame: Frame}} FramePopEntry
 * @typedef {{k: 'scope', frame: Frame, env: Handle}} ScopeEntry
 * @typedef {{k: 'bind', env: Env, name: string, had: boolean, was: Value}} BindEntry
 * @typedef {{k: 'alloc', handle: Handle}} AllocEntry
 * @typedef {PcEntry|PushEntry|PopEntry|TruncateEntry|FramePushEntry|FramePopEntry|ScopeEntry|BindEntry|AllocEntry} Entry
 */

/**
 * How many instructions of history a recording journal keeps. Deep enough
 * that stepping back reaches anywhere you would step back *to* by hand;
 * shallow enough that a loop running for a million instructions doesn't turn
 * the debugger into a memory leak with a UI.
 */
export const JOURNAL_LIMIT = 1000;

/**
 * The VM's write-ahead log, and the part that makes it work at all: the only
 * thing that writes to the machine. Every mutation in the loop goes
 * through a method here, so "did we record that one?" is not a question
 * anybody has to keep answering as opcodes get added: an unrecorded write
 * would have to be an unwritten write.
 *
 * A journal with no limit records nothing and is the default, so the VM pays
 * for history only where something means to step back through it. That is
 * also why these methods perform the write themselves rather than returning
 * a receipt for the caller to file: the off switch has to leave one code
 * path, not two.
 */
export class Journal {
  /** @param {number} [limit] instructions of history to keep; 0 records none */
  constructor(limit = 0) {
    this.limit = limit;
    /** Entries per instruction, oldest first. @type {Entry[][]} */
    this.steps = [];
    /** Instructions that fell off the front once the limit was reached. */
    this.dropped = 0;
  }

  /** @returns {boolean} */
  get recording() {
    return this.limit > 0;
  }

  /**
   * Open a step. Called once per instruction, before it runs, because "the
   * previous instruction boundary" is exactly what undo has to find.
   *
   * The frame's `pc` is recorded here rather than at each assignment to it:
   * every instruction moves a pc, an instruction only ever moves the pc of
   * the frame it belongs to, and that frame is on top when the step opens.
   * @param {Frame} frame
   */
  mark(frame) {
    if (!this.recording) return;
    if (this.steps.length >= this.limit) {
      // A quarter at a time rather than one per step: shifting a thousand
      // entries off the front on every instruction is the kind of cost that
      // only shows up as "the debugger got slow" much later.
      const drop = Math.max(1, Math.floor(this.limit / 4));
      this.steps.splice(0, drop);
      this.dropped += drop;
    }
    this.steps.push([{ k: 'pc', frame, pc: frame.pc }]);
  }

  /**
   * File an entry under the open step. Silently does nothing when the VM is
   * running unrecorded, which is what keeps the call sites free of `if`.
   * @param {Entry} entry
   */
  record(entry) {
    if (!this.recording) return;
    const step = this.steps[this.steps.length - 1];
    // No open step means this write is the machine being set up rather than
    // an instruction running, and set-up is what `reset` undoes.
    if (step !== undefined) step.push(entry);
  }

  /**
   * @param {Value[]} stack
   * @param {Value} value
   */
  push(stack, value) {
    this.record({ k: 'push' });
    stack.push(value);
  }

  /**
   * @param {Value[]} stack
   * @returns {Value}
   */
  pop(stack) {
    const value = stack.pop();
    this.record({ k: 'pop', value });
    return value;
  }

  /**
   * Drop everything above `length`, which is how a call clears its arguments and how
   * a return unwinds to where the call began.
   * @param {Value[]} stack
   * @param {number} length
   */
  truncate(stack, length) {
    if (this.recording) this.record({ k: 'truncate', values: stack.slice(length) });
    stack.length = length;
  }

  /**
   * @param {Frame[]} frames
   * @param {Frame} frame
   */
  pushFrame(frames, frame) {
    this.record({ k: 'framePush' });
    frames.push(frame);
  }

  /**
   * @param {Frame[]} frames
   * @returns {Frame}
   */
  popFrame(frames) {
    const frame = /** @type {Frame} */ (frames.pop());
    this.record({ k: 'framePop', frame });
    return frame;
  }

  /**
   * Move a frame to another scope, which is all a block entry or exit is.
   * @param {Frame} frame
   * @param {Handle} env
   */
  scope(frame, env) {
    this.record({ k: 'scope', frame, env: frame.env });
    frame.env = env;
  }

  /**
   * Bind a name, whether that is a declaration or an assignment. The VM has
   * resolved which scope owns it by the time it gets here. Undo has to put
   * the value back in the same scope the write took it from, and one step
   * later the chain may no longer lead there.
   * @param {Env} env
   * @param {string} name
   * @param {Value} value
   */
  bind(env, name, value) {
    if (this.recording) this.record({ k: 'bind', env, name, had: env.hasOwn(name), was: env.vars.get(name) });
    env.define(name, value);
  }

  /**
   * A cell the running program just allocated. Undoing the instruction takes
   * the cell back, so stepping backwards and forwards over a loop doesn't
   * leave the heap a little larger each time round, which would make the
   * one number the collector is judged on depend on how much you fidgeted.
   *
   * Only allocations an instruction made are recorded. A constant, a builtin
   * and the scope chain the machine was loaded with belong to the code, and
   * the code does not change when you step back.
   * @param {Handle} handle
   */
  allocated(handle) {
    this.record({ k: 'alloc', handle });
  }

  /** Whether there is a boundary left to step back to. @returns {boolean} */
  get canUndo() {
    return this.steps.length > 0;
  }

  /**
   * Put the machine back the way it was one instruction ago.
   *
   * Entries are applied in reverse, which is the only ordering that works
   * when an instruction wrote to the same place twice. A return pops the
   * stack, truncates it and pushes to it, and undoing those in the order
   * they happened would leave the value in the wrong slot.
   *
   * What comes back is state, not position. The generator that was walking
   * this machine is still suspended one instruction further on and cannot be
   * moved; the caller drops it and starts a new one over the same machine,
   * which is only possible because the machine *is* the position.
   * @param {Machine} machine
   * @returns {boolean} whether there was anything to undo
   */
  undo(machine) {
    const step = this.steps.pop();
    if (step === undefined) return false;
    for (let i = step.length - 1; i >= 0; i--) {
      const entry = step[i];
      switch (entry.k) {
        case 'pc':
          entry.frame.pc = entry.pc;
          break;
        case 'push':
          machine.stack.pop();
          break;
        case 'pop':
          machine.stack.push(entry.value);
          break;
        case 'truncate':
          for (const value of entry.values) machine.stack.push(value);
          break;
        case 'framePush':
          machine.frames.pop();
          break;
        case 'framePop':
          machine.frames.push(entry.frame);
          break;
        case 'scope':
          entry.frame.env = entry.env;
          break;
        case 'bind':
          if (entry.had) entry.env.define(entry.name, entry.was);
          else entry.env.undefine(entry.name);
          break;
        case 'alloc':
          machine.heap.free(entry.handle);
          break;
      }
    }
    return true;
  }
}

/** The journal a VM gets when nobody is watching: same writes, no receipts. */
export const NO_JOURNAL = new Journal();
