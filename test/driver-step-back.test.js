import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Debugger, inspect } from '../web/driver.js';

const COUNTER = `fn makeCounter() {
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

/**
 * Everything the page would be showing at this moment. Stepping back is
 * only worth anything if the whole view comes back, not just the line
 * marker, so the assertions compare all of it at once.
 * @param {Debugger} dbg
 */
function view(dbg) {
  return {
    step: dbg.stepCount,
    status: dbg.status,
    line: dbg.line,
    label: dbg.current?.label ?? null,
    depth: dbg.depth,
    output: [...dbg.output],
    scopes: dbg.scopes().map((scope) => `${scope.label}: ${scope.bindings.map((b) => `${b.name}=${inspect(b.value)}`).join(' ')}`),
    stack: dbg.stack.map((frame) => `${frame.name}@${frame.line}`),
    pc: dbg.code?.pc ?? null,
  };
}

/**
 * @param {Debugger} dbg
 * @param {number} count
 */
function forward(dbg, count) {
  for (let i = 0; i < count; i++) assert.ok(dbg.step(), `the program ended after ${i} of ${count} steps`);
}

test('stepping back twenty times restores the view it started from (vm)', () => {
  const dbg = new Debugger(COUNTER, { backend: 'vm' });
  forward(dbg, 10);
  const before = view(dbg);

  forward(dbg, 20);
  assert.notDeepEqual(view(dbg), before, 'twenty steps should have changed something');
  for (let i = 0; i < 20; i++) assert.ok(dbg.stepBack(), `step back ${i + 1} refused`);

  assert.deepEqual(view(dbg), before);
});

test('stepping back over a print takes the line out of the output pane (vm)', () => {
  const dbg = new Debugger(COUNTER, { backend: 'vm' });
  while (dbg.output.length === 0 && dbg.step()) {
    // run up to the first thing printed
  }
  assert.deepEqual(dbg.output, ['1']);

  // The VM cannot unprint anything — the journal never saw the sink. What
  // puts the pane back is the debugger, which owns it and keeps its length
  // against every step.
  assert.ok(dbg.stepBack());
  assert.deepEqual(dbg.output, []);
});

test('stepping back from a finished program returns to its last pause (vm)', () => {
  const dbg = new Debugger(COUNTER, { backend: 'vm' });
  dbg.run();
  assert.equal(dbg.status, 'done');
  const ended = dbg.stepCount;

  assert.ok(dbg.stepBack());
  assert.equal(dbg.status, 'paused');
  assert.equal(dbg.stepCount, ended, 'the last pause is where the run stopped, not a step before it');
  assert.ok(dbg.current !== null);

  // And running on from there ends the same way, with the output written
  // once rather than twice.
  dbg.run();
  assert.equal(dbg.status, 'done');
  assert.deepEqual(dbg.output, ['1', '2']);
});

test('stepping back from a failure puts the failure back in the future (vm)', () => {
  const dbg = new Debugger('let n = 1\nn + true\n', { backend: 'vm' });
  dbg.run();
  assert.equal(dbg.status, 'error');
  const message = dbg.failure?.message;
  assert.equal(message, "'+' expects two numbers or a string, got number 1 and boolean true");

  assert.ok(dbg.stepBack());
  assert.equal(dbg.status, 'paused');
  const cleared = dbg.failure;
  assert.equal(cleared, null, 'the error pane should clear: it has not happened yet');

  dbg.run();
  assert.equal(dbg.status, 'error');
  assert.equal(dbg.failure?.message, message);
});

test('a breakpoint still fires after stepping back past it (vm)', () => {
  const dbg = new Debugger(COUNTER, { backend: 'vm', breakpoints: [4] });
  dbg.run();
  assert.equal(dbg.line, 4);
  const first = view(dbg);

  for (let i = 0; i < 10; i++) assert.ok(dbg.stepBack());
  assert.notEqual(dbg.line, 4);

  // Running on has to stop in the same place it stopped the first time,
  // which is the whole reason the rewind puts `previousLine` back too.
  dbg.run();
  assert.deepEqual(view(dbg), first);
});

test('there is nowhere to step back to before the first step', () => {
  const dbg = new Debugger(COUNTER, { backend: 'vm' });
  assert.equal(dbg.canStepBack, false);
  assert.equal(dbg.stepBack(), false);

  dbg.step();
  assert.equal(dbg.canStepBack, false, 'the first pause is the beginning');
  assert.equal(dbg.stepBack(), false);

  dbg.step();
  assert.equal(dbg.canStepBack, true);
});

test('the journal reaches a bounded distance and the driver can say how far (vm)', () => {
  const dbg = new Debugger(COUNTER, { backend: 'vm' });
  assert.equal(dbg.reach, 0, 'nothing has run yet');
  dbg.run();
  assert.equal(dbg.reach, dbg.stepCount, 'the whole demo fits inside the journal');

  // The tree-walker keeps no journal at all, and reports as much.
  const tree = new Debugger(COUNTER, { backend: 'tree' });
  tree.run();
  assert.equal(tree.reach, 0);
});
