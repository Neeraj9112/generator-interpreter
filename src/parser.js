// @ts-check
import { tokenize, lineCol } from './lexer.js';

/** @typedef {import('./lexer.js').Token} Token */
/** @typedef {import('./lexer.js').TokenType} TokenType */

/** @typedef {{start: number, end: number}} Span */

/** @typedef {NumberLiteral|StringLiteral|BooleanLiteral|Identifier|UnaryExpression|BinaryExpression|AssignmentExpression|CallExpression} Expression */
/** @typedef {LetStatement|IfStatement|WhileStatement|BreakStatement|ContinueStatement|ReturnStatement|FnDeclaration|Block|ExpressionStatement} Statement */

/** @typedef {{type: 'NumberLiteral', value: number, span: Span}} NumberLiteral */
/** @typedef {{type: 'StringLiteral', value: string, span: Span}} StringLiteral */
/** @typedef {{type: 'BooleanLiteral', value: boolean, span: Span}} BooleanLiteral */
/** @typedef {{type: 'Identifier', name: string, span: Span}} Identifier */
/** @typedef {{type: 'UnaryExpression', operator: '-'|'!', argument: Expression, span: Span}} UnaryExpression */
/** @typedef {{type: 'BinaryExpression', operator: string, left: Expression, right: Expression, span: Span}} BinaryExpression */
/** @typedef {{type: 'AssignmentExpression', name: Identifier, value: Expression, span: Span}} AssignmentExpression */
/** @typedef {{type: 'CallExpression', callee: Expression, args: Expression[], span: Span}} CallExpression */

/** @typedef {{type: 'LetStatement', name: Identifier, init: Expression, span: Span}} LetStatement */
/** @typedef {{type: 'IfStatement', test: Expression, consequent: Block, alternate: Block|IfStatement|null, span: Span}} IfStatement */
/** @typedef {{type: 'WhileStatement', test: Expression, body: Block, span: Span}} WhileStatement */
/** @typedef {{type: 'BreakStatement', span: Span}} BreakStatement */
/** @typedef {{type: 'ContinueStatement', span: Span}} ContinueStatement */
/** @typedef {{type: 'ReturnStatement', argument: Expression|null, span: Span}} ReturnStatement */
/** @typedef {{type: 'FnDeclaration', name: Identifier, params: Identifier[], body: Block, span: Span}} FnDeclaration */
/** @typedef {{type: 'Block', body: Statement[], span: Span}} Block */
/** @typedef {{type: 'ExpressionStatement', expression: Expression, span: Span}} ExpressionStatement */
/** @typedef {{type: 'Program', body: Statement[], span: Span}} Program */

export class ParseError extends Error {
  /**
   * @param {string} message
   * @param {number} index
   * @param {string} source
   */
  constructor(message, index, source) {
    const { line, col } = lineCol(source, index);
    super(`${message} (line ${line}, col ${col})`);
    this.name = 'ParseError';
    this.index = index;
    this.line = line;
    this.col = col;
  }
}

// Binding powers. Left/right pairs; a higher right-bp than left-bp on the
// same operator makes it right-associative (only assignment is).
/** @type {Record<string, number>} */
const LBP = {
  EQ: 1,
  OR: 2,
  AND: 3,
  EQEQ: 4, BANGEQ: 4,
  LT: 5, LTEQ: 5, GT: 5, GTEQ: 5,
  PLUS: 6, MINUS: 6,
  STAR: 7, SLASH: 7, PERCENT: 7,
  LPAREN: 9,
};

/** @type {Record<string, string>} */
const BINARY_OP_TEXT = {
  OR: '||', AND: '&&',
  EQEQ: '==', BANGEQ: '!=',
  LT: '<', LTEQ: '<=', GT: '>', GTEQ: '>=',
  PLUS: '+', MINUS: '-',
  STAR: '*', SLASH: '/', PERCENT: '%',
};

class Parser {
  /** @param {string} source */
  constructor(source) {
    this.source = source;
    this.tokens = tokenize(source);
    this.pos = 0;
  }

  /** @returns {Token} */
  peek() {
    return this.tokens[this.pos];
  }

  /** @returns {Token} */
  advance() {
    const tok = this.tokens[this.pos];
    if (tok.type !== 'EOF') this.pos++;
    return tok;
  }

