// @ts-check
import { Env } from './env.js';
import { applyBinary, applyUnary, arityMessage, arityOf, describe, isCallable, isTruthy } from './values.js';
import { validate } from './validate.js';

/** @typedef {import('./parser.js').Program} Program */
/** @typedef {import('./parser.js').Statement} Statement */
/** @typedef {import('./parser.js').Expression} Expression */
/** @typedef {import('./parser.js').BinaryExpression} BinaryExpression */
/** @typedef {import('./parser.js').UnaryExpression} UnaryExpression */
/** @typedef {import('./parser.js').Identifier} Identifier */
/** @typedef {import('./parser.js').Block} Block */
/** @typedef {import('./parser.js').LetStatement} LetStatement */
/** @typedef {import('./parser.js').AssignmentExpression} AssignmentExpression */
/** @typedef {import('./parser.js').IfStatement} IfStatement */
/** @typedef {import('./parser.js').WhileStatement} WhileStatement */
/** @typedef {import('./parser.js').ReturnStatement} ReturnStatement */
/** @typedef {import('./parser.js').FnDeclaration} FnDeclaration */
/** @typedef {import('./parser.js').CallExpression} CallExpression */
/** @typedef {Program|Statement|Expression} Node */

/** @typedef {import('./values.js').FnValue} FnValue */
/** @typedef {import('./values.js').Value} Value */

/**
 * Truthiness, `describe` and the arithmetic and comparison rules live in
 * `values.js` because the VM needs exactly the same answers. Anything shared
 * between the backends belongs there; what stays here is how the tree-walker
 * *reaches* an operation, not what the operation means.
 */
export { isTruthy } from './values.js';

/** @typedef {'return'|'break'|'continue'|'error'} SignalKind */

/**
 * Evaluating a node either produces a value or unwinds. The two are not the
 * same kind of thing, and every `yield*` site has to tell them apart.
 * @typedef {Value|Signal} Completion
 */

/**
 * One pause point per node: an 'enter' step before it evaluates, an 'exit'
 * step after. Each carries the live `env` reference rather than a snapshot,
 * so a driver renders scope as it stands at that instant. An exit step's
 * value is a `Signal` when the node unwound instead of producing a value,
 * which is what keeps an unwind visible to the debugger.
 * @typedef {{node: Node, env: Env, phase: 'enter'}} EnterStep
 * @typedef {{node: Node, env: Env, phase: 'exit', value: Completion}} ExitStep
 * @typedef {EnterStep|ExitStep} Step
 */

/**
 * The single non-local exit. Rather than throwing, an evaluator *returns* a
 * Signal and every caller propagates it outward until something catches it:
 * a loop catches `break` and `continue`, a call catches `return`, and only
 * `run()` catches `error`. A JS `throw` travelling up a `yield*` chain would
 * skip every pause point on the way out, making the unwind invisible to the
 * debugger and impossible to resume, which is the whole reason for this.
 */
export class Signal {
  /**
   * @param {SignalKind} kind
   * @param {Node} node the node the exit started at
   * @param {{value?: Value, message?: string}} [detail]
   */
  constructor(kind, node, detail = {}) {
    this.kind = kind;
    this.node = node;
    /** Carried by 'return' only. @type {Value} */
    this.value = detail.value;
    /** Carried by 'error' only. @type {string} */
    this.message = detail.message ?? '';
  }
}

/**
 * @param {Completion} result
 * @returns {result is Signal}
 */
export function isSignal(result) {
  return result instanceof Signal;
}

/**
 * @param {Node} node
 * @param {string} message
 * @returns {Signal}
 */
function fail(node, message) {
  return new Signal('error', node, { message });
}

/**
 * A signal that reached somewhere nothing catches it. An `error` keeps going.
 * A `return`, `break` or `continue` that got this far was never inside the
 * thing it exits, so it becomes an error. `break` with no loop around it is
 * a mistake, not a control-flow request.
 * @param {Signal} signal
 * @returns {Signal}
 */
function escaped(signal) {
  if (signal.kind === 'error') return signal;
  const missing = signal.kind === 'return' ? 'a function' : 'a loop';
  return fail(signal.node, `'${signal.kind}' outside of ${missing}`);
}

export class EvalError extends Error {
  /**
   * @param {string} message
   * @param {Node} node
   */
  constructor(message, node) {
    super(message);
    this.name = 'EvalError';
    this.node = node;
  }
}

/**
 * Evaluate `node` in `env`, recursing with `yield*` so a driver stepping
 * the outer iterator can pause at any depth of the tree. No plain recursive
 * call ever runs a subtree to completion in one go.
 * @param {Node} node
 * @param {Env} env
 * @returns {Generator<Step, Completion, void>}
 */
