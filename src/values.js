// @ts-check

/** @typedef {import('./parser.js').Identifier} Identifier */
/** @typedef {import('./parser.js').Block} Block */
/** @typedef {import('./env.js').Env} Env */
/** @typedef {import('./compile.js').Chunk} Chunk */

/**
 * A function the tree-walker calls: parameters, an AST body, and — the part
 * that matters — the env it was *defined* in. Holding that reference is what
 * a closure is.
 * @typedef {{type: 'function', name: string, params: Identifier[], body: Block, env: Env}} FnValue
 */

/**
 * The same idea for the VM: a compiled chunk instead of an AST body. The env
 * field is identical, which is why closures behave the same on both backends
 * without either one knowing the other exists.
 * @typedef {{type: 'closure', name: string, proto: Chunk, env: Env}} Closure
 */

/**
 * A function the interpreter doesn't evaluate: `call` is plain JS, so it runs
 * to completion inside one step rather than yielding its way through a body.
 * There is nothing to step into, which is the right shape for a builtin —
 * `print` has no Pip source to show a debugger.
 * @typedef {{type: 'native', name: string, arity: number, call: (args: Value[]) => Value}} NativeFn
 */

/** @typedef {FnValue|Closure|NativeFn} Callable */

/**
 * Numbers, strings, booleans and functions. `undefined` is what a function
 * that never returns produces, and what an empty program evaluates to; the
 * language has no literal for it.
 * @typedef {number|string|boolean|undefined|Callable} Value
 */

/**
 * What an operation produces: a value, or the message explaining why there
 * isn't one. Deliberately neither a throw nor a `Signal` — this module sits
 * below both backends and knows about neither, so each one wraps a failure
 * in whatever its own unwinding mechanism is.
 * @typedef {{ok: true, value: Value}|{ok: false, message: string}} OpResult
 */

/**
 * @param {Value} value
 * @returns {OpResult}
 */
function ok(value) {
  return { ok: true, value };
}

/**
 * @param {string} message
 * @returns {OpResult}
 */
function err(message) {
  return { ok: false, message };
}

/**
 * Falsy is exactly `false`, `0`, `""` and nothing — every other value,
 * including every nonzero number, every non-empty string and every function,
 * is truthy.
 * @param {Value} value
 * @returns {boolean}
 */
export function isTruthy(value) {
  return value !== false && value !== 0 && value !== '' && value !== undefined;
}

/**
 * Every kind of function is an object, and nothing else in the language is,
 * so one check serves calling and `describe` alike.
 * @param {Value} value
 * @returns {value is Callable}
 */
export function isCallable(value) {
  return typeof value === 'object' && value !== null;
}

/**
 * How many arguments a callable takes, whichever of the three shapes it is.
 * @param {Callable} callable
 * @returns {number}
 */
export function arityOf(callable) {
  if (callable.type === 'native') return callable.arity;
  if (callable.type === 'closure') return callable.proto.params.length;
  return callable.params.length;
}

/**
 * @param {Callable} callable
 * @param {number} got
 * @returns {string}
 */
export function arityMessage(callable, got) {
  const arity = arityOf(callable);
  return `${callable.name} expects ${arity} ${arity === 1 ? 'argument' : 'arguments'}, got ${got}`;
}

/**
 * How a value reads in an error message, where telling a string from a name
 * matters. `format` makes the opposite trade.
 * @param {Value} value
 * @returns {string}
 */
export function describe(value) {
  if (value === undefined) return 'nothing';
  if (typeof value === 'string') return `string ${JSON.stringify(value)}`;
  if (isCallable(value)) return `function ${value.name}`;
  return `${typeof value} ${value}`;
}

/**
 * How a value looks when the program itself chooses to show it. Strings come
 * out bare, because `print("hi")` meaning `hi` is the whole point; the quoted
 * form belongs in error messages.
 * @param {Value} value
 * @returns {string}
 */
export function format(value) {
  if (value === undefined) return 'nothing';
  if (isCallable(value)) return `<fn ${value.name}>`;
  return String(value);
}

/**
 * @param {'-'|'!'} operator
 * @param {Value} operand
 * @returns {OpResult}
 */
export function applyUnary(operator, operand) {
  if (operator === '!') return ok(!isTruthy(operand));
  if (typeof operand !== 'number') return err(`unary '-' expects a number, got ${describe(operand)}`);
  return ok(-operand);
}

/**
 * Every binary operator except `&&` and `||`, which short-circuit and so
 * never hold both operands at once — those two are control flow, and each
 * backend expresses control flow in its own terms.
 * @param {string} operator
 * @param {Value} left
 * @param {Value} right
 * @returns {OpResult}
 */
export function applyBinary(operator, left, right) {
  switch (operator) {
    case '+':
      return add(left, right);
    case '-':
    case '*':
    case '/':
    case '%':
      return arithmetic(operator, left, right);
    case '==':
      return ok(left === right);
    case '!=':
      return ok(left !== right);
    case '<':
    case '<=':
    case '>':
    case '>=':
      return compare(operator, left, right);
    default:
      return err(`unknown operator '${operator}'`);
  }
}

/**
 * The one overloaded operator: concatenation if either side is a string,
 * addition otherwise. Only numbers, strings and booleans splice into a
 * string — a function or nothing on either side is an error rather than an
 * "[object Object]" nobody asked for.
 * @param {Value} left
 * @param {Value} right
 * @returns {OpResult}
 */
function add(left, right) {
  if (typeof left === 'string' || typeof right === 'string') {
    if (isPrintable(left) && isPrintable(right)) return ok(`${left}${right}`);
    return err(`'+' cannot concatenate ${describe(left)} and ${describe(right)}`);
  }
  if (typeof left !== 'number' || typeof right !== 'number') {
    return err(`'+' expects two numbers or a string, got ${describe(left)} and ${describe(right)}`);
  }
  return ok(left + right);
}

/**
 * @param {string} operator
 * @param {Value} left
 * @param {Value} right
 * @returns {OpResult}
 */
function arithmetic(operator, left, right) {
  if (typeof left !== 'number' || typeof right !== 'number') {
    return err(`'${operator}' expects two numbers, got ${describe(left)} and ${describe(right)}`);
  }
  switch (operator) {
    case '-': return ok(left - right);
    case '*': return ok(left * right);
    case '/': return ok(left / right);
    case '%': return ok(left % right);
    default: return err(`unknown operator '${operator}'`);
  }
}

/**
 * Numbers order by value, strings by UTF-16 code unit. No coercion: mixing
 * the two, or ordering a boolean, is a type error rather than a guess.
 * @param {string} operator
 * @param {Value} left
 * @param {Value} right
 * @returns {OpResult}
 */
function compare(operator, left, right) {
  if (typeof left === 'number' && typeof right === 'number') return ok(orderNumbers(operator, left, right));
  if (typeof left === 'string' && typeof right === 'string') return ok(orderStrings(operator, left, right));
  return err(`'${operator}' expects two numbers or two strings, got ${describe(left)} and ${describe(right)}`);
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
 * Values `+` will splice into a string.
 * @param {Value} value
 * @returns {value is number|string|boolean}
 */
function isPrintable(value) {
  return typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean';
}
