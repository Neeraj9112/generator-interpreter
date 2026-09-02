import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.js';
import { validate, SemanticError } from '../src/validate.js';

/** @param {string} source */
function check(source) {
  validate(parse(source));
}

test('a loop encloses break and continue', () => {
  assert.doesNotThrow(() => check('while (true) { break }'));
  assert.doesNotThrow(() => check('while (true) { continue }'));
  assert.doesNotThrow(() => check('while (true) { if (1) { { break } } }'));
  assert.doesNotThrow(() => check('while (true) { while (true) { break } break }'));
});

test('break and continue outside a loop are rejected', () => {
  assert.throws(() => check('break'), { name: 'SemanticError', message: "'break' outside of a loop" });
  assert.throws(() => check('continue'), { name: 'SemanticError', message: "'continue' outside of a loop" });
  assert.throws(() => check('if (1) { break }'), SemanticError);
  assert.throws(() => check('fn f() { break }'), SemanticError);
});

test('the loop count does not survive a function boundary', () => {
  // Nothing in this says which iteration the break would be leaving. The
  // function is a value that outlives the loop it was declared in.
  assert.throws(() => check('while (true) { fn f() { break } }'), { message: "'break' outside of a loop" });
  assert.throws(() => check('while (true) { fn f() { continue } }'), { message: "'continue' outside of a loop" });
  // But a loop *inside* the body does enclose it, and an outer loop is still
  // there once the declaration is behind us.
  assert.doesNotThrow(() => check('while (true) { fn f() { while (true) { break } } break }'));
});

test('return needs a function around it, at any depth', () => {
  assert.doesNotThrow(() => check('fn f() { return 1 }'));
  assert.doesNotThrow(() => check('fn f() { while (true) { if (1) { return 1 } } }'));
  assert.doesNotThrow(() => check('fn outer() { fn inner() { return 1 } return inner }'));
  assert.throws(() => check('return 1'), { message: "'return' outside of a function" });
  assert.throws(() => check('while (true) { return 1 }'), { message: "'return' outside of a function" });
  assert.throws(() => check('{ return 1 }'), SemanticError);
});

test('a name may be declared once per scope', () => {
  assert.throws(() => check('let x = 1 let x = 2'), { message: "'x' is already declared in this scope" });
  assert.throws(() => check('fn f() { } fn f() { }'), { message: "'f' is already declared in this scope" });
  assert.throws(() => check('let f = 1 fn f() { }'), SemanticError);
});

test('shadowing in a nested scope is not redeclaring', () => {
  assert.doesNotThrow(() => check('let x = 1 { let x = 2 { let x = 3 } }'));
  assert.doesNotThrow(() => check('fn f(x) { let x = 2 }'));
  assert.doesNotThrow(() => check('let x = 1 fn f() { let x = 2 }'));
  assert.doesNotThrow(() => check('while (true) { let x = 1 } while (true) { let x = 2 }'));
});

test('being unreachable is no defence', () => {
  // The whole reason this pass exists: the tree-walker used to let these
  // through whenever control happened not to arrive, and the compiler never
  // could, because it has to resolve every jump before anything runs.
  assert.throws(() => check('if (false) { break }'), SemanticError);
  assert.throws(() => check('while (false) { return 1 }'), SemanticError);
  assert.throws(() => check('if (false) { let x = 1 let x = 2 }'), SemanticError);
});

test('a rejection carries the span of the thing that was wrong', () => {
  const source = 'let ok = 1\nbreak';
  assert.throws(
    () => check(source),
    (/** @type {SemanticError} */ error) => {
      assert.deepEqual(error.span, { start: 11, end: 16 });
      assert.equal(source.slice(error.span.start, error.span.end), 'break');
      return true;
    },
  );
});

test('a valid program passes silently', () => {
  assert.equal(
    validate(parse(`
      fn makeCounter() {
        let n = 0
        fn inc() { n = n + 1 return n }
        return inc
      }
      let a = makeCounter()
      while (a() < 3) { }
    `)),
    undefined,
  );
});
