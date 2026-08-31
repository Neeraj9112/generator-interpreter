import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../web/protocol.js';
import { DebugClient, pair } from '../web/client.js';
import { Debugger } from '../web/driver.js';

/** @typedef {import('../web/client.js').Snapshot} Snapshot */

// Line 1 is blank so `fn makeCounter()` is line 2, matching the driver tests.
const COUNTER = `
fn makeCounter() {
  let n = 0
  fn inc() {
    n = n + 1
    return n
  }
  return inc
}

let a = makeCounter()
print(a())
print(a())
`;

const FOREVER = 'let i = 0\nwhile (true) {\n  i = i + 1\n}\n';

/**
 * A client and an adapter wired to each other, one thread, cloning across the
 * join. Every test in this file goes through that clone, which is what makes
 * "nothing live crosses the boundary" an assertion rather than an intention:
 * a live `Env` in a response is a `DataCloneError`, here as in a Worker.
 * @returns {{client: DebugClient, session: Session, stops: {reason: string}[], ended: boolean[]}}
 */
function connect() {
  const [near, far] = pair();
  const session = new Session((message) => far.postMessage(message));
  far.onmessage = async (event) => far.postMessage(await session.handle(event.data));
  const client = new DebugClient(near);

  /** @type {{reason: string}[]} */
  const stops = [];
  /** @type {boolean[]} */
  const ended = [];
  client.on('stopped', (body) => stops.push(body));
  client.on('terminated', () => ended.push(true));
  return { client, session, stops, ended };
}

/**
 * Wait for the next `stopped` or `terminated` event.
 *
 * Every motion command answers immediately with an acknowledgement, so a test
 * that only awaited the response would look at the state before the program
 * had moved. Waiting on the event is what a real client does too.
 * @param {DebugClient} client
 * @returns {Promise<{event: string, body: any}>}
 */
function settled(client) {
  return new Promise((resolve) => {
    client.on('stopped', (body) => resolve({ event: 'stopped', body }));
    client.on('terminated', (body) => resolve({ event: 'terminated', body }));
    client.on('pip/crashed', (body) => resolve({ event: 'pip/crashed', body }));
  });
}

/**
 * Send a motion and wait for where it stopped.
 * @param {DebugClient} client
 * @param {string} command
 * @param {any} [args]
 * @returns {Promise<{event: string, body: any}>}
 */
async function move(client, command, args) {
  const stop = settled(client);
  await client.request(command, args);
  return stop;
}

test('the adapter reports the capabilities this project actually has', async () => {
  const { client } = connect();
  const capabilities = await client.request('initialize');
  assert.equal(capabilities.supportsStepBack, true);
  assert.equal(capabilities.supportsDisassembleRequest, true);
  assert.equal(capabilities.supportsSteppingGranularity, true);
});

test('a request before anything is loaded fails rather than answering', async () => {
  const { client } = connect();
  await assert.rejects(() => client.request('stackTrace'), /no program loaded/);
});

test('source that does not parse comes back labelled, not thrown away', async () => {
  const { client } = connect();
  await assert.rejects(
    () => client.launch('let ='),
    (/** @type {Error} */ err) => err.name === 'parse error',
  );
  const state = await client.request('pip/state');
  assert.equal(state.loaded, false);
});

test('source that parses but means nothing is rejected, not called a parse error', async () => {
  const { client } = connect();
  await assert.rejects(
    () => client.launch('break'),
    (/** @type {Error} */ err) => err.name === 'rejected',
  );
});

test('an unknown command is refused by name', async () => {
  const { client } = connect();
  await assert.rejects(() => client.request('teleport'), /unknown command 'teleport'/);
});

test('a step answers immediately and announces where it stopped afterwards', async () => {
  const { client, stops } = connect();
  await client.launch(COUNTER);

  // The acknowledgement is not the stop: nothing has moved when it arrives.
  const stop = settled(client);
  const ack = await client.request('stepIn');
  assert.deepEqual(ack, {});
  assert.equal(stops.length, 0);

  const landed = await stop;
  assert.equal(landed.event, 'stopped');
  assert.equal(landed.body.reason, 'step');
  const state = await client.request('pip/state');
  assert.equal(state.stepCount, 1);
});

