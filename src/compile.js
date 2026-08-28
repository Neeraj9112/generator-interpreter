// @ts-check

/** @typedef {import('./parser.js').Span} Span */
/** @typedef {import('./parser.js').Program} Program */
/** @typedef {import('./parser.js').Statement} Statement */
/** @typedef {import('./parser.js').Expression} Expression */
/** @typedef {import('./parser.js').Block} Block */
/** @typedef {import('./parser.js').IfStatement} IfStatement */
/** @typedef {import('./parser.js').WhileStatement} WhileStatement */
/** @typedef {import('./parser.js').FnDeclaration} FnDeclaration */
/** @typedef {import('./values.js').Value} Value */

/**
 * The instruction set. Numbers, not bytes: a byte caps the constant pool at
 * 256 entries and a jump at 255 slots, and every loop needs a *signed* jump
 * anyway. Byte-packing buys density, and density is not what this VM is for.
 *
 * Operands are inline — an instruction occupies one slot for the opcode plus
 * one for its operand if it takes one, so `pc` steps by 1 or 2. `META` below
 * is what says which.
 * @enum {number}
 */
export const OP = {
  /** Push `constants[a]`. */
  CONST: 0,
  /** Discard the top of the stack. */
  POP: 1,
  /** Push the value bound to the name `constants[a]`. */
  GET: 2,
  /** Write the top of the stack to an existing binding of `constants[a]`, leaving it. */
  SET: 3,
  /** Bind `constants[a]` in the current scope to the top of the stack, leaving it. */
  DEFINE: 4,
  /** Close `protos[a]` over the current scope, bind it under its own name, push it. */
  CLOSURE: 5,
  /** Enter a nested scope. */
  PUSH_SCOPE: 6,
  /** Leave it. */
  POP_SCOPE: 7,
  /** `pc += a`, signed. */
  JUMP: 8,
  /** Pop; jump if it was falsy. */
  JUMP_IF_FALSE: 9,
  /** Jump if the top is falsy, leaving it; otherwise pop. This is `&&`. */
  JUMP_IF_FALSE_KEEP: 10,
  /** Jump if the top is truthy, leaving it; otherwise pop. This is `||`. */
  JUMP_IF_TRUE_KEEP: 11,
  /** Call the callee sitting under `a` arguments. */
  CALL: 12,
  /** Pop the return value, pop the frame, push the value in the caller. */
  RET: 13,
  NEG: 14,
  NOT: 15,
  ADD: 16,
  SUB: 17,
  MUL: 18,
  DIV: 19,
  MOD: 20,
  EQ: 21,
  NE: 22,
  LT: 23,
  LE: 24,
  GT: 25,
  GE: 26,
  /** End the program; the top of the stack is its value. */
  HALT: 27,
};

/**
 * Name and operand count per opcode, keyed by the opcode itself so the
 * numbers can only be written once. The disassembler and the VM both walk
 * instructions with this rather than with a `switch` that knows widths.
 * @type {Record<number, {name: string, operands: number}>}
 */
export const META = {
  [OP.CONST]: { name: 'CONST', operands: 1 },
  [OP.POP]: { name: 'POP', operands: 0 },
  [OP.GET]: { name: 'GET', operands: 1 },
  [OP.SET]: { name: 'SET', operands: 1 },
  [OP.DEFINE]: { name: 'DEFINE', operands: 1 },
  [OP.CLOSURE]: { name: 'CLOSURE', operands: 1 },
  [OP.PUSH_SCOPE]: { name: 'PUSH_SCOPE', operands: 0 },
  [OP.POP_SCOPE]: { name: 'POP_SCOPE', operands: 0 },
  [OP.JUMP]: { name: 'JUMP', operands: 1 },
  [OP.JUMP_IF_FALSE]: { name: 'JUMP_IF_FALSE', operands: 1 },
  [OP.JUMP_IF_FALSE_KEEP]: { name: 'JUMP_IF_FALSE_KEEP', operands: 1 },
  [OP.JUMP_IF_TRUE_KEEP]: { name: 'JUMP_IF_TRUE_KEEP', operands: 1 },
  [OP.CALL]: { name: 'CALL', operands: 1 },
  [OP.RET]: { name: 'RET', operands: 0 },
  [OP.NEG]: { name: 'NEG', operands: 0 },
  [OP.NOT]: { name: 'NOT', operands: 0 },
  [OP.ADD]: { name: 'ADD', operands: 0 },
  [OP.SUB]: { name: 'SUB', operands: 0 },
  [OP.MUL]: { name: 'MUL', operands: 0 },
  [OP.DIV]: { name: 'DIV', operands: 0 },
  [OP.MOD]: { name: 'MOD', operands: 0 },
  [OP.EQ]: { name: 'EQ', operands: 0 },
  [OP.NE]: { name: 'NE', operands: 0 },
  [OP.LT]: { name: 'LT', operands: 0 },
  [OP.LE]: { name: 'LE', operands: 0 },
  [OP.GT]: { name: 'GT', operands: 0 },
  [OP.GE]: { name: 'GE', operands: 0 },
  [OP.HALT]: { name: 'HALT', operands: 0 },
};

