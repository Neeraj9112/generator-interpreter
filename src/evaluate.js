// @ts-check

/** @typedef {import('./parser.js').Program} Program */
/** @typedef {import('./parser.js').Statement} Statement */
/** @typedef {import('./parser.js').Expression} Expression */
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
    default:
      throw new EvalError(`evaluate: no rule for node type '${node.type}'`, node);
  }
}