export function* evaluate(node, env) {
  yield { node, env, phase: 'enter' };
  const value = yield* evalNode(node, env);
  yield { node, env, phase: 'exit', value };
  return value;
}

/**
 * @param {Node} node
 * @param {Env} env
 * @returns {Generator<Step, Completion, void>}
 */
function* evalNode(node, env) {
  switch (node.type) {
    case 'Program':
      return yield* evalProgram(node, env);
    case 'Block':
      // The block's own enter/exit steps report the enclosing scope: at the
      // opening brace nothing is bound yet, and by the closing one the
      // block's bindings are already out of reach.
      return yield* evalStatements(node.body, env.child());
    case 'ExpressionStatement':
      return yield* evaluate(node.expression, env);
    case 'NumberLiteral':
    case 'StringLiteral':
    case 'BooleanLiteral':
      return node.value;
    case 'Identifier':
      return evalIdentifier(node, env);
    case 'LetStatement':
      return yield* evalLet(node, env);
    case 'AssignmentExpression':
      return yield* evalAssignment(node, env);
    case 'IfStatement':
      return yield* evalIf(node, env);
    case 'WhileStatement':
      return yield* evalWhile(node, env);
    case 'BreakStatement':
      return new Signal('break', node);
    case 'ContinueStatement':
      return new Signal('continue', node);
    case 'ReturnStatement':
      return yield* evalReturn(node, env);
    case 'FnDeclaration':
      return evalFnDeclaration(node, env);
    case 'CallExpression':
      return yield* evalCall(node, env);
    case 'UnaryExpression':
      return yield* evalUnary(node, env);
    case 'BinaryExpression':
      return yield* evalBinary(node, env);
    default:
      return fail(node, `evaluate: no rule for node type '${/** @type {{type: string}} */ (node).type}'`);
  }
}

/**
 * Statements run in order and the last one's value is the sequence's value.
 * A signal from any of them ends the sequence there and travels outward.
 * @param {Statement[]} body
 * @param {Env} env
 * @returns {Generator<Step, Completion, void>}
 */
function* evalStatements(body, env) {
  /** @type {Completion} */
  let value = undefined;
  for (const stmt of body) {
    value = yield* evaluate(stmt, env);
    if (isSignal(value)) return value;
  }
  return value;
}

/**
 * @param {Program} node
 * @param {Env} env
 * @returns {Generator<Step, Completion, void>}
 */
function* evalProgram(node, env) {
  const result = yield* evalStatements(node.body, env);
  return isSignal(result) ? escaped(result) : result;
}

/**
 * @param {Identifier} node
 * @param {Env} env
 * @returns {Completion}
 */
function evalIdentifier(node, env) {
  const owner = env.resolve(node.name);
  if (owner === null) return fail(node, `undefined variable '${node.name}'`);
  return owner.vars.get(node.name);
}

/**
 * @param {LetStatement} node
 * @param {Env} env
 * @returns {Generator<Step, Completion, void>}
 */
function* evalLet(node, env) {
  const name = node.name.name;
  if (env.hasOwn(name)) return fail(node.name, `'${name}' is already declared in this scope`);
  const value = yield* evaluate(node.init, env);
  if (isSignal(value)) return value;
  env.define(name, value);
  return value;
}

/**
 * Assignment writes through to whichever scope owns the name and never
 * declares one. That is what makes a captured variable shared: the closure
 * and its defining scope are looking at the same `Map` entry.
 * @param {AssignmentExpression} node
 * @param {Env} env
 * @returns {Generator<Step, Completion, void>}
 */
function* evalAssignment(node, env) {
  const value = yield* evaluate(node.value, env);
  if (isSignal(value)) return value;
  const name = node.name.name;
  if (!env.assign(name, value)) return fail(node.name, `assignment to undeclared variable '${name}'`);
  return value;
}

/**
 * @param {IfStatement} node
 * @param {Env} env
 * @returns {Generator<Step, Completion, void>}
 */
function* evalIf(node, env) {
  const test = yield* evaluate(node.test, env);
  if (isSignal(test)) return test;
  if (isTruthy(test)) return yield* evaluate(node.consequent, env);
  if (node.alternate !== null) return yield* evaluate(node.alternate, env);
  return undefined;
}

/**
 * The loop is where two of the four signal kinds stop travelling: `break`
 * ends it, `continue` skips to the next test. `return` and `error` pass
 * straight through, because neither of them is the loop's business.
 * @param {WhileStatement} node
 * @param {Env} env
 * @returns {Generator<Step, Completion, void>}
 */
function* evalWhile(node, env) {
  for (;;) {
    const test = yield* evaluate(node.test, env);
    if (isSignal(test)) return test;
    if (!isTruthy(test)) return undefined;

    const result = yield* evaluate(node.body, env);
    if (isSignal(result)) {
      if (result.kind === 'break') return undefined;
      if (result.kind !== 'continue') return result;
    }
  }
}