/** Source operator text per binary opcode — the VM needs it for messages. @type {Record<number, string>} */
export const BINARY_OP = {
  [OP.ADD]: '+',
  [OP.SUB]: '-',
  [OP.MUL]: '*',
  [OP.DIV]: '/',
  [OP.MOD]: '%',
  [OP.EQ]: '==',
  [OP.NE]: '!=',
  [OP.LT]: '<',
  [OP.LE]: '<=',
  [OP.GT]: '>',
  [OP.GE]: '>=',
};

/** @type {Record<string, number>} */
const OPCODE_FOR_OPERATOR = {
  '+': OP.ADD,
  '-': OP.SUB,
  '*': OP.MUL,
  '/': OP.DIV,
  '%': OP.MOD,
  '==': OP.EQ,
  '!=': OP.NE,
  '<': OP.LT,
  '<=': OP.LE,
  '>': OP.GT,
  '>=': OP.GE,
};

/**
 * One compiled function: its instructions, the constants they index, the
 * functions declared inside it, and — the part that keeps the debugger
 * alive — a span per slot of `code`, so any `pc` maps straight back to
 * source. `spans` is parallel to `code` rather than sparse, which costs a
 * few array entries and saves every lookup from having to find the opcode
 * an operand belongs to.
 *
 * Nested functions live in `protos` rather than in `constants` because a
 * chunk is not a `Value`: a closure is what you get by pairing one with an
 * env, and that pairing happens at run time.
 * @typedef {{
 *   name: string,
 *   params: string[],
 *   code: number[],
 *   spans: Span[],
 *   constants: Value[],
 *   protos: Chunk[],
 * }} Chunk
 */

/**
 * Something the compiler can see is wrong without running the program.
 * The tree-walker reports these when execution reaches them; the compiler
 * reports them whether it would or not, which is the one place the two
 * backends genuinely disagree.
 */
export class CompileError extends Error {
  /**
   * @param {string} message
   * @param {Span} span
   */
  constructor(message, span) {
    super(message);
    this.name = 'CompileError';
    this.span = span;
  }
}

/**
 * Compiles one function body — or the whole program, which is just the
 * outermost one. A nested `fn` gets its own instance, so `code`, the pool
 * and the scope stack are never shared across a function boundary.
 */
class ChunkCompiler {
  /**
   * @param {string} name
   * @param {string[]} params
   * @param {boolean} isFunction whether `return` is legal in here
   */
  constructor(name, params, isFunction) {
    /** @type {Chunk} */
    this.chunk = { name, params, code: [], spans: [], constants: [], protos: [] };
    this.isFunction = isFunction;

    /**
     * Names bound per scope, innermost last. Only for catching a name
     * declared twice in one scope — *reads* stay dynamic, resolved against
     * the live env chain at run time, exactly as the tree-walker does them.
     * @type {Set<string>[]}
     */
    this.scopes = [new Set(params)];

    /**
     * Loops currently open around the instruction being emitted, so `break`
     * and `continue` know where to jump and how many scopes they are leaving.
     * @type {{start: number, scopeDepth: number, breaks: number[]}[]}
     */
    this.loops = [];

    /** Constant pool index by value, so a literal used twice is stored once. @type {Map<Value, number>} */
    this.pool = new Map();
  }