  /** @param {TokenType} type */
  check(type) {
    return this.peek().type === type;
  }

  /**
   * @param {TokenType} type
   * @param {string} message
   * @returns {Token}
   */
  expect(type, message) {
    const tok = this.peek();
    if (tok.type !== type) {
      throw new ParseError(`${message}, got '${tok.type === 'EOF' ? 'end of input' : tok.value}'`, tok.start, this.source);
    }
    return this.advance();
  }

  /** Consume an optional statement-terminating semicolon. */
  skipSemi() {
    if (this.check('SEMI')) this.advance();
  }

  /** @returns {Program} */
  parseProgram() {
    /** @type {Statement[]} */
    const body = [];
    while (!this.check('EOF')) {
      body.push(this.parseStatement());
    }
    return { type: 'Program', body, span: { start: 0, end: this.source.length } };
  }

  /** @returns {Statement} */
  parseStatement() {
    switch (this.peek().type) {
      case 'LET': return this.parseLetStatement();
      case 'IF': return this.parseIfStatement();
      case 'WHILE': return this.parseWhileStatement();
      case 'BREAK': {
        const tok = this.advance();
        this.skipSemi();
        return { type: 'BreakStatement', span: { start: tok.start, end: tok.end } };
      }
      case 'CONTINUE': {
        const tok = this.advance();
        this.skipSemi();
        return { type: 'ContinueStatement', span: { start: tok.start, end: tok.end } };
      }
      case 'RETURN': return this.parseReturnStatement();
      case 'FN': return this.parseFnDeclaration();
      case 'LBRACE': return this.parseBlock();
      default: return this.parseExpressionStatement();
    }
  }

  /** @returns {LetStatement} */
  parseLetStatement() {
    const start = this.advance().start; // 'let'
    const name = this.parseIdentifier();
    this.expect('EQ', "expected '=' after let binding name");
    const init = this.parseExpression(0);
    const end = init.span.end;
    this.skipSemi();
    return { type: 'LetStatement', name, init, span: { start, end } };
  }

  /** @returns {IfStatement} */
  parseIfStatement() {
    const start = this.advance().start; // 'if'
    this.expect('LPAREN', "expected '(' after if");
    const test = this.parseExpression(0);
    this.expect('RPAREN', "expected ')' after if condition");
    const consequent = this.parseBlock();
    /** @type {Block|IfStatement|null} */
    let alternate = null;
    let end = consequent.span.end;
    if (this.check('ELSE')) {
      this.advance();
      alternate = this.check('IF') ? this.parseIfStatement() : this.parseBlock();
      end = alternate.span.end;
    }
    return { type: 'IfStatement', test, consequent, alternate, span: { start, end } };
  }

  /** @returns {WhileStatement} */
  parseWhileStatement() {
    const start = this.advance().start; // 'while'
    this.expect('LPAREN', "expected '(' after while");
    const test = this.parseExpression(0);
    this.expect('RPAREN', "expected ')' after while condition");
    const body = this.parseBlock();
    return { type: 'WhileStatement', test, body, span: { start, end: body.span.end } };
  }

  /** @returns {ReturnStatement} */
  parseReturnStatement() {
    const start = this.advance().start; // 'return'
    /** @type {Expression|null} */
    let argument = null;
    let end = start + 6;
    if (!this.check('SEMI') && !this.check('RBRACE') && !this.check('EOF')) {
      argument = this.parseExpression(0);
      end = argument.span.end;
    }
    this.skipSemi();
    return { type: 'ReturnStatement', argument, span: { start, end } };
  }

  /** @returns {FnDeclaration} */
  parseFnDeclaration() {
    const start = this.advance().start; // 'fn'
    const name = this.parseIdentifier();
    this.expect('LPAREN', "expected '(' after function name");
    /** @type {Identifier[]} */
    const params = [];
    if (!this.check('RPAREN')) {
      params.push(this.parseIdentifier());
      while (this.check('COMMA')) {
        this.advance();
        params.push(this.parseIdentifier());
      }
    }
    this.expect('RPAREN', "expected ')' after parameters");
    const body = this.parseBlock();
    return { type: 'FnDeclaration', name, params, body, span: { start, end: body.span.end } };
  }

