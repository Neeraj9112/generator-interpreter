// @ts-check
import { parse } from '../src/parser.js';
import { evaluate, isSignal } from '../src/evaluate.js';
import { globals, format } from '../src/builtins.js';

/** @typedef {import('../src/parser.js').Program} Program */
/** @typedef {import('../src/parser.js').CallExpression} CallExpression */
/** @typedef {import('../src/parser.js').Span} Span */
/** @typedef {import('../src/evaluate.js').Node} Node */
/** @typedef {import('../src/evaluate.js').Step} Step */
/** @typedef {import('../src/evaluate.js').Value} Value */
/** @typedef {import('../src/evaluate.js').Completion} Completion */
/** @typedef {import('../src/env.js').Env} Env */

/** @typedef {{name: string, node: CallExpression, line: number}} Frame */
/** @typedef {{depth: number, phase: 'enter'|'exit', line: number, call: boolean}} Mark */
/** @typedef {{message: string, node: Node, stack: Frame[]}} Failure */
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
 */
const TRACE_LIMIT = 4000;

/**
 * Index of every line start, so a source index becomes a line number by
 * binary search instead of by counting newlines from the top. Stepping asks
 * for this on every `.next()`, and the linear version quietly makes each
 * step cost O(source).
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
 * Owns the iterator and nothing else — no DOM, so the stepping rules are
 * testable under `node --test` rather than only by clicking. The UI reads
 * this and draws it; every decision about *where execution is* lives here.
 */
export class Debugger {
  /**
   * @param {string} source
   * @param {{breakpoints?: Iterable<number>}} [options]
   */
  constructor(source, options = {}) {
    this.source = source;
    /** Throws ParseError on bad source; the caller decides how to show that. */
    this.program = parse(source);
    this.lineStarts = lineStartsOf(source);
    this.lines = source.split('\n');

    /** Lines that halt a `run()`. Survives `reset`, like a real debugger. @type {Set<number>} */
    this.breakpoints = new Set(options.breakpoints ?? []);

    /** @type {string[]} */
    this.output = [];
    /** @type {Frame[]} */
    this.stack = [];
    /** @type {Step|null} */
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

    /**
     * One entry per yield, which is what the ribbon draws. Depth is the
     * nesting of the node in the tree, and a node's enter and exit record the
     * same one, so a subtree reads as a symmetric arch rather than a staircase.
     * @type {Mark[]}
     */
    this.trace = [];
    this.depth = 0;
    /** Steps dropped off the front of the trace once it hit its cap. */
    this.dropped = 0;

    /** @type {Env} */
    this.globalEnv = this.freshGlobals();
    /** Top-level bindings get a scope of their own, so the inspector can tell them from the builtins. @type {Env} */
    this.programEnv = this.globalEnv.child();
    this.iterator = evaluate(this.program, this.programEnv);
  }

  /**
   * Builtins pointed at this debugger's output pane.
   * @returns {Env}
   */
  freshGlobals() {
    return globals({ write: (line) => this.output.push(line) });
  }

  /** Back to the first step, keeping breakpoints. */
  reset() {
    this.output = [];
    this.stack = [];
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
    this.iterator = evaluate(this.program, this.programEnv);
  }

  /** @returns {boolean} */
  get canStep() {
    return this.status === 'ready' || this.status === 'paused';
  }

  /** 1-based line the current step starts on, or null before the first step. @returns {number|null} */
  get line() {
    return this.current === null ? null : this.lineOf(this.current.node.span.start);
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
   * One `.next()`. Everything else here is a loop around this.
   * @returns {boolean} whether execution is still live afterwards
   */
  step() {
    if (!this.canStep) return false;
    this.previousLine = this.line;
    const result = this.iterator.next();
    if (result.done) {
      this.current = null;
      this.finish(result.value);
      return false;
    }
    // Counted after the done check: the last `.next()` yields nothing, and a
    // step the user never got to see should not show up in the count.
    this.stepCount++;
    this.status = 'paused';
    this.observe(result.value);
    return true;
  }

  /**
   * Run until the line changes. Two yields per node means `1 + 2 * 3` is ten
   * raw steps, and a debugger that takes ten clicks to cross one line reads
   * as broken rather than as precise.
   */
  stepLine() {
    const start = this.line;
    while (this.step() && this.line === start) {
      // still on the same line, keep going
    }
  }

  /**
   * Step a line without descending into a call. `base` is the depth to come
   * back to: when the pause point is a call's *enter* step its frame is
   * already pushed, so stepping over it means waiting for that frame to pop
   * rather than for the depth the stack has right now.
   */
  stepOver() {
    const here = this.current;
    const onCall = here !== null && here.phase === 'enter' && here.node.type === 'CallExpression';
    const base = onCall ? this.stack.length - 1 : this.stack.length;
    const start = this.line;
    while (this.step()) {
      if (this.stack.length > base) continue;
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
   * The scope chain as it stands *now*, read from the live env the step is
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
   * Track the call stack and the origin of a failure by watching steps go
   * past. The stack stays balanced even while an error unwinds: a signal is
   * a return value here, so every node it travels through still yields its
   * exit on the way out.
   * @param {Step} step
   */
  observe(step) {
    this.current = step;
    this.record(step);

    // Snapshot before the stack moves, so a call that fails on its own arity
    // still reports itself as the frame it failed in.
    if (step.phase === 'exit' && isSignal(step.value) && step.value.kind === 'error' && this.failure === null) {
      this.failure = { message: step.value.message, node: step.value.node, stack: [...this.stack] };
    }

    if (step.node.type !== 'CallExpression') return;
    if (step.phase === 'enter') {
      // Pushed at the call's enter step, which is before the callee and the
      // arguments have been evaluated — the frame shows up while the call is
      // still being assembled. Naming it after the callee's source text is
      // right whatever the expression is, including `makeCounter()()`.
      this.stack.push({
        name: this.text(step.node.callee.span),
        node: step.node,
        line: this.lineOf(step.node.span.start),
      });
    } else {
      this.stack.pop();
    }
  }

  /**
   * Append one mark to the trace. An `enter` opens a level and an `exit`
   * closes it, so `depth` is just how many enters are still open.
   *
   * The trace has no natural end, and a loop will grow it without limit, so
   * it keeps the most recent `TRACE_LIMIT` marks and counts what fell off.
   * Dropping a quarter at a time keeps that from costing a shift per step.
   * @param {Step} step
   */
  record(step) {
    let depth;
    if (step.phase === 'enter') {
      this.depth++;
      depth = this.depth;
    } else {
      depth = this.depth;
      this.depth--;
    }
    this.trace.push({
      depth,
      phase: step.phase,
      line: this.lineOf(step.node.span.start),
      call: step.node.type === 'CallExpression',
    });
    if (this.trace.length > TRACE_LIMIT) {
      const drop = Math.floor(TRACE_LIMIT / 4);
      this.trace.splice(0, drop);
      this.dropped += drop;
    }
  }

  /**
   * @param {Completion} completion
   */
  finish(completion) {
    if (!isSignal(completion)) {
      this.status = 'done';
      this.result = completion;
      return;
    }
    this.status = 'error';
    this.failure ??= { message: completion.message, node: completion.node, stack: [] };
  }
}
