import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Debugger } from '../web/driver.js';

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
    scopes: dbg.scopes().map((scope) => `${scope.label}: ${scope.bindings.map((b) => `${b.name}=${b.value}`).join(' ')}`),
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

// Both backends step back, by mechanisms that have nothing in common: the VM
// undoes a journal, and the tree-walker runs the program again from the top.
// Everything below is written against the debugger, which is the point —
// what a user gets is the same either way, and only the bill differs.
const BACKENDS = ['tree', 'vm'];

for (const backend of BACKENDS) {
  test(`stepping back twenty times restores the view it started from (${backend})`, () => {
    const dbg = new Debugger(COUNTER, { backend });
    forward(dbg, 10);
    const before = view(dbg);

    forward(dbg, 20);
    assert.notDeepEqual(view(dbg), before, 'twenty steps should have changed something');
    for (let i = 0; i < 20; i++) assert.ok(dbg.stepBack(), `step back ${i + 1} refused`);

    assert.deepEqual(view(dbg), before);
  });

  test(`stepping back over a print takes the line out of the output pane (${backend})`, () => {
    const dbg = new Debugger(COUNTER, { backend });
    while (dbg.output.length === 0 && dbg.step()) {
      // run up to the first thing printed
    }
    assert.deepEqual(dbg.output, ['1']);

    // Neither backend can unprint anything: one never saw the sink and the
    // other is not running any more. What puts the pane back is the debugger,
    // which owns it and remembers its length against every step.
    assert.ok(dbg.stepBack());
    assert.deepEqual(dbg.output, []);
  });

  test(`stepping back from a finished program returns to its last pause (${backend})`, () => {
    const dbg = new Debugger(COUNTER, { backend });
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

  test(`stepping back from a failure puts the failure back in the future (${backend})`, () => {
    const dbg = new Debugger('let n = 1\nn + true\n', { backend });
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

  test(`a breakpoint still fires after stepping back past it (${backend})`, () => {
    const dbg = new Debugger(COUNTER, { backend, breakpoints: [4] });
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

  test(`there is nowhere to step back to before the first step (${backend})`, () => {
    const dbg = new Debugger(COUNTER, { backend });
    assert.equal(dbg.canStepBack, false);
    assert.equal(dbg.stepBack(), false);

    dbg.step();
    assert.equal(dbg.canStepBack, false, 'the first pause is the beginning');
    assert.equal(dbg.stepBack(), false);

    dbg.step();
    assert.equal(dbg.canStepBack, true);
  });
}

test('the two backends pay for step-back differently, and say so', () => {
  const vm = new Debugger(COUNTER, { backend: 'vm' });
  assert.equal(vm.reach, 0, 'nothing has run yet');
  vm.run();
  assert.equal(vm.reach, vm.stepCount, 'the whole demo fits inside the journal');
  const machine = vm.backend;
  vm.stepBack();
  assert.equal(vm.backend, machine, 'the VM steps back in place, on the machine it was already running');

  // The tree-walker keeps no journal, and stepping back is a fresh run of
  // the whole program — a new backend object, where the VM kept its own.
  const tree = new Debugger(COUNTER, { backend: 'tree' });
  tree.run();
  assert.equal(tree.reach, 0);
  const walker = tree.backend;
  tree.stepBack();
  assert.notEqual(tree.backend, walker, 'the tree-walker should have replayed from the start');
  assert.equal(tree.status, 'paused');
});