  /**
   * @param {number} op
   * @param {Span} span
   * @returns {number} the slot the opcode landed in
   */
  emit(op, span) {
    this.chunk.code.push(op);
    this.chunk.spans.push(span);
    return this.chunk.code.length - 1;
  }

  /**
   * @param {number} op
   * @param {number} operand
   * @param {Span} span
   * @returns {number} the slot the *operand* landed in
   */
  emitArg(op, operand, span) {
    this.emit(op, span);
    this.chunk.code.push(operand);
    this.chunk.spans.push(span);
    return this.chunk.code.length - 1;
  }

  /**
   * @param {Value} value
   * @param {Span} span
   */
  emitConst(value, span) {
    this.emitArg(OP.CONST, this.constant(value), span);
  }

  /**
   * @param {Value} value
   * @returns {number}
   */
  constant(value) {
    const existing = this.pool.get(value);
    if (existing !== undefined) return existing;
    const index = this.chunk.constants.push(value) - 1;
    this.pool.set(value, index);
    return index;
  }

  /**
   * A forward jump to a target that hasn't been emitted yet: leave a hole,
   * remember where it is, fill it in once the target is known.
   * @param {number} op
   * @param {Span} span
   * @returns {number} the hole
   */
  emitJump(op, span) {
    return this.emitArg(op, 0, span);
  }

  /**
   * Offsets are relative to the instruction *after* the jump, which is where
   * `pc` sits by the time the VM applies them — and signed, so the same
   * instruction serves a loop's jump back to the top.
   * @param {number} hole
   */
  patchJump(hole) {
    this.chunk.code[hole] = this.chunk.code.length - (hole + 1);
  }

  /**
   * @param {number} target
   * @param {Span} span
   */
  emitLoop(target, span) {
    this.emitArg(OP.JUMP, target - (this.chunk.code.length + 2), span);
  }

  beginScope() {
    this.scopes.push(new Set());
  }

  endScope() {
    this.scopes.pop();
  }

  /**
   * @param {string} name
   * @param {Span} span
   */
  declare(name, span) {
    const scope = this.scopes[this.scopes.length - 1];
    if (scope.has(name)) throw new CompileError(`'${name}' is already declared in this scope`, span);
    scope.add(name);
  }

  /**
   * Statements run in order and the last one's value is the sequence's
   * value, so each one leaves exactly one value behind and the next pops it.
   * An empty sequence still has to leave something.
   * @param {Statement[]} body
   * @param {Span} span the enclosing block, for an empty body
   */
  statements(body, span) {
    if (body.length === 0) {
      this.emitConst(undefined, span);
      return;
    }
    for (let i = 0; i < body.length; i++) {
      if (i > 0) this.emit(OP.POP, body[i - 1].span);
      this.statement(body[i]);
    }
  }

  /** @param {Statement} node */
  statement(node) {
    switch (node.type) {
      case 'ExpressionStatement':
        this.expression(node.expression);
        return;
      case 'LetStatement':
        this.declare(node.name.name, node.name.span);
        this.expression(node.init);
        this.emitArg(OP.DEFINE, this.constant(node.name.name), node.span);
        return;
      case 'Block':
        this.block(node);
        return;
      case 'IfStatement':
        this.ifStatement(node);
        return;
      case 'WhileStatement':
        this.whileStatement(node);
        return;
      case 'BreakStatement':
      case 'ContinueStatement':
        this.jumpOutOfLoop(node.type === 'BreakStatement' ? 'break' : 'continue', node.span);
        return;
      case 'ReturnStatement':
        if (!this.isFunction) throw new CompileError("'return' outside of a function", node.span);
        if (node.argument === null) this.emitConst(undefined, node.span);
        else this.expression(node.argument);
        this.emit(OP.RET, node.span);
        return;
      case 'FnDeclaration':
        this.fnDeclaration(node);
        return;
      default:
        throw new CompileError(
          `compile: no rule for node type '${/** @type {{type: string}} */ (node).type}'`,
          /** @type {{span: Span}} */ (node).span,
        );
    }
  }

  /** @param {Block} node */
  block(node) {
    this.emit(OP.PUSH_SCOPE, node.span);
    this.beginScope();
    this.statements(node.body, node.span);
    this.endScope();
    this.emit(OP.POP_SCOPE, node.span);
  }