test('running stops at a breakpoint and says that is why', async () => {
  const { client } = connect();
  await client.launch(COUNTER, { breakpoints: [5] });
  const landed = await move(client, 'continue');
  assert.equal(landed.body.reason, 'breakpoint');
  assert.equal(landed.body.line, 5);
});

test('a program that ends terminates rather than stopping', async () => {
  const { client } = connect();
  await client.launch('1 + 2');
  const landed = await move(client, 'continue');
  assert.equal(landed.event, 'terminated');
  assert.equal(landed.body.result, '3');
});

test('a failing program stops on the exception with the failing line', async () => {
  const { client } = connect();
  await client.launch('fn boom() {\n  return 1 + missing\n}\nboom()\n');
  const landed = await move(client, 'continue');
  assert.equal(landed.body.reason, 'exception');
  const state = await client.request('pip/state');
  assert.equal(state.status, 'error');
  assert.match(state.failure.message, /undefined variable 'missing'/);
});

test('a runaway loop can be paused, which is the point of the other thread', async () => {
  const { client } = connect();
  await client.launch(FOREVER);

  const stop = settled(client);
  await client.request('continue');
  // The adapter is mid-run right now. On one thread this request could not
  // even be delivered until the loop finished, which it never does.
  const running = await client.request('pip/state');
  assert.equal(running.running, true);

  await client.request('pause');
  const landed = await stop;
  assert.equal(landed.body.reason, 'pause');

  const state = await client.request('pip/state');
  assert.equal(state.status, 'paused');
  assert.ok(state.stepCount > 0, 'the loop should have got somewhere before being stopped');
});

test('pausing when nothing is running is refused', async () => {
  const { client } = connect();
  await client.launch(COUNTER);
  await assert.rejects(() => client.request('pause'), /nothing is running/);
});

test('a second motion while one is running is refused rather than interleaved', async () => {
  const { client } = connect();
  await client.launch(FOREVER);
  const stop = settled(client);
  await client.request('continue');
  await assert.rejects(() => client.request('stepIn'), /already running/);
  await client.request('pause');
  await stop;
});

test('the stack reads innermost first and bottoms out at the top level', async () => {
  const { client } = connect();
  await client.launch(COUNTER, { breakpoints: [5] });
  await move(client, 'continue');
  const { stackFrames } = await client.request('stackTrace');
  // The tree-walker names a frame after the source text that called it and
  // counts `print` as one, because it reconstructs the stack from call
  // expressions rather than reading a frame array. See `displayFrames`.
  assert.deepEqual(stackFrames.map((/** @type {{name: string}} */ f) => f.name), ['a', 'print', '(top level)']);
});

test('scopes name the chain and variables redeem one reference for its bindings', async () => {
  const { client } = connect();
  await client.launch(COUNTER, { breakpoints: [5] });
  await move(client, 'continue');

  const { scopes } = await client.request('scopes');
  assert.equal(scopes.at(-1).name, 'builtins');
  assert.ok(scopes.some((/** @type {{name: string}} */ s) => s.name === 'top level'));

  const named = [];
  for (const scope of scopes) {
    const { variables } = await client.request('variables', { variablesReference: scope.variablesReference });
    for (const variable of variables) named.push(`${variable.name}=${variable.value}`);
  }
  // Line 5 is `n = n + 1` and the pause is before it runs, so the counter is
  // still where the closure captured it.
  assert.ok(named.includes('n=0'), `expected the captured counter among ${named.join(' ')}`);
});

test('a variables reference goes stale the moment the program moves', async () => {
  const { client } = connect();
  await client.launch(COUNTER, { breakpoints: [5] });
  await move(client, 'continue');
  const { scopes } = await client.request('scopes');
  const reference = scopes[0].variablesReference;

  await client.request('variables', { variablesReference: reference });
  await move(client, 'stepIn');
  await assert.rejects(
    () => client.request('variables', { variablesReference: reference }),
    /stale variablesReference/,
  );
});

test('only the VM has instructions to disassemble', async () => {
  const { client } = connect();
  await client.launch('1 + 2', { backend: 'tree' });
  await move(client, 'stepIn');
  assert.equal(await client.request('disassemble'), null);

  await client.request('pip/backend', { backend: 'vm' });
  await move(client, 'stepIn');
  const code = await client.request('disassemble');
  assert.equal(code.address, 0);
  assert.ok(code.instructions.length > 0);
  assert.match(code.instructions[0].instruction, /CONST/);
});

