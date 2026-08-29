// @ts-check
import { parse } from '../src/parser.js';
import { validate } from '../src/validate.js';
import { globals, format } from '../src/builtins.js';
import { BACKENDS } from './backends.js';

/** @typedef {import('../src/parser.js').Program} Program */
/** @typedef {import('../src/parser.js').Span} Span */
/** @typedef {import('../src/values.js').Value} Value */
/** @typedef {import('../src/env.js').Env} Env */
/** @typedef {import('./backends.js').Pause} Pause */
/** @typedef {import('./backends.js').Frame} Frame */
/** @typedef {import('./backends.js').Failure} Failure */
/** @typedef {import('./backends.js').TreeBackend} TreeBackend */
/** @typedef {import('./backends.js').VmBackend} VmBackend */

/** @typedef {{depth: number, phase: 'enter'|'exit', line: number, call: boolean, output: number}} Mark */
/** @typedef {{label: string, bindings: {name: string, value: Value}[]}} Scope */
/** @typedef {'ready'|'paused'|'done'|'error'} Status */

/**
 * How a value reads in the inspector, where telling `1` from `"1"` matters
 * more than looking tidy. `print` makes the opposite trade — see `format`.
 * @param {Value} value
 * @returns {string}
 */
export function inspect(value) {
  return typeof value === 'string' ? JSON.stringify(value) : format(value);
}

/**
 * How many marks the ribbon keeps. A while loop yields without bound, and the
 * recent window is the part anyone reads, so the front gets dropped.
 *
 * Kept comfortably above `JOURNAL_LIMIT` on purpose: stepping back reads the
 * mark of the step it lands on, so the ribbon has to remember at least as far
 * as the journal can reach.
 */
const TRACE_LIMIT = 4000;

/**
 * Index of every line start, so a source index becomes a line number by
 * binary search instead of by counting newlines from the top. Stepping asks
 * for this on every step, and the linear version quietly makes each step
 * cost O(source).
 * @param {string} source
 * @returns {number[]}
 */
