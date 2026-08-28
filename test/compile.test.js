import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.js';
import { compile, disassemble, disassembleAll, CompileError, META, OP } from '../src/compile.js';

/** @typedef {import('../src/compile.js').Chunk} Chunk */

/**
 * @param {string} source
 * @returns {Chunk}
 */
function chunkFor(source) {
  return compile(parse(source));
}

/**
 * Every chunk in a program, entry first.
 * @param {Chunk} chunk
 * @returns {Chunk[]}
 */
function allChunks(chunk) {
  return [chunk, ...chunk.protos.flatMap(allChunks)];
}

test('every opcode carries its name and operand count', () => {
  for (const [name, op] of Object.entries(OP)) {
    assert.ok(META[op] !== undefined, `${name} has no metadata`);
    assert.equal(META[op].name, name);
    assert.ok(META[op].operands === 0 || META[op].operands === 1);
  }
});

test('walking with the operand counts lands on every opcode and nothing else', () => {
  const chunk = chunkFor('let n = 0 while (n < 3) { n = n + 1 } print(n)');
  const opcodes = new Set(disassemble(chunk).map((line) => line.pc));
  // Any slot the walk did not stop on has to be an operand of one it did.
  for (let pc = 0; pc < chunk.code.length; pc++) {
    if (opcodes.has(pc)) continue;
    assert.ok(opcodes.has(pc - 1), `slot ${pc} belongs to no instruction`);
  }
});

test('the source map has an entry for every slot of every chunk', () => {
  const source = 'fn f(a) { return a + 1 } let x = f(1) while (x < 3) { x = x + 1 }';
  for (const chunk of allChunks(chunkFor(source))) {
    assert.equal(chunk.spans.length, chunk.code.length, `${chunk.name} has a hole in its source map`);
    for (const span of chunk.spans) {
      assert.ok(span.start >= 0 && span.end <= source.length && span.start <= span.end);
    }
  }
});

test('an instruction maps back to the source it came from', () => {
  const source = 'let total = 1 + 2';
  const chunk = chunkFor(source);
  const add = disassemble(chunk).find((line) => line.op === OP.ADD);
  assert.ok(add !== undefined);
  assert.equal(source.slice(add.span.start, add.span.end), '1 + 2');
});

test('a literal used twice is pooled once', () => {
  const chunk = chunkFor('1 + 1 + 1');
  assert.deepEqual(chunk.constants, [1]);
  assert.equal(disassemble(chunk).filter((line) => line.op === OP.CONST).length, 3);
});

test('a name and a string of the same text share a pool entry', () => {
  const chunk = chunkFor('let x = "x"');
  assert.deepEqual(chunk.constants, ['x']);
});

test('a loop jumps backwards, so offsets have to be signed', () => {
  const chunk = chunkFor('let i = 0 while (i < 3) { i = i + 1 }');
  const jumps = disassemble(chunk).filter((line) => line.op === OP.JUMP);
  const back = jumps.filter((line) => /** @type {number} */ (line.operand) < 0);
  assert.equal(back.length, 1, 'exactly one jump should run backwards');
  // It lands on the test, not on the body: a loop re-checks before it repeats.
  assert.equal(back[0].pc + 2 + /** @type {number} */ (back[0].operand), 5);
});

test('a forward jump lands on the instruction it was patched to', () => {
  const chunk = chunkFor('if (0) { 1 } else { 2 }');
  const lines = disassemble(chunk);
  const branch = /** @type {import('../src/compile.js').Line} */ (lines.find((line) => line.op === OP.JUMP_IF_FALSE));
  const target = branch.pc + 2 + /** @type {number} */ (branch.operand);
  assert.ok(lines.some((line) => line.pc === target), 'the branch lands mid-instruction');
  // Straight into the else arm, which opens a scope like any other block.
  assert.equal(chunk.code[target], OP.PUSH_SCOPE);
});

test('leaving a loop early pops the scopes opened inside it', () => {
  const chunk = chunkFor('while (true) { { { break } } }');
  const pops = disassemble(chunk).filter((line) => line.op === OP.POP_SCOPE);
  // Three closing braces the loop reaches normally, plus the three scopes
  // `break` is standing inside and has to leave on its way out.
  assert.equal(pops.length, 3 + 3);
});

test('break outside a loop is caught at compile time, with a span', () => {
  assert.throws(
    () => chunkFor('let x = 1 break'),
    (/** @type {CompileError} */ error) => {
      assert.ok(error instanceof CompileError);
      assert.equal(error.message, "'break' outside of a loop");
      assert.deepEqual(error.span, { start: 10, end: 15 });
      return true;
    },
  );
});

test('return outside a function is caught at compile time', () => {
  assert.throws(() => chunkFor('return 1'), { name: 'CompileError', message: "'return' outside of a function" });
});

test('a name declared twice in one scope is caught at compile time', () => {
  assert.throws(() => chunkFor('let x = 1 let x = 2'), { message: "'x' is already declared in this scope" });
  assert.throws(() => chunkFor('fn f() { } fn f() { }'), { message: "'f' is already declared in this scope" });
});

test('the same name in nested scopes is fine', () => {
  assert.doesNotThrow(() => chunkFor('let x = 1 { let x = 2 { let x = 3 } }'));
  assert.doesNotThrow(() => chunkFor('fn f(x) { let x = 2 }'));
});

test('a function compiles to its own chunk, listed under the one that declared it', () => {
  const chunk = chunkFor('fn outer() { fn inner() { } }');
  assert.deepEqual(chunk.protos.map((proto) => proto.name), ['outer']);
  assert.deepEqual(chunk.protos[0].protos.map((proto) => proto.name), ['inner']);
  assert.deepEqual(chunk.protos[0].code.slice(-1), [OP.RET], 'a body always ends by returning');
});

test('a disassembly says what the operands refer to', () => {
  assert.equal(
    disassembleAll(chunkFor('let n = 2 print(n)')),
    [
      '<program>():',
      '0000  CONST                0  ; 2',
      '0002  DEFINE               1  ; n',
      '0004  POP',
      '0005  GET                  2  ; print',
      '0007  GET                  1  ; n',
      '0009  CALL                 1',
      '0011  HALT',
    ].join('\n'),
  );
});
