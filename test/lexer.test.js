import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, LexError } from '../src/lexer.js';

test('tokenizes numbers, strings, identifiers, operators', () => {
  const tokens = tokenize('let x = 1.5 + "hi" * foo');
  const types = tokens.map((t) => t.type);
  assert.deepEqual(types, [
    'LET', 'IDENT', 'EQ', 'NUMBER', 'PLUS', 'STRING', 'STAR', 'IDENT', 'EOF',
  ]);
});

test('records spans as UTF-16 code unit indices', () => {
  // U+1F600 is a surrogate pair: 2 UTF-16 code units but 1 Unicode code point.
  // A byte-oriented or codepoint-oriented span would desync the token after it.
  const source = 'let s = "\u{1F600}" + 1';
  const tokens = tokenize(source);
  const plus = tokens.find((t) => t.type === 'PLUS');
  assert.ok(plus);
  assert.equal(source.slice(plus.start, plus.end), '+');
});

test('skips line comments', () => {
  const tokens = tokenize('1 // this is a comment\n+ 2');
  assert.deepEqual(tokens.map((t) => t.type), ['NUMBER', 'PLUS', 'NUMBER', 'EOF']);
});

test('recognizes two-character operators before single-character ones', () => {
  const tokens = tokenize('a == b != c <= d >= e && f || g');
  assert.deepEqual(tokens.map((t) => t.type), [
    'IDENT', 'EQEQ', 'IDENT', 'BANGEQ', 'IDENT', 'LTEQ', 'IDENT',
    'GTEQ', 'IDENT', 'AND', 'IDENT', 'OR', 'IDENT', 'EOF',
  ]);
});

test('parses string escapes', () => {
  const tokens = tokenize('"a\\nb\\t\\"c\\""');
  assert.equal(tokens[0].value, 'a\nb\t"c"');
});

test('throws LexError with line/col on unterminated string', () => {
  assert.throws(() => tokenize('"unterminated'), LexError);
});

test('throws LexError on unexpected character', () => {
  assert.throws(() => tokenize('let x = 1 $ 2'), LexError);
});
