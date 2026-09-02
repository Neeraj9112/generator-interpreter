// @ts-check
import { Debugger, inspect } from './driver.js';

/** @typedef {import('../src/parser.js').Span} Span */
/** @typedef {import('./driver.js').Status} Status */
/** @typedef {import('./driver.js').Mark} Mark */
/** @typedef {import('./driver.js').HeapView} HeapView */
/** @typedef {import('./backends.js').Frame} Frame */

/**
 * The wire format, which is DAP's: a request carries a `seq` the reply quotes
 * back in `request_seq`, and an event carries no reply at all. The two halves
 * are deliberately not symmetric, and that asymmetry is the point of the
 * shape. A debugger that only ever answered questions could be a function
 * call; what makes it a protocol is that the far side also volunteers things,
 * and "the program stopped" is the thing it volunteers.
 * @typedef {{seq: number, type: 'request', command: string, arguments?: any}} DapRequest
 */

/** @typedef {{seq: number, type: 'response', request_seq: number, command: string, success: boolean, message?: string, body?: any}} DapResponse */

/** @typedef {{seq: number, type: 'event', event: string, body?: any}} DapEvent */

/** Anything the adapter side sends. @typedef {DapResponse|DapEvent} Outbound */

/**
 * A refusal the client is meant to show rather than log.
 *
 * DAP lets a failed response carry a body as well as a message, which is the
 * only reason "parse error" and "rejected" can stay distinguishable across
 * the boundary: an exception's class does not survive being cloned, and
 * `err.name` is the whole difference between a typo and a misplaced `break`.
 */
export class AdapterError extends Error {
  /**
   * @param {string} message
   * @param {string} label
   */
  constructor(message, label) {
    super(message);
    this.name = 'AdapterError';
    this.label = label;
  }
}

/**
 * Everything about the run that isn't a stack, a scope or a heap. DAP has no
 * request like this, and a real adapter would not need one: VS Code already
 * knows what it asked for and draws chrome of its own. This page draws the
 * execution itself, so it has to be told.
 * @typedef {{
 *   loaded: boolean,
 *   running: boolean,
 *   status: Status,
 *   stepCount: number,
 *   line: number|null,
 *   span: Span|null,
 *   label: string|null,
 *   phase: 'enter'|'exit'|null,
 *   depth: number,
 *   dropped: number,
 *   reach: number,
 *   rewindsBy: 'journal'|'replay',
 *   canStep: boolean,
 *   canStepBack: boolean,
 *   collecting: boolean,
 *   backend: string,
 *   backendLabel: string,
 *   breakpoints: number[],
 *   output: string[],
 *   result: string|null,
 *   failure: {message: string, span: Span}|null,
 * }} StateBody
 */

/** @typedef {{name: string, variablesReference: number, namedVariables: number}} ScopeRef */

/**
 * How many pause points a motion takes before handing control back.
 *
 * The number is a latency budget, not a performance one. Between two slices
 * the adapter drains its message queue, so this is how long a `pause` can sit
 * unanswered while a `while (true)` runs: a few milliseconds at this size.
 */
const SLICE = 2000;

/**
 * Hand the host's event loop one turn.
 *
 * `setTimeout` rather than a resolved promise on purpose: a microtask runs
 * before the queue is looked at again, so awaiting one would spin without
 * ever letting a message in. Only a macrotask boundary lets `onmessage`
 * fire, and letting `onmessage` fire is the entire reason this exists.
 * @returns {Promise<void>}
 */
function breathe() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * The debug adapter: a `Debugger` behind a message interface.
 *
 * Nothing in here touches the DOM and nothing in here knows about a Worker.
 * It takes plain objects and returns plain objects, which is what makes the
 * same class runnable in a worker, in a test, and, if the optional VS Code
 * adapter ever happens, over a socket.
 *
 * The rule the whole class is built to keep: **nothing live crosses this
 * boundary.** Every answer is structured-clonable. That constraint is what
 * turned `Pause.env` from a field the inspector read into a `scopes` request
 * the inspector asks, and it is why real debuggers look the way they do.
 */