  /**
   * Both arms have to leave a value, because whichever one runs is the
   * statement's value — so a missing `else` is compiled as one that produces
   * nothing rather than as no arm at all.
   * @param {IfStatement} node
   */
  ifStatement(node) {
    this.expression(node.test);
    const toElse = this.emitJump(OP.JUMP_IF_FALSE, node.test.span);
    this.block(node.consequent);
    const toEnd = this.emitJump(OP.JUMP, node.span);
    this.patchJump(toElse);
    if (node.alternate === null) this.emitConst(undefined, node.span);
    else if (node.alternate.type === 'Block') this.block(node.alternate);
    else this.ifStatement(node.alternate);
    this.patchJump(toEnd);
  }

  /**
   * A loop's value is always nothing, so the body's value is popped on every
   * pass and the exit pushes one afterwards. `break` and `continue` are
   * plain jumps here — there is no sentinel to propagate, because the
   * compiler already knows where the loop ends.
   * @param {WhileStatement} node
   */
  whileStatement(node) {
    const start = this.chunk.code.length;
    this.expression(node.test);
    const toEnd = this.emitJump(OP.JUMP_IF_FALSE, node.test.span);

    this.loops.push({ start, scopeDepth: this.scopes.length, breaks: [] });
    this.block(node.body);
    this.emit(OP.POP, node.body.span);
    this.emitLoop(start, node.span);
    const loop = /** @type {{start: number, scopeDepth: number, breaks: number[]}} */ (this.loops.pop());

    this.patchJump(toEnd);
    for (const hole of loop.breaks) this.patchJump(hole);
    this.emitConst(undefined, node.span);
  }

  /**
   * Leaving a loop early means leaving every scope opened inside it, which a
   * jump does not do on its own. `return` needs no such thing: `RET` drops
   * the whole frame, and the frame is what was holding the scope chain.
   * @param {'break'|'continue'} kind
   * @param {Span} span
   */
  jumpOutOfLoop(kind, span) {
    const loop = this.loops[this.loops.length - 1];
    if (loop === undefined) throw new CompileError(`'${kind}' outside of a loop`, span);
    for (let depth = this.scopes.length; depth > loop.scopeDepth; depth--) this.emit(OP.POP_SCOPE, span);
    if (kind === 'continue') this.emitLoop(loop.start, span);
    else loop.breaks.push(this.emitJump(OP.JUMP, span));
  }

  /** @param {FnDeclaration} node */
  fnDeclaration(node) {
    this.declare(node.name.name, node.name.span);
    const index = this.chunk.protos.push(compileFunction(node)) - 1;
    this.emitArg(OP.CLOSURE, index, node.span);
  }

  /** @param {Expression} node */
  expression(node) {
    switch (node.type) {
      case 'NumberLiteral':
      case 'StringLiteral':
      case 'BooleanLiteral':
        this.emitConst(node.value, node.span);
        return;
      case 'Identifier':
        this.emitArg(OP.GET, this.constant(node.name), node.span);
        return;
      case 'AssignmentExpression':
        this.expression(node.value);
        this.emitArg(OP.SET, this.constant(node.name.name), node.span);
        return;
      case 'CallExpression':
        this.expression(node.callee);
        for (const arg of node.args) this.expression(arg);
        this.emitArg(OP.CALL, node.args.length, node.span);
        return;
      case 'UnaryExpression':
        this.expression(node.argument);
        this.emit(node.operator === '-' ? OP.NEG : OP.NOT, node.span);
        return;
      case 'BinaryExpression':
        this.binary(node);
        return;
      default:
        throw new CompileError(
          `compile: no rule for node type '${/** @type {{type: string}} */ (node).type}'`,
          /** @type {{span: Span}} */ (node).span,
        );
    }
  }

  /**
   * `&&` and `||` are the two operators that are really control flow: they
   * compile to a jump over the right operand, keeping the left one as the
   * result when it decides the answer. Every other operator gets both sides
   * evaluated and one instruction.
   * @param {import('./parser.js').BinaryExpression} node
   */
  binary(node) {
    if (node.operator === '&&' || node.operator === '||') {
      this.expression(node.left);
      const skip = this.emitJump(node.operator === '&&' ? OP.JUMP_IF_FALSE_KEEP : OP.JUMP_IF_TRUE_KEEP, node.span);
      this.emit(OP.POP, node.span);
      this.expression(node.right);
      this.patchJump(skip);
      return;
    }
    this.expression(node.left);
    this.expression(node.right);
    const op = OPCODE_FOR_OPERATOR[node.operator];
    if (op === undefined) throw new CompileError(`compile: unknown operator '${node.operator}'`, node.span);
    this.emit(op, node.span);
  }
}

