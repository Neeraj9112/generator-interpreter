// @ts-check
import { Env } from './env.js';

/** @typedef {import('./evaluate.js').Value} Value */

/**
 * A function the interpreter doesn't evaluate: `call` is plain JS, so it
 * runs to completion inside one step rather than yielding its way through a
 * body. There is nothing to step into, which is the right shape for a
 * builtin — `print` has no Pip source to show a debugger.
 * @typedef {{type: 'native', name: string, arity: number, call: (args: Value[]) => Value}} NativeFn
 */

/**
 * How a value looks when the program itself chooses to show it. Strings come
 * out bare, because `print("hi")` meaning `hi` is the whole point; the quoted
 * form belongs in error messages, where telling a string from a name matters.
 * @param {Value} value
 * @returns {string}
 */
export function format(value) {
  if (value === undefined) return 'nothing';
  if (typeof value === 'object' && value !== null) return `<fn ${value.name}>`;
  return String(value);
}

/**
 * @param {string} name
 * @param {number} arity
 * @param {(args: Value[]) => Value} call
 * @returns {NativeFn}
 */
function native(name, arity, call) {
  return { type: 'native', name, arity, call };
}

/**
 * The root scope, holding every builtin. Evaluate a program in a *child* of
 * this rather than in this itself, so the program's own top-level bindings
 * stay in their own scope and an inspector can tell the two apart.
 *
 * `write` is a parameter because the output pane and a terminal are the same
 * builtin pointed at different sinks — the interpreter shouldn't know which
 * one it's talking to.
 * @param {{write?: (line: string) => void}} [io]
 * @returns {Env}
 */
export function globals(io = {}) {
  const write = io.write ?? ((/** @type {string} */ line) => console.log(line));
  const env = new Env();
  env.define('print', native('print', 1, (args) => {
    write(format(args[0]));
    return undefined;
  }));
  return env;
}
