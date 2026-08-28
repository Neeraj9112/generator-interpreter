// @ts-check

/** @typedef {import('./parser.js').Span} Span */
/** @typedef {import('./parser.js').Program} Program */
/** @typedef {import('./parser.js').Statement} Statement */
/** @typedef {import('./parser.js').Block} Block */
/** @typedef {import('./parser.js').FnDeclaration} FnDeclaration */
/** @typedef {import('./evaluate.js').Node} Node */

/**
 * A program that parses but doesn't mean anything: `break` with no loop
 * around it, a name declared twice in one scope. Neither is a syntax error —
 * the parser is right to accept them — and neither depends on what any value
 * turns out to be, so both can be settled before the program runs.
 */
export class SemanticError extends Error {
  /**
   * @param {string} message
   * @param {Span} span
   */
  constructor(message, span) {
    super(message);
    this.name = 'SemanticError';
    this.span = span;
  }
}

/**
 * Walks the tree looking only for the things that are wrong regardless of
 * what runs.
 *
 * This exists because the two backends would otherwise disagree about *when*
 * these are errors. `break` compiles to a jump, so the compiler has to know
 * which loop it leaves before the program starts — it cannot defer. The
 * tree-walker can, and used to: it raised `break` outside a loop only if
 * execution reached it, which made `if (false) { break }` legal on one
 * backend and rejected on the other. Checking up front for both settles it
 * in the stricter direction, which is what every language with a compiler
 * does, and leaves the corpus comparing the two with no asterisk on it.
 */
class Validator {
  constructor() {
    /**
     * Names bound per scope, innermost last. Declarations only — reads stay
     * dynamic, resolved against the live env chain while the program runs.
     * @type {Set<string>[]}
     */
    this.scopes = [new Set()];
    /** Loops enclosing the node being visited. @type {number} */
    this.loopDepth = 0;
    this.inFunction = false;
  }

  /**
   * @param {string} name
   * @param {Span} span
   */
  declare(name, span) {
    const scope = this.scopes[this.scopes.length - 1];
    if (scope.has(name)) throw new SemanticError(`'${name}' is already declared in this scope`, span);
    scope.add(name);
  }

  /** @param {Statement[]} body */
  statements(body) {
    for (const statement of body) this.statement(statement);
  }

  /** @param {Block} node */
  block(node) {
    this.scopes.push(new Set());
    this.statements(node.body);
    this.scopes.pop();
  }

  /** @param {Statement} node */
  statement(node) {
    switch (node.type) {
      case 'LetStatement':
        this.declare(node.name.name, node.name.span);
        return;
      case 'Block':
        this.block(node);
        return;
      case 'IfStatement':
        this.block(node.consequent);
        if (node.alternate === null) return;
        if (node.alternate.type === 'Block') this.block(node.alternate);
        else this.statement(node.alternate);
        return;
      case 'WhileStatement':
        this.loopDepth++;
        this.block(node.body);
        this.loopDepth--;
        return;
      case 'BreakStatement':
      case 'ContinueStatement': {
        if (this.loopDepth > 0) return;
        const kind = node.type === 'BreakStatement' ? 'break' : 'continue';
        throw new SemanticError(`'${kind}' outside of a loop`, node.span);
      }
      case 'ReturnStatement':
        if (!this.inFunction) throw new SemanticError("'return' outside of a function", node.span);
        return;
      case 'FnDeclaration':
        this.fnDeclaration(node);
        return;
      default:
        // An expression statement. Pip has no function expressions, so no
        // statement can be nested inside one and there is nothing in there
        // that this pass cares about.
        return;
    }
  }

  /**
   * A function body is its own world. The loop count resets to zero, because
   * a loop *around the declaration* does not enclose the body — nothing in
   * `while (x) { fn f() { break } }` says which iteration that `break` would
   * be leaving, and the tree-walker already treated it as an escape. The
   * scope stack resets to the parameters for the same reason: the body can
   * shadow anything outside it freely.
   * @param {FnDeclaration} node
   */
  fnDeclaration(node) {
    this.declare(node.name.name, node.name.span);

    const outerScopes = this.scopes;
    const outerLoopDepth = this.loopDepth;
    const outerInFunction = this.inFunction;

    this.scopes = [new Set(node.params.map((param) => param.name))];
    this.loopDepth = 0;
    this.inFunction = true;
    this.block(node.body);

    this.scopes = outerScopes;
    this.loopDepth = outerLoopDepth;
    this.inFunction = outerInFunction;
  }
}

/**
 * Check a program before running it. Throws `SemanticError` on the first
 * problem; returns nothing when there is none.
 *
 * Both backends call this, which is what makes them agree: whatever it
 * rejects is rejected identically, and whatever it lets through is left to
 * run-time on both.
 * @param {Node} node
 */
export function validate(node) {
  const validator = new Validator();
  if (node.type === 'Program') validator.statements(node.body);
  else if (isStatement(node)) validator.statement(node);
}

/**
 * @param {Node} node
 * @returns {node is Statement}
 */
function isStatement(node) {
  switch (node.type) {
    case 'LetStatement':
    case 'IfStatement':
    case 'WhileStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
    case 'ReturnStatement':
    case 'FnDeclaration':
    case 'Block':
    case 'ExpressionStatement':
      return true;
    default:
      return false;
  }
}
