import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Debugger } from '../web/driver.js';

/** @typedef {import('../web/backends.js').Frame} Frame */

const BACKENDS = ['tree', 'vm'];

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

const ADD = `fn add(x, y) {
  return x + y
}
let total = add(1, 2)
print(total)
`;

/**
 * @param {string} source
 * @param {string} backend
 * @param {number[]} [breakpoints]
 * @returns {Debugger}
 */
function make(source, backend, breakpoints = []) {
  return new Debugger(source, { backend, breakpoints });
}

/**
 * Step until `line` is the line being paused on, or give up.
 * @param {Debugger} dbg
 * @param {number} line
 */
function reach(dbg, line) {
  while (dbg.line !== line && dbg.step()) {
    // keep going
  }
  assert.equal(dbg.line, line, `never reached line ${line}`);
}

for (const backend of BACKENDS) {
  test(`a run produces the same output and result (${backend})`, () => {
    const dbg = make(COUNTER, backend);
    dbg.run();
    assert.equal(dbg.status, 'done');
    assert.deepEqual(dbg.output, ['1', '2']);
  });

  test(`a breakpoint stops on the line it was set on (${backend})`, () => {
    const dbg = make(COUNTER, backend, [4]);
    dbg.run();
    assert.equal(dbg.status, 'paused');
    assert.equal(dbg.line, 4);
    // Stopped on the first pass through the body, before anything printed.
    assert.deepEqual(dbg.output, []);
  });

  test(`stepping a line always leaves the line it started on (${backend})`, () => {
    const dbg = make(ADD, backend);
    dbg.step();
    const lines = [];
    while (dbg.canStep) {
      const before = dbg.line;
      dbg.stepLine();
      if (!dbg.canStep) break;
      assert.notEqual(dbg.line, before);
      lines.push(dbg.line);
    }
    assert.ok(lines.length > 0);
  });

  test(`stepping over a call does not pause inside it (${backend})`, () => {
    const dbg = make(ADD, backend);
    reach(dbg, 4);
    dbg.stepOver();
    assert.equal(dbg.line, 5, 'should have come out the other side of the call');
    assert.equal(dbg.stack.length, 0, 'and should be back at the top level');
  });

  test(`a runtime error reports the same message and the same source (${backend})`, () => {
    const dbg = make('fn boom() {\n  return 1 + missing\n}\nboom()\n', backend);
    dbg.run();
    assert.equal(dbg.status, 'error');
    assert.equal(dbg.failure?.message, "undefined variable 'missing'");
    assert.equal(dbg.text(dbg.failure?.span ?? { start: 0, end: 0 }), 'missing');
    assert.deepEqual(dbg.failure?.frames.map((/** @type {Frame} */ frame) => frame.name), ['boom']);
  });

  test(`reset clears the run but keeps the breakpoints (${backend})`, () => {
    const dbg = make(COUNTER, backend, [4]);
    dbg.run();
    dbg.reset();
    assert.equal(dbg.status, 'ready');
    assert.equal(dbg.stepCount, 0);
    assert.deepEqual(dbg.output, []);
    assert.deepEqual([...dbg.breakpoints], [4]);
  });

  test(`the inspector finds the counter's captured binding (${backend})`, () => {
    const dbg = make(COUNTER, backend, [5]);
    dbg.run();
    assert.equal(dbg.line, 5);
    const bindings = dbg.scopes().flatMap((scope) => scope.bindings.map((b) => `${b.name}=${String(b.value)}`));
    assert.ok(bindings.includes('n=1'), `expected n=1 among ${bindings.join(' ')}`);
  });
}

test('only the VM has instructions to show', () => {
  const tree = make(ADD, 'tree');
  tree.step();
  assert.equal(tree.code, null);

  const vm = make(ADD, 'vm');
  vm.step();
  const code = vm.code;
  assert.ok(code !== null);
  assert.match(code.title, /^<program>/);
  assert.ok(code.lines.some((line) => line.pc === code.pc), 'the highlighted pc is not in the listing');
});

test('the listing is there before the first step and after the last', () => {
  const vm = make(ADD, 'vm');
  // Switching to this backend should show you the program, not a blank column.
  assert.equal(vm.code?.pc, 0);
  assert.match(vm.code?.title ?? '', /^<program>/);

  vm.run();
  assert.equal(vm.status, 'done');
  // And it stays on the instruction it stopped at rather than emptying out.
  assert.ok(vm.code !== null);
  assert.ok(vm.code.lines.some((line) => line.pc === vm.code?.pc));
});

test('the instruction listing follows the frame into a call', () => {
  const vm = make(ADD, 'vm');
  reach(vm, 2);
  assert.equal(vm.code?.title, 'add(x, y)');
  assert.equal(vm.stack.length, 1);
});

test('switching backend restarts the program and keeps the breakpoints', () => {
  const dbg = make(COUNTER, 'tree', [4]);
  dbg.run();
  assert.ok(dbg.stepCount > 0);

  dbg.setBackend('vm');
  assert.equal(dbg.backendName, 'vm');
  assert.equal(dbg.status, 'ready');
  assert.equal(dbg.stepCount, 0);
  assert.deepEqual(dbg.output, []);
  assert.deepEqual([...dbg.breakpoints], [4]);

  dbg.run();
  assert.equal(dbg.line, 4);
});

test('an unknown backend name is ignored rather than breaking the page', () => {
  const dbg = make(ADD, 'nonsense');
  assert.equal(dbg.backendName, 'tree');
  dbg.setBackend('also-nonsense');
  assert.equal(dbg.backendName, 'tree');
});

test('the two stack panes differ, because the two runtimes know different things', () => {
  // Not a bug, and worth pinning so it does not get "fixed" by accident. The
  // tree-walker pushes a frame when it *enters a call expression*, before the
  // callee has been evaluated, so it can only name the frame after the source
  // text and it counts builtins as frames. The VM reads its own frame array,
  // which holds the function actually running and never a builtin.
  const source = 'fn f() {\n  print(1)\n}\nlet g = f\ng()\n';

  const tree = make(source, 'tree', [2]);
  tree.run();
  assert.deepEqual(tree.stack.map((frame) => frame.name), ['g']);

  const vm = make(source, 'vm', [2]);
  vm.run();
  assert.deepEqual(vm.stack.map((frame) => frame.name), ['f']);
});
