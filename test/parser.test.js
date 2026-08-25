import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, ParseError } from '../src/parser.js';

/** @typedef {import('../src/parser.js').Statement} Statement */
/** @typedef {import('../src/parser.js').Expression} Expression */

/**
 * Narrow a statement to its expression, for expression-statement fixtures.
 * @param {Statement} stmt
 * @returns {Expression}
 */
function exprOf(stmt) {
  if (stmt.type !== 'ExpressionStatement') throw new Error(`expected ExpressionStatement, got ${stmt.type}`);
  return stmt.expression;
}

/**
 * @param {Expression} expr
 * @returns {import('../src/parser.js').BinaryExpression}
 */
function asBinary(expr) {
  if (expr.type !== 'BinaryExpression') throw new Error(`expected BinaryExpression, got ${expr.type}`);
  return expr;
}

test('respects arithmetic precedence: * binds tighter than +', () => {
  const program = parse('1 + 2 * 3');
  const expr = asBinary(exprOf(program.body[0]));
  assert.equal(expr.operator, '+');
  assert.equal(expr.left.type, 'NumberLiteral');
  if (expr.left.type !== 'NumberLiteral') throw new Error();
  assert.equal(expr.left.value, 1);
  const right = asBinary(expr.right);
  assert.equal(right.operator, '*');
});

test('left-associates same-precedence operators', () => {
  const program = parse('1 - 2 - 3');
  const expr = asBinary(exprOf(program.body[0]));
  assert.equal(expr.operator, '-');
  if (expr.right.type !== 'NumberLiteral') throw new Error();
  assert.equal(expr.right.value, 3);
  const left = asBinary(expr.left);
  assert.equal(left.operator, '-');
});

test('every node carries a span matching its source slice', () => {
  const source = '1 + 2 * 3';
  const program = parse(source);
  const expr = asBinary(exprOf(program.body[0]));
  assert.equal(source.slice(expr.span.start, expr.span.end), source);
  assert.equal(source.slice(expr.left.span.start, expr.left.span.end), '1');
  assert.equal(source.slice(expr.right.span.start, expr.right.span.end), '2 * 3');
});

test('assignment is right-associative and lowest precedence', () => {
  const program = parse('x = y = 1 + 2');
  const expr = exprOf(program.body[0]);
  if (expr.type !== 'AssignmentExpression') throw new Error();
  assert.equal(expr.name.name, 'x');
  if (expr.value.type !== 'AssignmentExpression') throw new Error();
  assert.equal(expr.value.name.name, 'y');
});

test('parses let, if/else, while, blocks, fn and return', () => {
  const source = `
    let n = 5
    fn fact(n) {
      if (n <= 1) {
        return 1
      } else {
        return n * fact(n - 1)
      }
    }
    while (n > 0) {
      n = n - 1
    }
  `;
  const program = parse(source);
  assert.equal(program.body[0].type, 'LetStatement');
  const fn = program.body[1];
  assert.equal(fn.type, 'FnDeclaration');
  if (fn.type !== 'FnDeclaration') throw new Error();
  assert.equal(fn.params[0].name, 'n');
  assert.equal(program.body[2].type, 'WhileStatement');
});

test('parses break and continue inside a while loop', () => {
  const program = parse('while (true) { break } while (true) { continue }');
  const first = program.body[0];
  assert.equal(first.type, 'WhileStatement');
  if (first.type !== 'WhileStatement') throw new Error();
  assert.equal(first.body.body[0].type, 'BreakStatement');
  const second = program.body[1];
  assert.equal(second.type, 'WhileStatement');
  if (second.type !== 'WhileStatement') throw new Error();
  assert.equal(second.body.body[0].type, 'ContinueStatement');
});

test('parses call expressions with arguments', () => {
  const program = parse('foo(1, 2 + 3, "x")');
  const call = exprOf(program.body[0]);
  assert.equal(call.type, 'CallExpression');
  if (call.type !== 'CallExpression') throw new Error();
  assert.equal(call.callee.type, 'Identifier');
  if (call.callee.type !== 'Identifier') throw new Error();
  assert.equal(call.callee.name, 'foo');
  assert.equal(call.args.length, 3);
});

test('reports line and column on parse errors', () => {
  try {
    parse('let x =\nlet y = 2');
    assert.fail('expected ParseError');
  } catch (err) {
    assert.ok(err instanceof ParseError);
    assert.equal(err.line, 2);
  }
});

test('rejects assignment to a non-identifier target', () => {
  assert.throws(() => parse('1 + 2 = 3'), ParseError);
});
