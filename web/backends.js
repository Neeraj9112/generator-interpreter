// @ts-check
import { evaluate, isSignal } from '../src/evaluate.js';
import { compile, disassemble, formatLine, META, OP } from '../src/compile.js';
import { execute, load } from '../src/vm.js';
import { Journal, JOURNAL_LIMIT } from '../src/journal.js';

/** @typedef {import('../src/parser.js').Program} Program */
/** @typedef {import('../src/parser.js').Span} Span */
/** @typedef {import('../src/compile.js').Chunk} Chunk */
/** @typedef {import('../src/env.js').Env} Env */
/** @typedef {import('../src/values.js').Value} Value */

/**
 * What the debugger needs to know about a pause point, whichever backend it
 * came from. Two very different things produce this — a node the tree-walker
 * is about to enter, an instruction the VM is about to run — and the UI is
 * built entirely on the shape rather than on either of them.
 *
 * `env` is the live scope chain, not a copy, so an inspector reading it sees
 * the moment as it actually stands.
 * @typedef {{
 *   span: Span,
 *   env: Env,
 *   label: string,
 *   phase: 'enter'|'exit',
 *   depth: number,
 *   callDepth: number,
 *   call: boolean,
 * }} Pause
 */

/** One entry in the call-stack pane. @typedef {{name: string, line: number}} Frame */

/** @typedef {{message: string, span: Span, frames: Frame[]}} Failure */

/** @typedef {{ok: true, value: Value}|{ok: false, message: string, span: Span}} Outcome */

/** @typedef {{done: false, pause: Pause}|{done: true, outcome: Outcome}} Advance */

/** Reading source positions, which both backends need and neither owns. @typedef {{lineOf: (index: number) => number, text: (span: Span) => string}} Source */

/**
 * The tree-walker as a backend.
 *
 * Everything here that looks like bookkeeping is bookkeeping the VM gets for
 * free. Nesting depth is counted by watching yields go past; the call stack
 * is reconstructed from `CallExpression` steps, because the real one is the
 * JS call stack and cannot be read.
 */
export class TreeBackend {
  /**
   * @param {Program} program
   * @param {Env} env
   * @param {Source} source
   */
  constructor(program, env, source) {
    this.source = source;
    this.iterator = evaluate(program, env);
    /** @type {Frame[]} */
    this.frames = [];
    /** @type {Failure|null} */
    this.failure = null;
    this.depth = 0;
  }

  /** The tree-walker has no instructions to show. @returns {null} */
  code() {
    return null;
  }

  /** Nothing here can be taken back a step. @returns {number} */
  get reach() {
    return 0;
  }

  /**
   * The tree-walker cannot step back, and this is not an omission.
   *
   * A journal restores data, and data is not where this backend keeps its
   * position: that lives in the JS call stack and a chain of suspended
   * generators, one per node being evaluated. Nothing can rewind a suspended
   * generator, and nothing can reconstruct one either. The driver's answer
   * is to replay the program from the start instead — no journal, and
   * trivially correct as long as nothing in the language is non-deterministic.
   * @returns {null}
   */
  back() {
    return null;
  }

  /** @returns {Advance} */
  next() {
    const result = this.iterator.next();
    if (result.done) {
      const completion = result.value;
      if (!isSignal(completion)) return { done: true, outcome: { ok: true, value: completion } };
      const outcome = { ok: /** @type {false} */ (false), message: completion.message, span: completion.node.span };
      this.failure ??= { ...outcome, frames: [] };
      return { done: true, outcome };
    }
    return { done: false, pause: this.observe(result.value) };
  }

  /**
   * @param {import('../src/evaluate.js').Step} step
   * @returns {Pause}
   */
  observe(step) {
    // A node's enter and its exit report the same depth, so a subtree draws
    // as a symmetric arch on the ribbon rather than as a staircase.
    let depth;
    if (step.phase === 'enter') {
      this.depth++;
      depth = this.depth;
    } else {
      depth = this.depth;
      this.depth--;
    }

    // Snapshotted before the stack moves, so a call that fails on its own
    // arity still reports itself as the frame it failed in.
    if (step.phase === 'exit' && isSignal(step.value) && step.value.kind === 'error' && this.failure === null) {
      this.failure = { message: step.value.message, span: step.value.node.span, frames: [...this.frames] };
    }

    const call = step.node.type === 'CallExpression';
    if (step.node.type === 'CallExpression') {
      if (step.phase === 'enter') {
        // Pushed at the call's enter step, before the callee and arguments
        // have been evaluated. Naming the frame after the callee's source
        // text is right whatever the expression is, `makeCounter()()` included.
        this.frames.push({
          name: this.source.text(step.node.callee.span),
          line: this.source.lineOf(step.node.span.start),
        });
      } else {
        this.frames.pop();
      }
    }

    return {
      span: step.node.span,
      env: step.env,
      label: step.node.type,
      phase: step.phase,
      depth,
      // The pause on a call's enter step belongs to the *caller*: its frame
      // went on above, and stepping over the call means waiting for that
      // frame to come off again.
      callDepth: call && step.phase === 'enter' ? this.frames.length - 1 : this.frames.length,
      call,
    };
  }
}

/**
 * The bytecode VM as a backend.
 *
 * The contrast with the class above is the point of Phase 5: there is no
 * bookkeeping in here. The call stack is read off the VM's own frame array,
 * and the failure already knows which instruction it happened at.
 */