  /** @returns {Block} */
  parseBlock() {
    const start = this.expect('LBRACE', "expected '{'").start;
    /** @type {Statement[]} */
    const body = [];
    while (!this.check('RBRACE') && !this.check('EOF')) {
      body.push(this.parseStatement());
    }
    const end = this.expect('RBRACE', "expected '}'").end;
    return { type: 'Block', body, span: { start, end } };
  }

  /** @returns {ExpressionStatement} */
  parseExpressionStatement() {
    const expr = this.parseExpression(0);
    this.skipSemi();
    return { type: 'ExpressionStatement', expression: expr, span: expr.span };
  }

  /** @returns {Identifier} */
  parseIdentifier() {
    const tok = this.expect('IDENT', 'expected identifier');
    return { type: 'Identifier', name: tok.value, span: { start: tok.start, end: tok.end } };
  }

  /**
   * Pratt expression parser: minBp is the minimum binding power an
   * infix/postfix operator must have to keep extending the left operand.
   * @param {number} minBp
   * @returns {Expression}
   */
  parseExpression(minBp) {
    let left = this.parseNud();

    for (;;) {
      const tok = this.peek();
      const lbp = LBP[tok.type];
      if (lbp === undefined || lbp <= minBp) break;

      if (tok.type === 'EQ') {
        this.advance();
        if (left.type !== 'Identifier') {
          throw new ParseError('invalid assignment target', left.span.start, this.source);
        }
        const value = this.parseExpression(lbp - 1); // right-associative
        left = { type: 'AssignmentExpression', name: left, value, span: { start: left.span.start, end: value.span.end } };
        continue;
      }

      if (tok.type === 'LPAREN') {
        left = this.parseCall(left);
        continue;
      }

      this.advance();
      const operator = BINARY_OP_TEXT[tok.type];
      const right = this.parseExpression(lbp);
      left = { type: 'BinaryExpression', operator, left, right, span: { start: left.span.start, end: right.span.end } };
    }

    return left;
  }

  /**
   * @param {Expression} callee
   * @returns {CallExpression}
   */
  parseCall(callee) {
    this.advance(); // '('
    /** @type {Expression[]} */
    const args = [];
    if (!this.check('RPAREN')) {
      args.push(this.parseExpression(0));
      while (this.check('COMMA')) {
        this.advance();
        args.push(this.parseExpression(0));
      }
    }
    const end = this.expect('RPAREN', "expected ')' after arguments").end;
    return { type: 'CallExpression', callee, args, span: { start: callee.span.start, end } };
  }

  /** Prefix position: literals, identifiers, unary ops, grouping. @returns {Expression} */
  parseNud() {
    const tok = this.peek();

    switch (tok.type) {
      case 'NUMBER': {
        this.advance();
        return { type: 'NumberLiteral', value: Number(tok.value), span: { start: tok.start, end: tok.end } };
      }
      case 'STRING': {
        this.advance();
        return { type: 'StringLiteral', value: tok.value, span: { start: tok.start, end: tok.end } };
      }
      case 'TRUE': {
        this.advance();
        return { type: 'BooleanLiteral', value: true, span: { start: tok.start, end: tok.end } };
      }
      case 'FALSE': {
        this.advance();
        return { type: 'BooleanLiteral', value: false, span: { start: tok.start, end: tok.end } };
      }
      case 'IDENT': {
        this.advance();
        return { type: 'Identifier', name: tok.value, span: { start: tok.start, end: tok.end } };
      }
      case 'MINUS':
      case 'BANG': {
        this.advance();
        const argument = this.parseExpression(8); // binds tighter than any binary op
        return { type: 'UnaryExpression', operator: tok.type === 'MINUS' ? '-' : '!', argument, span: { start: tok.start, end: argument.span.end } };
      }
      case 'LPAREN': {
        this.advance();
        const expr = this.parseExpression(0);
        this.expect('RPAREN', "expected ')'");
        return expr;
      }
      default:
        throw new ParseError(`unexpected token '${tok.type === 'EOF' ? 'end of input' : tok.value}'`, tok.start, this.source);
    }
  }
}

/**
 * @param {string} source
 * @returns {Program}
 */
export function parse(source) {
  return new Parser(source).parseProgram();
}