/**
 * A function's parameters live in the scope the *call* creates, and the body
 * block opens one more inside it — the same two scopes the tree-walker
 * pushes, so a `let` shadowing a parameter is legal on both backends.
 *
 * Falling off the end of a body produces nothing, which is why the tail is
 * always a `RET` whatever the last statement was.
 * @param {FnDeclaration} node
 * @returns {Chunk}
 */
function compileFunction(node) {
  const fn = new ChunkCompiler(node.name.name, node.params.map((p) => p.name), true);
  fn.block(node.body);
  fn.emit(OP.POP, node.body.span);
  fn.emitConst(undefined, node.body.span);
  fn.emit(OP.RET, node.body.span);
  return fn.chunk;
}

/**
 * @param {Program} program
 * @returns {Chunk}
 */
export function compile(program) {
  const main = new ChunkCompiler('<program>', [], false);
  main.statements(program.body, program.span);
  main.emit(OP.HALT, program.span);
  return main.chunk;
}

/** @typedef {{pc: number, op: number, name: string, operand: number|null, note: string, span: Span}} Line */

/**
 * Walk one chunk's instructions. `META` supplies the widths, so this stays
 * correct when the instruction set grows.
 * @param {Chunk} chunk
 * @returns {Line[]}
 */
export function disassemble(chunk) {
  /** @type {Line[]} */
  const lines = [];
  let pc = 0;
  while (pc < chunk.code.length) {
    const op = chunk.code[pc];
    const meta = META[op];
    if (meta === undefined) {
      lines.push({ pc, op, name: `<${op}?>`, operand: null, note: '', span: chunk.spans[pc] });
      pc += 1;
      continue;
    }
    const operand = meta.operands === 1 ? chunk.code[pc + 1] : null;
    lines.push({ pc, op, name: meta.name, operand, note: note(chunk, op, operand, pc), span: chunk.spans[pc] });
    pc += 1 + meta.operands;
  }
  return lines;
}

/**
 * The half of a disassembly listing that isn't the instruction: what the
 * operand actually refers to. A bare `CONST 3` is unreadable; `CONST 3 ; 42`
 * is the reason anyone opens this view.
 * @param {Chunk} chunk
 * @param {number} op
 * @param {number|null} operand
 * @param {number} pc
 * @returns {string}
 */
function note(chunk, op, operand, pc) {
  if (operand === null) return '';
  switch (op) {
    case OP.CONST: {
      const value = chunk.constants[operand];
      return typeof value === 'string' ? JSON.stringify(value) : String(value);
    }
    case OP.GET:
    case OP.SET:
    case OP.DEFINE:
      return String(chunk.constants[operand]);
    case OP.CLOSURE:
      return `fn ${chunk.protos[operand].name}`;
    case OP.JUMP:
    case OP.JUMP_IF_FALSE:
    case OP.JUMP_IF_FALSE_KEEP:
    case OP.JUMP_IF_TRUE_KEEP:
      return `-> ${String(pc + 2 + operand).padStart(4, '0')}`;
    default:
      return '';
  }
}

/**
 * @param {Line} line
 * @returns {string}
 */
export function formatLine(line) {
  const head = `${String(line.pc).padStart(4, '0')}  ${line.name.padEnd(18)}`;
  const operand = line.operand === null ? '    ' : String(line.operand).padStart(4);
  return line.note === '' ? `${head}${operand}`.trimEnd() : `${head}${operand}  ; ${line.note}`;
}

/**
 * The whole program, one chunk after another — the entry chunk first, then
 * every function reachable from it, depth first.
 * @param {Chunk} chunk
 * @returns {string}
 */
export function disassembleAll(chunk) {
  const body = disassemble(chunk).map(formatLine).join('\n');
  const nested = chunk.protos.map((proto) => `\n\n${disassembleAll(proto)}`).join('');
  return `${chunk.name}(${chunk.params.join(', ')}):\n${body}${nested}`;
}
