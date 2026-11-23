/**
 * Safe arithmetic evaluation.
 *
 * The expression is parsed with a hand-written tokenizer and recursive-descent
 * parser, so no `eval`, `new Function`, or third-party parser is involved.
 * Only the grammar below is accepted:
 *
 *   expression  := additive
 *   additive    := multiplicative (('+' | '-') multiplicative)*
 *   multiplicative := unary (('*' | '/') unary)*
 *   unary       := ('+' | '-') unary | primary
 *   primary     := NUMBER | '(' additive ')'
 *
 * Results are returned as a JSON string such as {"result":60}.
 */

type TokenKind = 'number' | '+' | '-' | '*' | '/' | '(' | ')';

interface Token {
  readonly kind: TokenKind;
  /** Numeric value; set only when `kind` is 'number'. */
  readonly value?: number;
}

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

function tokenLabel(token: Token): string {
  return token.kind === 'number' ? String(token.value) : token.kind;
}

/**
 * Read a decimal number (digits with an optional single '.') starting at
 * `startPos`, push a number token, and return the position after it.
 */
function readNumber(source: string, startPos: number, tokens: Token[]): number {
  let pos = startPos;
  let sawDigit = false;
  let sawDot = false;
  let lexeme = '';

  while (pos < source.length) {
    const char = source.charAt(pos);
    if (isDigit(char)) {
      sawDigit = true;
      lexeme += char;
      pos += 1;
      continue;
    }
    if (char === '.') {
      if (sawDot) {
        throw new Error(
          `Invalid number "${lexeme}${char}" at position ${pos}: only one decimal point is allowed.`,
        );
      }
      sawDot = true;
      lexeme += char;
      pos += 1;
      continue;
    }
    break;
  }

  if (!sawDigit) {
    throw new Error(`Invalid number at position ${startPos}: a decimal point must be preceded or followed by digits.`);
  }

  const value = Number(lexeme);
  if (!Number.isFinite(value)) {
    throw new Error(`Number "${lexeme}" at position ${startPos} is not a finite number.`);
  }

  tokens.push({ kind: 'number', value });
  return pos;
}

function tokenize(source: string): readonly Token[] {
  const tokens: Token[] = [];
  let pos = 0;

  while (pos < source.length) {
    const char = source.charAt(pos);

    if (isWhitespace(char)) {
      pos += 1;
      continue;
    }

    if (isDigit(char) || char === '.') {
      pos = readNumber(source, pos, tokens);
      continue;
    }

    switch (char) {
      case '+':
      case '-':
      case '*':
      case '/':
      case '(':
      case ')': {
        tokens.push({ kind: char });
        pos += 1;
        break;
      }
      default: {
        throw new Error(
          `Unsupported character "${char}" at position ${pos}. Only numbers, + - * / ( ), and whitespace are allowed.`,
        );
      }
    }
  }

  return tokens;
}

class Parser {
  private pos = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  /** Parse the whole token stream as one additive expression. */
  parse(): number {
    const result = this.parseAdditive();
    const leftover = this.peek();
    if (leftover) {
      throw new Error(`Unexpected "${tokenLabel(leftover)}" after a complete expression.`);
    }
    return result;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  /** additive := multiplicative (('+' | '-') multiplicative)* — left associative. */
  private parseAdditive(): number {
    let left = this.parseMultiplicative();
    for (;;) {
      const op = this.peek();
      if (op && op.kind === '+') {
        this.pos += 1;
        const right = this.parseMultiplicative();
        left = left + right;
      } else if (op && op.kind === '-') {
        this.pos += 1;
        const right = this.parseMultiplicative();
        left = left - right;
      } else {
        return left;
      }
      if (!Number.isFinite(left)) {
        throw new Error('Intermediate result is not a finite number.');
      }
    }
  }

  /** multiplicative := unary (('*' | '/') unary)* — left associative. */
  private parseMultiplicative(): number {
    let left = this.parseUnary();
    for (;;) {
      const op = this.peek();
      if (op && op.kind === '*') {
        this.pos += 1;
        const right = this.parseUnary();
        left = left * right;
      } else if (op && op.kind === '/') {
        this.pos += 1;
        const right = this.parseUnary();
        if (right === 0) {
          throw new Error('Division by zero.');
        }
        left = left / right;
      } else {
        return left;
      }
      if (!Number.isFinite(left)) {
        throw new Error('Intermediate result is not a finite number.');
      }
    }
  }

  /** unary := ('+' | '-') unary | primary — handles stacked signs like "- - 5". */
  private parseUnary(): number {
    const op = this.peek();
    if (op && op.kind === '+') {
      this.pos += 1;
      return this.parseUnary();
    }
    if (op && op.kind === '-') {
      this.pos += 1;
      return -this.parseUnary();
    }
    return this.parsePrimary();
  }

  /** primary := NUMBER | '(' additive ')' */
  private parsePrimary(): number {
    const token = this.peek();
    if (!token) {
      throw new Error('Expression ends unexpectedly; expected a number or a "(...)" group.');
    }
    if (token.kind === 'number') {
      this.pos += 1;
      return token.value as number;
    }
    if (token.kind === '(') {
      this.pos += 1;
      const inner = this.parseAdditive();
      const close = this.peek();
      if (!close || close.kind !== ')') {
        throw new Error('Missing closing parenthesis.');
      }
      this.pos += 1;
      return inner;
    }
    throw new Error(`Unexpected "${tokenLabel(token)}" where a number or a "(...)" group was expected.`);
  }
}

/**
 * Evaluate an arithmetic expression and return the result as a JSON string
 * such as {"result":60}. Throws Error with a useful message for invalid
 * input, division by zero, and non-finite results.
 */
export function evaluateArithmetic(expression: string): string {
  const source = expression.trim();
  if (source.length === 0) {
    throw new Error('Expression is empty.');
  }

  const tokens = tokenize(source);
  if (tokens.length === 0) {
    throw new Error('Expression contains no numbers or operators.');
  }

  const result = new Parser(tokens).parse();
  if (!Number.isFinite(result)) {
    throw new Error('Result is not a finite number.');
  }

  return JSON.stringify({ result });
}
