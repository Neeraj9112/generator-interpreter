// @ts-check

/** @typedef {import('./protocol.js').DapRequest} DapRequest */
/** @typedef {import('./protocol.js').DapResponse} DapResponse */
/** @typedef {import('./protocol.js').DapEvent} DapEvent */
/** @typedef {import('./protocol.js').StateBody} StateBody */
/** @typedef {import('./driver.js').HeapView} HeapView */
/** @typedef {import('./driver.js').Mark} Mark */

/**
 * The far end, whatever it is.
 *
 * A `Worker` has exactly this shape, and so does `self` inside one, which is
 * why neither side of this phase mentions workers by name. A test can supply
 * a pair of these wired to each other and exercise the same code the page
 * runs. The protocol is the seam, and a seam you can only reach through a
 * real thread is a seam you will not test.
 *
 * The handler's parameter is `any` rather than `{data: unknown}` so that a
 * real `Worker` satisfies this: its `onmessage` is typed for a full
 * `MessageEvent`, and a narrower parameter would make the assignment
 * unsound in the checker's eyes even though `.data` is all anyone reads.
 * @typedef {{postMessage: (message: any) => void, onmessage: ((event: any) => void)|null}} Port
 */

/** One scope with its bindings already fetched. @typedef {{name: string, variables: {name: string, value: string}[]}} ScopeView */

/** @typedef {{title: string, address: number, instructions: {address: number, instruction: string}[]}} CodeView */

/** @typedef {{marks: Mark[], start: number, total: number, dropped: number}} TraceView */

/**
 * Everything the page draws, as of one moment.
 *
 * Assembled from several requests rather than one, because that is what the
 * adapter offers: `stackTrace`, `scopes`, `variables`, `disassemble`. A real
 * client fetches these lazily as panes are opened; this page has every pane
 * open at once, so it fetches them together and calls the result a snapshot.
 * @typedef {{
 *   state: StateBody,
 *   frames: {id: number, name: string, line: number}[],
 *   scopes: ScopeView[],
 *   code: CodeView|null,
 *   trace: TraceView,
 *   heap: HeapView|null,
 * }} Snapshot
 */

/** What a client has before anything has been asked for. @type {TraceView} */
const NO_TRACE = { marks: [], start: 0, total: 0, dropped: 0 };

/**
 * The near side of the protocol: turns method calls into requests, matches
 * replies back to them by `seq`, and hands events to listeners.
 *
 * Every method here is `async` and that is the point of the phase. The same
 * operations were synchronous property reads two commits ago; making the
 * debugger a separate process is exactly the change that makes "what is the
 * value of `n`" a question with a latency.
 */
export class DebugClient {
  /** @param {Port} port */
  constructor(port) {
    this.port = port;
    this.seq = 0;
    /** Requests still waiting for their reply, by `seq`. @type {Map<number, {resolve: (body: any) => void, reject: (err: Error) => void}>} */
    this.pending = new Map();
    /** @type {Map<string, ((body: any) => void)[]>} */
    this.listeners = new Map();
    port.onmessage = (event) => this.receive(event.data);
  }

  /**
   * @param {DapResponse|DapEvent} message
   */
  receive(message) {
    if (message.type === 'event') {
      for (const listener of this.listeners.get(message.event) ?? []) listener(message.body);
      return;
    }
    const waiting = this.pending.get(message.request_seq);
    if (waiting === undefined) return;
    this.pending.delete(message.request_seq);
    if (message.success) {
      waiting.resolve(message.body);
      return;
    }
    const error = new Error(message.message ?? `${message.command} failed`);
    // The label rides in the body because the class does not survive the
    // crossing. See AdapterError.
    error.name = message.body?.label ?? 'failed';
    waiting.reject(error);
  }

  /**
   * @param {string} event
   * @param {(body: any) => void} listener
   */
  on(event, listener) {
    const existing = this.listeners.get(event);
    if (existing === undefined) this.listeners.set(event, [listener]);
    else existing.push(listener);
  }

  /**
   * @param {string} command
   * @param {any} [args]
   * @returns {Promise<any>}
   */
  request(command, args) {
    const seq = ++this.seq;
    /** @type {DapRequest} */
    const message = { seq, type: 'request', command, arguments: args };
    return new Promise((resolve, reject) => {
      this.pending.set(seq, { resolve, reject });
      this.port.postMessage(message);
    });
  }

  /**
   * Load a program. Rejects with the adapter's own label as the error name,
   * so the caller can tell a typo from a misplaced `break`.
   * @param {string} source
   * @param {{backend?: string, breakpoints?: number[]}} [options]
   * @returns {Promise<void>}
   */
  async launch(source, options = {}) {
    await this.request('launch', { source, ...options });
  }

  /**
   * Everything the page draws, in one round of requests.
   *
   * The scope chain costs two rounds rather than one: `scopes` names the
   * scopes and hands back a reference for each, and `variables` redeems one
   * reference for its bindings. That is DAP's shape and it is kept even
   * though this page always redeems all of them. The references go stale on
   * the next stop, which is the part worth having modelled.
   * @param {{traceCount?: number}} [options]
   * @returns {Promise<Snapshot>}
   */
  async refresh(options = {}) {
    /** @type {StateBody} */
    const state = await this.request('pip/state');
    if (!state.loaded) {
      return { state, frames: [], scopes: [], code: null, trace: NO_TRACE, heap: null };
    }

    const [stack, scopeRefs, code, trace, heap] = await Promise.all([
      this.request('stackTrace'),
      this.request('scopes'),
      this.request('disassemble'),
      this.request('pip/trace', { count: options.traceCount }),
      this.request('pip/heap'),
    ]);

    const scopes = await Promise.all(
      scopeRefs.scopes.map(async (/** @type {{name: string, variablesReference: number}} */ ref) => {
        const { variables } = await this.request('variables', { variablesReference: ref.variablesReference });
        return { name: ref.name, variables };
      }),
    );

    return { state, frames: stack.stackFrames, scopes, code: code ?? null, trace, heap: heap ?? null };
  }
}

/**
 * Wire two ports to each other, in one thread.
 *
 * Not a stand-in for the Worker so much as proof the boundary is real: if
 * anything in a response were a live object rather than data, it would still
 * work here and break there. The tests round-trip through `structuredClone`
 * for exactly that reason.
 * @returns {[Port, Port]}
 */
export function pair() {
  /** @type {Port} */
  const left = { postMessage: () => {}, onmessage: null };
  /** @type {Port} */
  const right = { postMessage: () => {}, onmessage: null };
  // Delivery is asynchronous and cloned, the way `postMessage` actually is.
  // Delivering synchronously would let a test pass on the strength of an
  // ordering the real channel does not guarantee.
  left.postMessage = (message) => queueMicrotask(() => right.onmessage?.({ data: structuredClone(message) }));
  right.postMessage = (message) => queueMicrotask(() => left.onmessage?.({ data: structuredClone(message) }));
  return [left, right];
}
