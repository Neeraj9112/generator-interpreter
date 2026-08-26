import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Env } from '../src/env.js';

test('a child links to its parent, not a copy of it', () => {
  const global = new Env();
  const inner = global.child();

  assert.equal(inner.parent, global);
  assert.equal(global.parent, null);
  assert.equal(inner.vars.size, 0);
});

test('lookup walks outward through the chain', () => {
  const global = new Env();
  global.define('x', 1);
  const inner = global.child().child();

  assert.equal(inner.resolve('x'), global);
  assert.equal(inner.get('x'), 1);
  assert.equal(inner.resolve('nope'), null);
});

test('an inner binding shadows an outer one without disturbing it', () => {
  const global = new Env();
  global.define('x', 'outer');
  const inner = global.child();
  inner.define('x', 'inner');

  assert.equal(inner.get('x'), 'inner');
  assert.equal(global.get('x'), 'outer');
  assert.equal(inner.hasOwn('x'), true);
  assert.equal(inner.child().hasOwn('x'), false);
});

test('assignment writes to the scope that owns the name', () => {
  const global = new Env();
  global.define('count', 0);
  const inner = global.child();

  assert.equal(inner.assign('count', 1), true);
  assert.equal(global.get('count'), 1);
  assert.equal(inner.hasOwn('count'), false);
});

test('assignment to an unbound name fails rather than creating one', () => {
  const env = new Env();

  assert.equal(env.assign('x', 1), false);
  assert.equal(env.resolve('x'), null);
});
