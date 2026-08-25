// @ts-check

/**
 * @typedef {'NUMBER'|'STRING'|'IDENT'
 *   |'LET'|'IF'|'ELSE'|'WHILE'|'BREAK'|'CONTINUE'|'FN'|'RETURN'|'TRUE'|'FALSE'
 *   |'PLUS'|'MINUS'|'STAR'|'SLASH'|'PERCENT'
 *   |'EQ'|'EQEQ'|'BANG'|'BANGEQ'|'LT'|'LTEQ'|'GT'|'GTEQ'|'AND'|'OR'
 *   |'LPAREN'|'RPAREN'|'LBRACE'|'RBRACE'|'COMMA'|'SEMI'
 *   |'EOF'} TokenType
 */

/**
 * @typedef {Object} Token
 * @property {TokenType} type
 * @property {string} value
 * @property {number} start
 * @property {number} end
 */

/** @type {Record<string, TokenType>} */
const KEYWORDS = {
  let: 'LET',
  if: 'IF',
  else: 'ELSE',
  while: 'WHILE',
  break: 'BREAK',
  continue: 'CONTINUE',
  fn: 'FN',
  return: 'RETURN',
  true: 'TRUE',
  false: 'FALSE',
};

export class LexError extends Error {
  /**
   * @param {string} message
   * @param {number} index
   * @param {string} source
   */
  constructor(message, index, source) {
    const { line, col } = lineCol(source, index);
    super(`${message} (line ${line}, col ${col})`);
    this.name = 'LexError';
    this.index = index;
    this.line = line;
    this.col = col;
  }
}

/**
 * Compute 1-based line and column for a string index (UTF-16 code units).
 * @param {string} source
 * @param {number} index
 * @returns {{line: number, col: number}}
 */
export function lineCol(source, index) {
  let line = 1;
  let col = 1;
  const end = Math.min(index, source.length);
  for (let i = 0; i < end; i++) {
    if (source[i] === '\n') {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}

const isDigit = (/** @type {string} */ ch) => ch >= '0' && ch <= '9';
const isIdentStart = (/** @type {string} */ ch) =>
  (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
const isIdentPart = (/** @type {string} */ ch) => isIdentStart(ch) || isDigit(ch);

/**
 * @param {string} source
 * @returns {Token[]}
 */
export function tokenize(source) {
  /** @type {Token[]} */
  const tokens = [];
  let i = 0;
  const n = source.length;

  /** @param {TokenType} type @param {number} start @param {number} end */
  const push = (type, start, end) => {
    tokens.push({ type, value: source.slice(start, end), start, end });
  };

  while (i < n) {
    const ch = source[i];

    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++;
      continue;
    }

    if (ch === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }

    if (isDigit(ch)) {
      const start = i;
      while (i < n && isDigit(source[i])) i++;
      if (source[i] === '.' && isDigit(source[i + 1])) {
        i++;
        while (i < n && isDigit(source[i])) i++;
      }
      push('NUMBER', start, i);
      continue;
    }

    if (ch === '"') {
      const start = i;
      i++;
      let value = '';
      while (i < n && source[i] !== '"') {
        if (source[i] === '\\') {
          const esc = source[i + 1];
          switch (esc) {
            case 'n': value += '\n'; break;
            case 't': value += '\t'; break;
            case 'r': value += '\r'; break;
            case '\\': value += '\\'; break;
            case '"': value += '"'; break;
            default:
              throw new LexError(`unknown escape sequence '\\${esc}'`, i, source);
          }
          i += 2;
        } else {
          value += source[i];
          i++;
        }
      }
      if (i >= n) throw new LexError('unterminated string', start, source);
      i++; // closing quote
      tokens.push({ type: 'STRING', value, start, end: i });
      continue;
    }

    if (isIdentStart(ch)) {
      const start = i;
      while (i < n && isIdentPart(source[i])) i++;
      const text = source.slice(start, i);
      const keyword = KEYWORDS[text];
      push(keyword ?? 'IDENT', start, i);
      continue;
    }

    const two = source.slice(i, i + 2);
    if (two === '==' || two === '!=' || two === '<=' || two === '>=' || two === '&&' || two === '||') {
      const type = { '==': 'EQEQ', '!=': 'BANGEQ', '<=': 'LTEQ', '>=': 'GTEQ', '&&': 'AND', '||': 'OR' }[two];
      push(/** @type {TokenType} */ (type), i, i + 2);
      i += 2;
      continue;
    }

    /** @type {Record<string, TokenType>} */
    const single = {
      '+': 'PLUS', '-': 'MINUS', '*': 'STAR', '/': 'SLASH', '%': 'PERCENT',
      '=': 'EQ', '!': 'BANG', '<': 'LT', '>': 'GT',
      '(': 'LPAREN', ')': 'RPAREN', '{': 'LBRACE', '}': 'RBRACE',
      ',': 'COMMA', ';': 'SEMI',
    };
    const type = single[ch];
    if (type) {
      push(type, i, i + 1);
      i++;
      continue;
    }

    throw new LexError(`unexpected character '${ch}'`, i, source);
  }

  tokens.push({ type: 'EOF', value: '', start: n, end: n });
  return tokens;
}