export class Session {
  /**
   * @param {(message: Outbound) => void} send how an event or response leaves
   */
  constructor(send) {
    this.send = send;
    /** @type {Debugger|null} */
    this.dbg = null;
    /** Sequence numbers for what this side originates. */
    this.seq = 0;
    /** Whether a motion is in flight, so a second one can be refused rather than interleaved. */
    this.running = false;
    /** Set by `pause`, read between slices. */
    this.interrupt = false;

    /**
     * Live `variablesReference` handles.
     *
     * DAP hands out an opaque number for a scope and expects it back on a
     * `variables` request, and the number is only good until the program
     * moves. That is not ceremony: the reference stands for a scope that
     * exists *at this pause*, and a step can leave it. Cleared on every stop,
     * so a stale reference fails loudly instead of quietly answering with a
     * scope that has already been popped.
     * @type {Map<number, {label: string, bindings: {name: string, value: string}[]}>}
     */
    this.refs = new Map();
    this.nextRef = 1;
  }

  /**
   * Answer one request.
   *
   * Motion commands are the interesting case: they answer *immediately*, with
   * an acknowledgement rather than a result, and the result arrives later as
   * a `stopped` or `terminated` event. That is how DAP works and it is not an
   * accident. A `continue` over an infinite loop has no result to wait for,
   * and a client blocked waiting for one could never send the `pause` that
   * ends it.
   * @param {DapRequest} request
   * @returns {Promise<DapResponse>}
   */
  async handle(request) {
    const args = request.arguments ?? {};
    try {
      const body = await this.dispatch(request.command, args);
      return this.reply(request, true, body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const label = err instanceof AdapterError ? err.label : 'failed';
      return this.reply(request, false, { label }, message);
    }
  }

  /**
   * @param {DapRequest} request
   * @param {boolean} success
   * @param {any} [body]
   * @param {string} [message]
   * @returns {DapResponse}
   */
  reply(request, success, body, message) {
    /** @type {DapResponse} */
    const response = { seq: ++this.seq, type: 'response', request_seq: request.seq, command: request.command, success };
    if (body !== undefined) response.body = body;
    if (message !== undefined) response.message = message;
    return response;
  }

  /**
   * @param {string} event
   * @param {any} [body]
   */
  fire(event, body) {
    this.send({ seq: ++this.seq, type: 'event', event, body });
  }

  /**
   * @param {string} command
   * @param {any} args
   * @returns {Promise<any>}
   */
  async dispatch(command, args) {
    switch (command) {
      case 'initialize':
        return this.initialize();
      case 'launch':
        return this.launch(args);
      case 'setBreakpoints':
        return this.setBreakpoints(args);
      case 'stepIn':
        return this.move(args.granularity === 'line' ? 'line' : 'step');
      case 'next':
        return this.move('over');
      case 'continue':
        return this.move('run');
      case 'stepBack':
        return this.move('back');
      case 'pause':
        return this.pause();
      case 'restart':
        return this.restart();
      case 'stackTrace':
        return this.stackTrace();
      case 'scopes':
        return this.scopes();
      case 'variables':
        return this.variables(args);
      case 'disassemble':
        return this.disassemble();
      case 'pip/state':
        return this.state();
      case 'pip/trace':
        return this.trace(args);
      case 'pip/heap':
        return this.heap();
      case 'pip/backend':
        return this.setBackend(args);
      case 'pip/collect':
        return this.collect(args);
      case 'pip/goto':
        return this.goto(args);
      default:
        throw new Error(`unknown command '${command}'`);
    }
  }

  /**
   * What this adapter can do, asked before anything else is.
   *
   * Written in DAP's own capability names because they are the ones that
   * happen to be true here. `supportsStepBack` is the flag VS Code reads to
   * decide whether to draw a reverse-step button at all. The button was never
   * the hard part; being able to answer yes to this was.
   * @returns {object}
   */
  initialize() {
    return {
      supportsStepBack: true,
      supportsRestartRequest: true,
      supportsSteppingGranularity: true,
      supportsDisassembleRequest: true,
      supportsConfigurationDoneRequest: false,
      exceptionBreakpointFilters: [],
    };
  }

  /** The debugger, or a failure that says the program was never loaded. @returns {Debugger} */
  get live() {
    if (this.dbg === null) throw new Error('no program loaded');
    return this.dbg;
  }

  /** Refuse to interleave two motions. */
  idle() {
    if (this.running) throw new Error('a motion is already running');
  }

  /**
   * Load a program. Source that doesn't parse is a failed response, not a
   * thrown error the far side has to reconstruct. The label is what the UI
   * puts in the status line.
   * @param {{source: string, backend?: string, breakpoints?: number[]}} args
   * @returns {object}
   */
  launch(args) {
    this.idle();
    const breakpoints = args.breakpoints ?? (this.dbg === null ? [] : [...this.dbg.breakpoints]);
    try {
      this.dbg = new Debugger(args.source, { breakpoints, backend: args.backend });
    } catch (err) {
      this.dbg = null;
      // A SemanticError is not a parse error, and calling it one sends you
      // hunting for a typo in a line that is spelled correctly.
      const label = err instanceof Error && err.name === 'ParseError' ? 'parse error' : 'rejected';
      throw new AdapterError(err instanceof Error ? err.message : String(err), label);
    }
    this.invalidate();
    this.fire('initialized');
    return {};
  }

  /**
   * @param {{lines: number[]}} args
   * @returns {object}
   */
  setBreakpoints(args) {
    const dbg = this.live;
    dbg.breakpoints = new Set(args.lines);
    // Every line is verifiable here because a breakpoint is a line number and
    // nothing else. There is no "nearest executable line" to slide onto.
    return { breakpoints: args.lines.map((line) => ({ line, verified: true })) };
  }

  /**
   * Start a motion and acknowledge it. The stop arrives as an event.
   * @param {'step'|'line'|'over'|'run'|'back'} kind
   * @returns {object}
   */
  move(kind) {
    this.idle();
    const dbg = this.live;
    this.interrupt = false;
    this.running = true;
    if (kind === 'run') this.fire('continued');
    // Deliberately not awaited: the acknowledgement has to get back out
    // before the loop starts, or a `pause` could never overtake it.
    void this.pump(dbg, kind);
    return {};
  }

  /**
   * Run one motion to its end, a slice at a time, then announce where it
   * stopped.
   * @param {Debugger} dbg
   * @param {'step'|'line'|'over'|'run'|'back'} kind
   */
  async pump(dbg, kind) {
    /** @type {'step'|'breakpoint'|'pause'} */
    let reason = 'step';
    // One turn before anything moves, so the acknowledgement is already on
    // its way out when the stop is announced. DAP clients match a response to
    // the request that asked for it; an event that overtakes its own
    // acknowledgement arrives as a stop for a step nobody has been told
    // started yet.
    await breathe();
    try {
      if (kind === 'back') {
        dbg.stepBack();
      } else if (kind === 'step') {
        dbg.step();
      } else {
        // Decided once, so resuming after a slice does not re-anchor the rule
        // to wherever the slice happened to end.
        const more = dbg.motion(kind);
        for (;;) {
          const outcome = dbg.advance(more, SLICE);
          if (outcome === 'stopped') {
            reason = kind === 'run' ? 'breakpoint' : 'step';
            break;
          }
          if (outcome === 'ended') break;
          await breathe();
          if (this.interrupt) {
            reason = 'pause';
            break;
          }
        }
      }
    } catch (err) {
      // Nothing in the debugger is supposed to throw, since a Pip error becomes
      // a status rather than an exception, so reaching here means the adapter
      // broke. Say so: `pump` runs unawaited, and an unhandled rejection in a
      // worker is a UI that silently stops responding.
      this.running = false;
      this.fire('pip/crashed', { message: err instanceof Error ? err.message : String(err) });
      return;
    } finally {
      this.running = false;
      this.interrupt = false;
      this.invalidate();
    }
    this.announce(reason);
  }

  /**
   * @param {'step'|'breakpoint'|'pause'|'entry'} reason
   */
  announce(reason) {
    const dbg = this.live;
    if (dbg.status === 'done') {
      this.fire('terminated', { result: inspect(dbg.result) });
      return;
    }
    if (dbg.status === 'error') {
      this.fire('stopped', { reason: 'exception', line: dbg.line, description: dbg.failure?.message ?? 'error' });
      return;
    }
    this.fire('stopped', { reason, line: dbg.line, description: dbg.current?.label ?? null });
  }

  /**
   * Ask a running motion to stop at its next slice boundary.
   *
   * The one request that has to be answerable while the adapter is busy, and
   * the reason `pump` gives the event loop a turn between slices at all. On
   * the main thread this could not work: the loop would hold the thread and
   * the click would land after it finished. Off it, the message is already
   * waiting.
   * @returns {object}
   */
  pause() {
    if (!this.running) throw new Error('nothing is running');
    this.interrupt = true;
    return {};
  }

  /** @returns {object} */
  restart() {
    this.idle();
    this.live.reset();
    this.invalidate();
    this.fire('stopped', { reason: 'entry', line: null, description: null });
    return {};
  }

  /**
   * @param {{backend: string}} args
   * @returns {object}
   */
  setBackend(args) {
    this.idle();
    this.live.setBackend(args.backend);
    this.invalidate();
    this.fire('stopped', { reason: 'entry', line: null, description: null });
    return {};
  }

  /**
   * @param {{target: number}} args
   * @returns {object}
   */
  goto(args) {
    this.idle();
    this.live.back(args.target);
    this.invalidate();
    this.announce('step');
    return {};
  }

  /**
   * @param {{finish?: boolean}} args
   * @returns {object}
   */
  collect(args) {
    this.idle();
    const dbg = this.live;
    if (args.finish === true) {
      dbg.settleCollection();
      return { collecting: false };
    }
    return { collecting: dbg.stepCollect() };
  }

  /** Every handle handed out before this moment is now stale. */
  invalidate() {
    this.refs.clear();
  }

  /** @returns {StateBody} */
  state() {
    const dbg = this.dbg;
    if (dbg === null) {
      return {
        loaded: false, running: false, status: 'ready', stepCount: 0, line: null, span: null,
        label: null, phase: null, depth: 0, dropped: 0, reach: 0, rewindsBy: 'replay',
        canStep: false, canStepBack: false, collecting: false, backend: 'tree', backendLabel: '',
        breakpoints: [], output: [], result: null, failure: null,
      };
    }
    return {
      loaded: true,
      running: this.running,
      status: dbg.status,
      stepCount: dbg.stepCount,
      line: dbg.line,
      span: dbg.current?.span ?? null,
      label: dbg.current?.label ?? null,
      phase: dbg.current?.phase ?? null,
      depth: dbg.depth,
      dropped: dbg.dropped,
      reach: dbg.reach,
      rewindsBy: dbg.rewindsBy,
      canStep: dbg.canStep,
      canStepBack: dbg.canStepBack,
      collecting: dbg.collecting,
      backend: dbg.backendName,
      backendLabel: dbg.backendLabel,
      breakpoints: [...dbg.breakpoints],
      // The output pane is state rather than a stream of `output` events, and
      // that is what lets stepping back shorten it. DAP's `output` event is
      // one-way by design, which is exactly why a console cannot be rewound.
      output: [...dbg.output],
      result: dbg.status === 'done' ? inspect(dbg.result) : null,
      failure: dbg.failure === null ? null : { message: dbg.failure.message, span: dbg.failure.span },
    };
  }

  /**
   * The call stack, innermost first, which is the order a stack trace reads
   * and the order DAP specifies.
   *
   * Once something has failed the stack reported is the one from the moment
   * it failed. The live stack has unwound to nothing by then, and a client
   * shown that would draw an empty pane over an error. This is the substitution
   * a real adapter makes when it stops on an exception.
   * @returns {{stackFrames: {id: number, name: string, line: number}[], totalFrames: number}}
   */
  stackTrace() {
    const dbg = this.live;
    /** @type {Frame[]} */
    const frames = dbg.failure?.frames ?? dbg.stack;
    const stackFrames = [...frames]
      .reverse()
      .map((frame, index) => ({ id: index + 1, name: frame.name, line: frame.line }));
    // The program itself is not a call and has no frame on either backend,
    // but it is where the stack bottoms out and a pane that omits it looks
    // truncated.
    stackFrames.push({ id: 0, name: '(top level)', line: 1 });
    return { stackFrames, totalFrames: stackFrames.length };
  }

  /**
   * The scope chain as references, not as contents.
   *
   * The two-step, `scopes` then `variables`, is the part of DAP that looks
   * like overhead until you notice what it buys: a client draws the chain
   * from this, and pays for the bindings of the scopes it actually expands.
   * Here every scope is expanded, so both requests always happen; the shape
   * is kept anyway because the shape is the lesson.
   * @returns {{scopes: ScopeRef[]}}
   */
  scopes() {
    const dbg = this.live;
    if (dbg.current === null) return { scopes: [] };
    this.invalidate();
    const scopes = dbg.scopes().map((scope) => {
      const reference = this.nextRef++;
      this.refs.set(reference, scope);
      return { name: scope.label, variablesReference: reference, namedVariables: scope.bindings.length };
    });
    return { scopes };
  }

  /**
   * @param {{variablesReference: number}} args
   * @returns {{variables: {name: string, value: string, variablesReference: number}[]}}
   */
  variables(args) {
    const scope = this.refs.get(args.variablesReference);
    if (scope === undefined) throw new Error(`stale variablesReference ${args.variablesReference}`);
    // Every Pip value renders to one line and none of them can be expanded,
    // so every variable's own reference is 0, DAP's way of saying "leaf".
    return { variables: scope.bindings.map((b) => ({ name: b.name, value: b.value, variablesReference: 0 })) };
  }

  /**
   * The instruction listing.
   *
   * DAP's real `disassemble` addresses memory and counts instructions either
   * side of a reference. Pip has neither, since a chunk is the unit and the
   * whole of one fits on a pane, so this keeps the name and the `{address,
   * instruction}` rows and drops the windowing. Null on the tree-walker,
   * which has no instructions to show.
   * @returns {{title: string, address: number, instructions: {address: number, instruction: string}[]}|null}
   */
  disassemble() {
    const code = this.live.code;
    if (code === null) return null;
    return {
      title: code.title,
      address: code.pc,
      instructions: code.lines.map((line) => ({ address: line.pc, instruction: line.text })),
    };
  }

  /**
   * A window onto the yield stream, the way `stackTrace` takes a window onto
   * the stack. The ribbon holds thousands of marks and draws a few hundred;
   * shipping the whole trace on every repaint would make the boundary look
   * expensive for no reason other than laziness.
   * @param {{start?: number, count?: number}} args
   * @returns {{marks: Mark[], start: number, total: number, dropped: number}}
   */
  trace(args) {
    const dbg = this.live;
    const total = dbg.trace.length;
    // Asking for a count and no start means the most recent marks, because
    // that is the end of the ribbon anyone is looking at.
    const count = Math.max(0, Math.min(args.count ?? total, total));
    const start = Math.max(0, Math.min(args.start ?? total - count, total));
    return {
      marks: dbg.trace.slice(start, start + count),
      start,
      total: dbg.trace.length,
      dropped: dbg.dropped,
    };
  }

  /** @returns {HeapView|null} */
  heap() {
    return this.live.heapView();
  }
}
