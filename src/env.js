// @ts-check

/** @typedef {import('./values.js').Value} Value */

/**
 * A scope: its own bindings, plus a link to the scope enclosing it. A linked
 * list rather than one flattened object, because that is what lexical scope
 * actually is: lookup walks outward, so an inner `let` shadows an outer one
 * for exactly as long as the inner scope is alive, and holding the head of a
 * chain keeps every scope above it reachable. That last part is the whole
 * mechanism behind closures.
 */
export class Env {
  /** @param {Env|null} [parent] */
  constructor(parent = null) {
    /** @type {Map<string, Value>} */
    this.vars = new Map();
    this.parent = parent;
  }

  /**
   * A new scope enclosed by this one. Blocks and calls both push one.
   * @returns {Env}
   */
  child() {
    return new Env(this);
  }

  /**
   * The env that owns `name`, or `null` if nothing in the chain binds it.
   * Reads and writes both go through this, which is what makes a captured
   * variable shared with its defining scope rather than copied out of it.
   * @param {string} name
   * @returns {Env|null}
   */
  resolve(name) {
    /** @type {Env|null} */
    let env = this;
    while (env !== null) {
      if (env.vars.has(name)) return env;
      env = env.parent;
    }
    return null;
  }

  /**
   * Bindings of this scope alone, ignoring the chain. Shadowing an outer name
   * is legal, rebinding one already declared here is not.
   * @param {string} name
   * @returns {boolean}
   */
  hasOwn(name) {
    return this.vars.has(name);
  }

  /**
   * Bind `name` in this scope, shadowing any outer binding of it.
   * @param {string} name
   * @param {Value} value
   */
  define(name, value) {
    this.vars.set(name, value);
  }

  /**
   * Take a binding back out of this scope. No Pip program can reach this (the
   * language has no way to unbind a name), and nothing but stepping
   * backwards has any business calling it: undoing a declaration means the
   * scope has to stop knowing the name, not merely forget its value.
   * @param {string} name
   */
  undefine(name) {
    this.vars.delete(name);
  }

  /**
   * Read a name from wherever the chain binds it. The caller has to have
   * checked `resolve` first, because an unbound name and one bound to nothing are
   * both `undefined` here, and only the evaluator can tell them apart.
   * @param {string} name
   * @returns {Value}
   */
  get(name) {
    const owner = this.resolve(name);
    return owner === null ? undefined : owner.vars.get(name);
  }

  /**
   * Write to an existing binding wherever the chain holds it. Returns false
   * if no scope binds `name`; assignment never creates one.
   * @param {string} name
   * @param {Value} value
   * @returns {boolean}
   */
  assign(name, value) {
    const owner = this.resolve(name);
    if (owner === null) return false;
    owner.vars.set(name, value);
    return true;
  }
}
