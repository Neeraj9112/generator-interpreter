import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execPath } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/cli.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const COUNTER = fileURLToPath(new URL('../examples/counter.pip', import.meta.url));

/**
 * @param {string} source
 * @returns {string} the path it was written to
 */
function pip(source) {
  const path = join(mkdtempSync(join(tmpdir(), 'pip-')), 'program.pip');
  writeFileSync(path, source, 'utf8');
  return path;
}

/**
 * @param {...string} args
 * @returns {{code: number, out: string, err: string}}
 */
function cli(...args) {
  const result = spawnSync(execPath, [CLI, ...args], { encoding: 'utf8' });
  return { code: result.status ?? -1, out: result.stdout, err: result.stderr };
}

test('parseArgs reads the file and the flags', () => {
  assert.deepEqual(parseArgs(['a.pip']), { file: 'a.pip', tree: false, stats: false });
  assert.deepEqual(parseArgs(['--tree', '--stats', 'a.pip']), { file: 'a.pip', tree: true, stats: true });
  assert.deepEqual(parseArgs(['a.pip', '--tree']), { file: 'a.pip', tree: true, stats: false });
});

test('parseArgs refuses what it cannot act on', () => {
  assert.deepEqual(parseArgs([]), { error: 'expected a file to run' });
  assert.deepEqual(parseArgs(['a.pip', 'b.pip']), { error: 'expected exactly one file' });
  assert.deepEqual(parseArgs(['--wat', 'a.pip']), { error: "unknown option '--wat'" });
  assert.deepEqual(parseArgs(['-h']), { help: true });
  assert.deepEqual(parseArgs(['--help', 'a.pip']), { help: true });
});

test('a program runs and prints what print wrote', () => {
  const { code, out, err } = cli(COUNTER);
  assert.equal(code, 0);
  assert.equal(out, '1\n2\n1\n');
  assert.equal(err, '', 'nothing should reach stderr on a clean run');
});

test('both backends agree from the command line too', () => {
  // The corpus already compares them in process. This checks the wiring: two
  // entry points into the same language should not be able to disagree.
  assert.deepEqual(cli(COUNTER), cli('--tree', COUNTER));
});

test('--stats reports the heap on stderr and leaves the output alone', () => {
  const file = pip('let i = 0\nwhile (i < 300) {\n  let s = "x" + i\n  i = i + 1\n}\nprint(i)\n');
  const { code, out, err } = cli('--stats', file);
  assert.equal(code, 0);
  assert.equal(out, '300\n', 'stats must not pollute what the program printed');
  assert.match(err, /^heap: \d+ live, \d+ slots, \d+ collections$/m);

  // The point of the churn example: a loop that allocates hundreds of times
  // does not leave hundreds of cells behind.
  const live = Number(/heap: (\d+) live/.exec(err)?.[1]);
  const collections = Number(/(\d+) collections/.exec(err)?.[1]);
  assert.ok(live < 64, `${live} cells survived`);
  assert.ok(collections > 0, 'the loop should have triggered a collection');
});

test('--stats on the tree-walker says why there is nothing to report', () => {
  const { code, err } = cli('--tree', '--stats', COUNTER);
  assert.equal(code, 0);
  assert.match(err, /tree-walker has none/);
});

test('a program that will not parse exits 2 and points at the line', () => {
  const { code, out, err } = cli(pip('let x = 1\nlet y = (2 +\n'));
  assert.equal(code, 2);
  assert.equal(out, '');
  assert.match(err, /ParseError/);
  assert.match(err, /\^/, 'the excerpt should carry a caret');
  assert.doesNotMatch(err, /\(line \d+, col \d+\)/, 'the position should not be printed twice');
});

test('a program rejected before it runs exits 2 as well', () => {
  const { code, err } = cli(pip('while (true) {\n  fn f() { break }\n}\n'));
  assert.equal(code, 2);
  assert.match(err, /SemanticError: 'break' outside of a loop/);
});

test('a failure while running exits 1 and names the frames it happened in', () => {
  const file = pip('fn outer() {\n  return inner()\n}\nfn inner() {\n  return 1 + true\n}\nprint(outer())\n');
  const { code, out, err } = cli(file);
  assert.equal(code, 1, 'a program that ran and then failed is not a source error');
  assert.equal(out, '');
  assert.match(err, /VmError: '\+' expects two numbers/);
  // Innermost first, the way a stack trace reads.
  assert.match(err, /in inner \(line 2\)\n\s+in outer \(line 7\)/);
});

test('the tree-walker reports the same failure without a stack trace', () => {
  // Not an omission. Its stack is the JS one plus a chain of suspended
  // generators, and by the time the error is out there is nothing left to read.
  const file = pip('fn outer() {\n  return inner()\n}\nfn inner() {\n  return 1 + true\n}\nprint(outer())\n');
  const { code, err } = cli('--tree', file);
  assert.equal(code, 1);
  assert.match(err, /EvalError: '\+' expects two numbers/);
  assert.doesNotMatch(err, / in outer /);
});

test('a bad invocation exits 3 and shows the usage', () => {
  const missing = cli('does-not-exist.pip');
  assert.equal(missing.code, 3);
  assert.match(missing.err, /cannot read/);

  const unknown = cli('--wat', COUNTER);
  assert.equal(unknown.code, 3);
  assert.match(unknown.err, /unknown option '--wat'/);
  assert.match(unknown.err, /usage:/);
});

test('--help prints the usage on stdout and exits 0', () => {
  const { code, out, err } = cli('--help');
  assert.equal(code, 0);
  assert.match(out, /usage: node src\/cli\.js/);
  assert.equal(err, '');
});
