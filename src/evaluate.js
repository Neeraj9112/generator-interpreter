// @ts-check

/** @typedef {import('./parser.js').Program} Program */
/** @typedef {import('./parser.js').Statement} Statement */
/** @typedef {import('./parser.js').Expression} Expression */
/** @typedef {import('./parser.js').BinaryExpression} BinaryExpression */
/** @typedef {import('./parser.js').UnaryExpression} UnaryExpression */
/** @typedef {Program|Statement|Expression} Node */

/**
 * Phase 2 covers literals and operators only — numbers, strings and
 * booleans. `undefined` is the result of evaluating an empty program.
 * @typedef {number|string|boolean|undefined} Value
 */

/**
 * One pause point per node: an 'enter' step before it evaluates, an 'exit'
 * step after. Each carries the live `env` reference rather than a snapshot,
 * so a driver renders scope as it stands at that instant.
 * @typedef {{node: Node, env: unknown, phase: 'enter'}} EnterStep
 * @typedef {{node: Node, env: unknown, phase: 'exit', value: Value}} ExitStep
 * @typedef {EnterStep|ExitStep} Step
 */

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
 * Falsy is exactly `false`, `0` and `""` — every other value, including
 * every nonzero number and every non-empty string, is truthy.
 * @param {Value} value
 * @returns {boolean}
 */
export function isTruthy(value) {
  return value !== false && value !== 0 && value !== '';
}

/**
 * Evaluate `node` in `env`, recursing with `yield*` so a driver stepping
 * the outer iterator can pause at any depth of the tree — no plain
 * recursive call ever runs a subtree to completion in one go.
 * @param {Node} node
 * @param {unknown} env
 * @returns {Generator<Step, Value, void>}
 */
export function* evaluate(node, env) {
  yield { node, env, phase: 'enter' };
  const value = yield* evalNode(node, env);
  yield { node, env, phase: 'exit', value };
  return value;
}

/**
 * @param {Node} node
 * @param {unknown} env
 * @returns {Generator<Step, Value, void>}
 */
function* evalNode(node, env) {
  switch (node.type) {
    case 'Program': {
      /** @type {Value} */
      let value;
      for (const stmt of node.body) value = yield* evaluate(stmt, env);
      return value;
    }
    case 'ExpressionStatement':
      return yield* evaluate(node.expression, env);
    case 'NumberLiteral':
    case 'StringLiteral':
    case 'BooleanLiteral':
      return node.value;
    case 'UnaryExpression':
      return yield* evalUnary(node, env);
    case 'BinaryExpression':
      return yield* evalBinary(node, env);
    default:
      throw new EvalError(`evaluate: no rule for node type '${node.type}'`, node);
  }
}

/**
 * @param {UnaryExpression} node
 * @param {unknown} env
 * @returns {Generator<Step, Value, void>}
 */
function* evalUnary(node, env) {
  const argument = yield* evaluate(node.argument, env);
  if (node.operator === '!') return !isTruthy(argument);
  if (typeof argument !== 'number') {
    throw new EvalError(`unary '-' expects a number, got ${describe(argument)}`, node);
  }
  return -argument;
}

/**
 * `&&` and `||` short-circuit: the right operand is only ever visited (and
 * so only ever yields its enter/exit steps) when it's actually needed.
 * @param {BinaryExpression} node
 * @param {unknown} env
 * @returns {Generator<Step, Value, void>}
 */
function* evalBinary(node, env) {
  const { operator } = node;

  if (operator === '&&') {
    const left = yield* evaluate(node.left, env);
    if (!isTruthy(left)) return left;
    return yield* evaluate(node.right, env);
  }
  if (operator === '||') {
    const left = yield* evaluate(node.left, env);
    if (isTruthy(left)) return left;
    return yield* evaluate(node.right, env);
  }

  const left = yield* evaluate(node.left, env);
  const right = yield* evaluate(node.right, env);
  return applyBinary(operator, left, right, node);
}

/**
 * @param {string} operator
 * @param {Value} left
 * @param {Value} right
 * @param {BinaryExpression} node
 * @returns {Value}
 */
function applyBinary(operator, left, right, node) {
  switch (operator) {
    case '+':
      if (typeof left === 'string' || typeof right === 'string') return `${left}${right}`;
      return numeric(left, node) + numeric(right, node);
    case '-':
      return numeric(left, node) - numeric(right, node);
    case '*':
      return numeric(left, node) * numeric(right, node);
    case '/':
      return numeric(left, node) / numeric(right, node);
    case '%':
      return numeric(left, node) % numeric(right, node);
    case '==':
      return left === right;
    case '!=':
      return left !== right;
    case '<':
    case '<=':
    case '>':
    case '>=':
      return compare(operator, left, right, node);
    default:
      throw new EvalError(`evaluate: unknown operator '${operator}'`, node);
  }
}

/**
 * Numbers order by value, strings by UTF-16 code unit. No coercion: mixing
 * the two, or ordering a boolean, is a type error rather than a guess.
 * @param {string} operator
 * @param {Value} left
 * @param {Value} right
 * @param {BinaryExpression} node
 * @returns {boolean}
 */
function compare(operator, left, right, node) {
  if (typeof left === 'number' && typeof right === 'number') return orderNumbers(operator, left, right);
  if (typeof left === 'string' && typeof right === 'string') return orderStrings(operator, left, right);
  throw new EvalError(`'${operator}' expects two numbers or two strings, got ${describe(left)} and ${describe(right)}`, node);
}

/**
 * @param {string} operator
 * @param {number} left
 * @param {number} right
 * @returns {boolean}
 */
function orderNumbers(operator, left, right) {
  switch (operator) {
    case '<': return left < right;
    case '<=': return left <= right;
    case '>': return left > right;
    case '>=': return left >= right;
    default: throw new Error(`unreachable operator '${operator}'`);
  }
}

/**
 * @param {string} operator
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
function orderStrings(operator, left, right) {
  switch (operator) {
    case '<': return left < right;
    case '<=': return left <= right;
    case '>': return left > right;
    case '>=': return left >= right;
    default: throw new Error(`unreachable operator '${operator}'`);
  }
}

/**
 * @param {Value} value
 * @param {Node} node
 * @returns {number}
 */
function numeric(value, node) {
  if (typeof value !== 'number') {
    throw new EvalError(`expected a number, got ${describe(value)}`, node);
  }
  return value;
}

/**
 * @param {Value} value
 * @returns {string}
 */
function describe(value) {
  if (typeof value === 'string') return `string ${JSON.stringify(value)}`;
  return `${typeof value} ${value}`;
}