function lineStartsOf(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/**
 * Owns the execution and nothing else — no DOM, so the stepping rules are
 * testable under `node --test` rather than only by clicking. The UI reads
 * this and draws it; every decision about *where execution is* lives here.
 *
 * Which of the two backends is doing the executing is not one of those
 * decisions. This class asks for pause points and gets back the same shape
 * either way, so stepping, breakpoints, the ribbon and the stack pane are
 * written once. That is most of what Phase 5 changed up here: the debugger
 * turned out to need almost nothing from the tree-walker specifically.
 */
export class Debugger {
  /**
   * @param {string} source
   * @param {{breakpoints?: Iterable<number>, backend?: string}} [options]
   */
  constructor(source, options = {}) {
    this.source = source;
    /** Throws on source that doesn't parse or doesn't mean anything; the caller decides how to show that. */
    this.program = parse(source);
    // Both backends do this before running, so doing it here keeps a
    // misplaced `break` from looking like a property of the one selected.
    validate(this.program);

    this.lineStarts = lineStartsOf(source);
    this.lines = source.split('\n');

    /** Lines that halt a `run()`. Survives `reset`, like a real debugger. @type {Set<number>} */
    this.breakpoints = new Set(options.breakpoints ?? []);
    this.backendName = options.backend !== undefined && options.backend in BACKENDS ? options.backend : 'tree';

    /** @type {string[]} */
    this.output = [];
    /** @type {Pause|null} */
    this.current = null;
    /** @type {Status} */
    this.status = 'ready';
    /** @type {Value} */
    this.result = undefined;
    /** @type {Failure|null} */
    this.failure = null;
    this.stepCount = 0;
    /** @type {number|null} */
    this.previousLine = null;
    /** @type {Mark[]} */
    this.trace = [];
    this.depth = 0;
    /** Steps dropped off the front of the trace once it hit its cap. */
    this.dropped = 0;

    /** @type {Env} */
    this.globalEnv = this.freshGlobals();
    /** @type {Env} */
    this.programEnv = this.globalEnv.child();
    /** @type {TreeBackend|VmBackend} */
    this.backend = this.freshBackend();
  }

  /**
   * Builtins pointed at this debugger's output pane.
   * @returns {Env}
   */
  freshGlobals() {
    return globals({ write: (line) => this.output.push(line) });
  }

  /**
   * A backend over freshly built scopes. Top-level bindings get a scope of
   * their own below the builtins, so the inspector can tell the two apart.
   * @returns {TreeBackend|VmBackend}
   */
  freshBackend() {
    return BACKENDS[this.backendName].create(this.program, this.programEnv, {
      lineOf: (index) => this.lineOf(index),
      text: (span) => this.text(span),
    });
  }

  /** The name of the backend currently executing. @returns {string} */
  get backendLabel() {
    return BACKENDS[this.backendName].label;
  }

  /**
   * Switching backend restarts the program, because there is no way to carry
   * a position across: one of them is at a node and the other is at an
   * instruction, and neither knows what the other's position would mean.
   * Breakpoints and the source survive, which is what you actually want when
   * comparing the two on the same program.
   * @param {string} name
   */
  setBackend(name) {
    if (!(name in BACKENDS) || name === this.backendName) return;
    this.backendName = name;
    this.reset();
  }

  /** Back to the first step, keeping breakpoints. */
  reset() {
    this.output = [];
    this.current = null;
    this.status = 'ready';
    this.result = undefined;
    this.failure = null;
    this.stepCount = 0;
    this.previousLine = null;
    this.trace = [];
    this.depth = 0;
    this.dropped = 0;
    this.globalEnv = this.freshGlobals();
    this.programEnv = this.globalEnv.child();
    this.backend = this.freshBackend();
  }

  /** The call stack as the backend reports it. @returns {Frame[]} */
  get stack() {
    return this.backend.frames;
  }

  /** The instruction listing, on a backend that has one. */
  get code() {
    return this.backend.code();
  }

  /** @returns {boolean} */
  get canStep() {
    return this.status === 'ready' || this.status === 'paused';
  }

  /** 1-based line the current step starts on, or null before the first step. @returns {number|null} */
  get line() {
    return this.current === null ? null : this.lineOf(this.current.span.start);
  }

  /**
   * @param {number} index
   * @returns {number}
   */
  lineOf(index) {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  /**
   * @param {Span} span
   * @returns {string}
   */
  text(span) {
    return this.source.slice(span.start, span.end);
  }

  /**
   * One pause point. Everything else here is a loop around this.
   * @returns {boolean} whether execution is still live afterwards
   */
  step() {
    if (!this.canStep) return false;
    this.previousLine = this.line;
    const advance = this.backend.next();
    if (advance.done) {
      this.current = null;
      this.finish(advance.outcome);
      return false;
    }
    // Counted after the done check: the last advance yields nothing, and a
    // step the user never got to see should not show up in the count.
    this.stepCount++;
    this.status = 'paused';
    this.current = advance.pause;
    this.record(advance.pause);
    return true;
  }

  /**
   * Run until the line changes. A tree-walker step is half a node and a VM
   * step is one instruction; either way a debugger that takes ten clicks to
   * cross one line reads as broken rather than as precise.
   */
  stepLine() {
    const start = this.line;
    while (this.step() && this.line === start) {
      // still on the same line, keep going
    }
  }

  /**
   * Step a line without descending into a call. The base to come back to is
   * the depth of the frame this pause belongs to, which each backend reports
   * for itself: the tree-walker has already pushed the callee's frame by the
   * time it pauses on a call, and the VM has not.
   */
  stepOver() {
    const base = this.current === null ? 0 : this.current.callDepth;
    const start = this.line;
    while (this.step()) {
      if (this.current !== null && this.current.callDepth > base) continue;
      if (this.line === start) continue;
      break;
    }
  }

  /** Run to the end, or to the first breakpoint reached from another line. */
  run() {
    while (this.step()) {
      if (this.atBreakpoint()) break;
    }
  }

  /** How many steps back the backend can still take without re-running anything. @returns {number} */
  get reach() {
    return this.backend.reach;
  }

  /** @returns {boolean} */
  get canStepBack() {
    return this.stepCount > (this.current === null ? 0 : 1);
  }

  /**
   * One pause point backwards.
   *
   * A finished or failed program steps back onto its last live pause rather
   * than one before it: that pause is where you were standing when you set
   * it running, and the instruction it announced is the one that ended
   * things — which is the one you came back to look at.
   * @returns {boolean} whether it moved
   */
  stepBack() {
    return this.back(this.current === null ? this.stepCount : this.stepCount - 1);
  }

  /**
   * Rewind until step `target` is the one being paused on.
   * @param {number} target
   * @returns {boolean} whether it moved
   */
  back(target) {
    if (target < 1 || this.status === 'ready') return false;
    let moved = false;
    while (this.current === null || this.stepCount > target) {
      const pause = this.backend.back();
      // Either the backend cannot rewind at all, or its journal no longer
      // reaches this far. Both have the same answer, and the second is why
      // the cap does not turn into a wall.
      if (pause === null) return this.replay(target) || moved;
      this.rewind(pause);
      moved = true;
    }
    return moved;
  }

  /**
   * Step-back for a backend that cannot be rewound: throw the run away and
   * do it again, stopping one step short of where it was.
   *
   * No journal, and correct by construction — the second run is the first
   * run. What it costs is everything: each step back re-executes the whole
   * program up to that point, and on the tree-walker each of those steps
   * pays Phase 2's O(depth) `yield*` delegation. Fine at the scale a person
   * clicks at, and the first thing checkpointing would fix.
   *
   * It is only correct at all because Pip is deterministic. There is no
   * `rand`, no clock and no input, so a program has exactly one execution —
   * the day one of those arrives, its results have to be recorded and
   * replayed from the record.
   * @param {number} target
   * @returns {boolean} whether it landed on a pause
   */
  replay(target) {
    this.reset();
    while (this.stepCount < target && this.step()) {
      // forward from the beginning, again
    }
    return this.current !== null;
  }

  /**
   * Take the position back to the pause the backend has just restored.
   *
   * The backend put the *program* back; everything undone here is the
   * debugger's own accounting of it. The mark left on the ribbon by that step
   * is what the accounting is read from — it is the record of what this
   * moment looked like the first time through.
   * @param {Pause} pause
   */
  rewind(pause) {
    // A terminal state has one more mark than it has live steps, because the
    // step that ended the program yielded no pause of its own. Coming back
    // from one lands on the last pause without giving a step up.
    if (this.current !== null) {
      this.trace.pop();
      this.stepCount--;
    }
    this.current = pause;
    this.status = 'paused';
    this.result = undefined;
    this.failure = null;

    const mark = this.trace[this.trace.length - 1];
    this.depth = mark.depth;
    this.output.length = mark.output;
    // What a breakpoint compares against, so that running on from here stops
    // in the same places it would have the first time.
    this.previousLine = this.trace.length > 1 ? this.trace[this.trace.length - 2].line : null;
  }

  /**
   * A breakpoint fires on arriving at the line, not on every step taken
   * while sitting on it — otherwise a run stops ten times inside one
   * expression and never gets anywhere.
   * @returns {boolean}
   */
  atBreakpoint() {
    const here = this.current;
    if (here === null || here.phase !== 'enter') return false;
    const line = this.line;
    return line !== null && line !== this.previousLine && this.breakpoints.has(line);
  }

  /**
   * @param {number} line
   * @returns {boolean} whether the line now has a breakpoint
   */
  toggleBreakpoint(line) {
    if (this.breakpoints.delete(line)) return false;
    this.breakpoints.add(line);
    return true;
  }

  /**
   * The scope chain as it stands *now*, read from the live env the pause is
   * holding rather than from anything copied out of it. Innermost first,
   * which is the order a name resolves in.
   * @returns {Scope[]}
   */
  scopes() {
    /** @type {Scope[]} */
    const scopes = [];
    /** @type {Env|null} */
    let env = this.current === null ? this.programEnv : this.current.env;
    while (env !== null) {
      const label = env === this.globalEnv ? 'builtins' : env === this.programEnv ? 'top level' : 'local';
      scopes.push({ label, bindings: [...env.vars].map(([name, value]) => ({ name, value })) });
      env = env.parent;
    }
    return scopes;
  }

  /**
   * Append one mark to the trace, which is what the ribbon draws.
   *
   * The trace has no natural end, and a loop will grow it without limit, so
   * it keeps the most recent `TRACE_LIMIT` marks and counts what fell off.
   * Dropping a quarter at a time keeps that from costing a shift per step.
   * @param {Pause} pause
   */
  record(pause) {
    this.depth = pause.depth;
    this.trace.push({
      depth: pause.depth,
      phase: pause.phase,
      line: this.lineOf(pause.span.start),
      call: pause.call,
      // What the output pane looked like at this step. `print` writes to a
      // sink no backend has any way to take back, so stepping onto a mark
      // truncates the pane to the length that mark remembers — which works
      // because the pane is a log, and a log only ever grows.
      output: this.output.length,
    });
    if (this.trace.length > TRACE_LIMIT) {
      const drop = Math.floor(TRACE_LIMIT / 4);
      this.trace.splice(0, drop);
      this.dropped += drop;
    }
  }

  /**
   * @param {import('./backends.js').Outcome} outcome
   */
  finish(outcome) {
    // Nothing is paused any more, so there is no depth to report. Left at the
    // last pause's value it would read as though execution were still inside
    // something.
    this.depth = 0;
    if (outcome.ok) {
      this.status = 'done';
      this.result = outcome.value;
      return;
    }
    this.status = 'error';
    this.failure = this.backend.failure ?? { message: outcome.message, span: outcome.span, frames: [] };
  }
}