test('the trace request hands back the tail, the way the ribbon reads it', async () => {
  const { client } = connect();
  await client.launch(COUNTER);
  await move(client, 'continue');

  const all = await client.request('pip/trace');
  const tail = await client.request('pip/trace', { count: 10 });
  assert.equal(tail.total, all.total);
  assert.equal(tail.marks.length, 10);
  assert.equal(tail.start, all.total - 10);
  assert.deepEqual(tail.marks, all.marks.slice(-10));
});

test('stepping back over the protocol lands where stepping back does', async () => {
  const { client } = connect();
  await client.launch(COUNTER, { backend: 'vm' });
  for (let i = 0; i < 40; i++) await move(client, 'stepIn');
  const before = await client.request('pip/state');

  await move(client, 'stepIn');
  await move(client, 'stepBack');
  const after = await client.request('pip/state');
  assert.deepEqual(after.line, before.line);
  assert.equal(after.stepCount, before.stepCount);
});

test('breakpoints set over the protocol are verified and survive a restart', async () => {
  const { client } = connect();
  await client.launch(COUNTER);
  const { breakpoints } = await client.request('setBreakpoints', { lines: [5, 11] });
  assert.deepEqual(breakpoints, [{ line: 5, verified: true }, { line: 11, verified: true }]);

  await move(client, 'continue');
  await client.request('restart');
  const state = await client.request('pip/state');
  assert.equal(state.stepCount, 0);
  assert.deepEqual(state.breakpoints, [5, 11]);
});

test('the heap is drawable on the VM and absent on the tree-walker', async () => {
  const { client } = connect();
  await client.launch(COUNTER, { backend: 'tree' });
  await move(client, 'continue');
  assert.equal(await client.request('pip/heap'), null);

  await client.request('pip/backend', { backend: 'vm' });
  await move(client, 'continue');
  const heap = await client.request('pip/heap');
  assert.ok(heap.size > 0);
  assert.equal(heap.cells.length, heap.size);
});

test('a collection can be stepped through from the far side of the boundary', async () => {
  const { client } = connect();
  await client.launch(COUNTER, { backend: 'vm' });
  await move(client, 'continue');

  assert.deepEqual(await client.request('pip/collect'), { collecting: true });
  const mid = await client.request('pip/heap');
  assert.notEqual(mid.step, null);

  assert.deepEqual(await client.request('pip/collect', { finish: true }), { collecting: false });
  const done = await client.request('pip/heap');
  assert.equal(done.step, null);
});

test('a snapshot says the same thing the in-process debugger would', async () => {
  for (const backend of ['tree', 'vm']) {
    const { client } = connect();
    await client.launch(COUNTER, { backend, breakpoints: [5] });
    await move(client, 'continue');
    const snapshot = await client.refresh({ traceCount: 200 });

    const local = new Debugger(COUNTER, { backend, breakpoints: [5] });
    local.run();

    assert.equal(snapshot.state.status, local.status, backend);
    assert.equal(snapshot.state.line, local.line, backend);
    assert.equal(snapshot.state.stepCount, local.stepCount, backend);
    assert.deepEqual(snapshot.state.output, local.output, backend);
    assert.deepEqual(
      snapshot.frames.slice(0, -1).map((frame) => frame.name),
      [...local.stack].reverse().map((frame) => frame.name),
      backend,
    );
    assert.deepEqual(
      snapshot.scopes.map((scope) => `${scope.name}: ${scope.variables.map((v) => `${v.name}=${v.value}`).join(' ')}`),
      local.scopes().map((scope) => `${scope.label}: ${scope.bindings.map((b) => `${b.name}=${b.value}`).join(' ')}`),
      backend,
    );
    assert.equal(snapshot.code === null, local.code === null, backend);
    assert.equal(snapshot.heap === null, local.heapView() === null, backend);
  }
});

test('a snapshot of an unloaded session draws an empty page rather than failing', async () => {
  const { client } = connect();
  const snapshot = await client.refresh();
  assert.equal(snapshot.state.loaded, false);
  assert.deepEqual(snapshot.scopes, []);
  assert.deepEqual(snapshot.trace.marks, []);
});
