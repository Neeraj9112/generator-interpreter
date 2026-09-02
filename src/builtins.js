// @ts-check
import { Env } from './env.js';
import { format } from './values.js';

// Re-exported because `print` and the output pane are its only callers, and
// both reach for it here rather than through the value module.
export { format };

/** @typedef {import('./values.js').Value} Value */
/** @typedef {import('./values.js').NativeFn} NativeFn */

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
 * builtin pointed at different sinks. The interpreter shouldn't know which
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