/**
 * @param {ReturnStatement} node
 * @param {Env} env
 * @returns {Generator<Step, Completion, void>}
 */
function* evalReturn(node, env) {
  if (node.argument === null) return new Signal('return', node);
  const value = yield* evaluate(node.argument, env);
  if (isSignal(value)) return value;
  return new Signal('return', node, { value });
}

/**
 * @param {FnDeclaration} node
 * @param {Env} env
 * @returns {Completion}
 */
function evalFnDeclaration(node, env) {
  const name = node.name.name;
  if (env.hasOwn(name)) return fail(node.name, `'${name}' is already declared in this scope`);
  /** @type {FnValue} */
  const fn = { type: 'function', name, params: node.params, body: node.body, env };
  // Bound in the same env it captured, so a function can call itself.
  env.define(name, fn);
  return fn;
}

/**
 * `callee.env.child()` is the whole of lexical scope in one line: the call's
 * scope hangs off the env the function was defined in, never off the caller's.
 * Two closures built by the same factory get two different parents, so their
 * captured variables never meet.
 * @param {CallExpression} node
 * @param {Env} env
 * @returns {Generator<Step, Completion, void>}
 */
function* evalCall(node, env) {
  const callee = yield* evaluate(node.callee, env);
  if (isSignal(callee)) return callee;

  /** @type {Value[]} */
  const args = [];
  for (const arg of node.args) {
    const value = yield* evaluate(arg, env);
    if (isSignal(value)) return value;
    args.push(value);
  }

  if (!isCallable(callee)) return fail(node, `${describe(callee)} is not a function`);
  const arity = arityOf(callee);
  if (args.length !== arity) return fail(node, arityMessage(callee, args.length));

  // A builtin runs as a single step. There is no Pip body underneath it, so
  // the CallExpression's own enter/exit pair is the whole of the call.
  if (callee.type === 'native') return callee.call(args);

  // A compiled closure has a chunk where this evaluator wants an AST body.
  // Nothing hands one over in practice, since the two backends never share a
  // heap, but saying so beats a `TypeError` from deep inside if that changes.
  if (callee.type === 'closure') return fail(node, `${callee.name} is compiled and can only be called by the VM`);

  const frame = callee.env.child();
  for (let i = 0; i < arity; i++) frame.define(callee.params[i].name, args[i]);

  const result = yield* evaluate(callee.body, frame);
  if (!isSignal(result)) return undefined;
  if (result.kind === 'return') return result.value;
  return escaped(result);
}

/**
 * @param {UnaryExpression} node
 * @param {Env} env
 * @returns {Generator<Step, Completion, void>}
 */
function* evalUnary(node, env) {
  const argument = yield* evaluate(node.argument, env);
  if (isSignal(argument)) return argument;
  const result = applyUnary(node.operator, argument);
  return result.ok ? result.value : fail(node, result.message);
}

/**
 * `&&` and `||` short-circuit: the right operand is only ever visited (and
 * so only ever yields its enter/exit steps) when it's actually needed.
 * @param {BinaryExpression} node
 * @param {Env} env
 * @returns {Generator<Step, Completion, void>}
 */
function* evalBinary(node, env) {
  const { operator } = node;

  if (operator === '&&') {
    const left = yield* evaluate(node.left, env);
    if (isSignal(left)) return left;
    if (!isTruthy(left)) return left;
    return yield* evaluate(node.right, env);
  }
  if (operator === '||') {
    const left = yield* evaluate(node.left, env);
    if (isSignal(left)) return left;
    if (isTruthy(left)) return left;
    return yield* evaluate(node.right, env);
  }

  const left = yield* evaluate(node.left, env);
  if (isSignal(left)) return left;
  const right = yield* evaluate(node.right, env);
  if (isSignal(right)) return right;
  const result = applyBinary(operator, left, right);
  return result.ok ? result.value : fail(node, result.message);
}

/**
 * Drain the iterator for non-debug use: run to completion and return the
 * final value, discarding every intermediate step. This is the boundary
 * where the sentinel stops being data and becomes a JS exception: inside
 * the evaluator an error is a value that propagates, outside it is a throw.
 * @param {Node} node
 * @param {Env} [env]
 * @returns {Value}
 */
export function run(node, env = new Env()) {
  // Before anything executes, and identically to the VM: a misplaced `break`
  // is a mistake whether or not control happens to reach it.
  validate(node);
  const iter = evaluate(node, env);
  /** @type {IteratorResult<Step, Completion>} */
  let step = iter.next();
  while (!step.done) {
    step = iter.next();
  }
  const result = step.value;
  if (!isSignal(result)) return result;
  const error = escaped(result);
  throw new EvalError(error.message, error.node);
}