export class VmBackend {
  /**
   * @param {Program} program
   * @param {Env} env
   * @param {Source} source
   */
  constructor(program, env, source) {
    this.source = source;
    this.chunk = compile(program);
    /**
     * A recording journal, which is the whole difference between this
     * backend and the same VM run from a script: history costs memory per
     * instruction, and a debugger is the one caller that means to spend it.
     */
    this.journal = new Journal(JOURNAL_LIMIT);
    this.machine = load(this.chunk, env, this.journal);
    this.iterator = execute(this.machine);
    /** @type {Frame[]} */
    this.frames = [];
    /** @type {Failure|null} */
    this.failure = null;
    /**
     * The chunk and offset the instruction pane is looking at. Seeded with
     * the entry chunk at zero so the listing is there before the first step
     * — switching to this backend should show you the program, not a blank
     * column — and left alone once execution ends, so the pane still shows
     * where it stopped.
     * @type {{chunk: Chunk, pc: number}}
     */
    this.shown = { chunk: this.chunk, pc: 0 };
    /** A chunk's instructions never change, so its listing is built once. @type {Map<Chunk, {pc: number, text: string}[]>} */
    this.listings = new Map();
  }

  /**
   * The instruction view: the chunk being executed, and where in it. Follows
   * the top frame, so stepping into a call swaps the listing to the callee's
   * body the way the source pane jumps to its lines.
   * @returns {{title: string, lines: {pc: number, text: string}[], pc: number}|null}
   */
  code() {
    const { chunk, pc } = this.shown;
    let lines = this.listings.get(chunk);
    if (lines === undefined) {
      lines = disassemble(chunk).map((line) => ({ pc: line.pc, text: formatLine(line) }));
      this.listings.set(chunk, lines);
    }
    return { title: `${chunk.name}(${chunk.params.join(', ')})`, lines, pc };
  }

  /** How many instructions the journal can still take back. @returns {number} */
  get reach() {
    return this.journal.steps.length;
  }

  /** @returns {Advance} */
  next() {
    const result = this.iterator.next();
    if (result.done) {
      const vm = result.value;
      if (vm.ok) return { done: true, outcome: { ok: true, value: vm.value } };
      this.failure = { message: vm.message, span: vm.span, frames: this.displayFrames(vm.frames) };
      return { done: true, outcome: { ok: false, message: vm.message, span: vm.span } };
    }
    return { done: false, pause: this.observe(result.value) };
  }

  /**
   * One instruction backwards: undo the write, then walk in again.
   *
   * The generator suspended at the pause we are leaving is finished with —
   * it holds a position we no longer want and there is no way to move it —
   * so it goes, and a fresh one picks the machine up wherever the journal
   * left it. Nothing runs: the loop yields before it executes, so the first
   * `next` is the machine saying where it is.
   * @returns {Pause|null} null when the journal no longer reaches this far back
   */
  back() {
    if (!this.journal.undo(this.machine)) return null;
    this.iterator = execute(this.machine);
    const result = this.iterator.next();
    if (result.done) return null;
    // Stepping back out of a failure means it has not happened yet.
    this.failure = null;
    return this.observe(result.value);
  }

  /**
   * @param {import('../src/vm.js').VmStep} step
   * @returns {Pause}
   */
  observe(step) {
    this.shown = { chunk: step.chunk, pc: step.pc };
    this.frames = this.displayFrames(step.frames);

    // Frame count alone would draw a flat ribbon for any program without
    // recursion. Adding the operand stack's height within the current frame
    // makes an expression rise and fall as it is assembled and consumed,
    // which is the same shape the tree-walker's nesting depth produces.
    const top = step.frames[step.frames.length - 1];
    return {
      span: step.span,
      env: step.env,
      label: META[step.op]?.name ?? `<${step.op}?>`,
      // Every pause is before its instruction runs, so every one is an
      // arrival. The tree-walker's two-phase step has no analogue here.
      phase: 'enter',
      depth: step.frames.length + (step.stack.length - top.base),
      callDepth: step.frames.length,
      call: step.op === OP.CALL,
    };
  }

  /**
   * The VM's frames, minus the one for the program itself, which is not a
   * call and which the pane shows as "(top level)" anyway.
   *
   * The stack pane reads differently on the two backends, and it should. This
   * one is the VM's own frame array: the function actually running, named
   * after itself, with no entry for a builtin because a builtin never gets a
   * frame. The tree-walker's is reconstructed from call *expressions*, pushed
   * before the callee has even been evaluated, so it names a frame after the
   * source text that called it and counts `print` as one. Neither is wrong.
   * What a debugger can tell you depends on what the runtime can be asked.
   * @param {import('../src/vm.js').Frame[]} frames
   * @returns {Frame[]}
   */
  displayFrames(frames) {
    return frames.slice(1).map((frame) => ({
      name: frame.name,
      line: this.source.lineOf(frame.callSpan.start),
    }));
  }
}

/** @type {Record<string, {label: string, create: (program: Program, env: Env, source: Source) => TreeBackend|VmBackend}>} */
export const BACKENDS = {
  tree: { label: 'tree-walker', create: (program, env, source) => new TreeBackend(program, env, source) },
  vm: { label: 'bytecode VM', create: (program, env, source) => new VmBackend(program, env, source) },
};
