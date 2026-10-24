// The small price language for auction house rules, like TSM's custom prices:
//
//   max(vendorsell, 85% dbmarket)        first(dbmarket, dbminbuyout, 2g50s)        dbminbuyout - 1s
//
// Numbers, money literals (1g50s, 75s, 12c), percentages (90%), the variables below, the
// functions below and + - * / ( ). A percentage in front of a value multiplies it ("90% dbmarket").
// It is tokenized and parsed by hand and evaluated over a tree: nothing is ever passed to eval or
// Function. A variable with no data (no scans yet, say) is "invalid" (null): arithmetic and
// min/max with an invalid value are invalid too, and first(...) picks the first valid one.

export const VARIABLES = ['dbmarket', 'dbminbuyout', 'dbhistorical', 'avgsell', 'vendorsell', 'crafting'];

/** name → [fewest, most] arguments. */
const FUNCTIONS = {
  min: [1, 20],
  max: [1, 20],
  first: [1, 20],
  avg: [1, 20],
  round: [1, 1],
  floor: [1, 1],
  ceil: [1, 1],
  abs: [1, 1],
};

const MAX_LENGTH = 500;
const MAX_DEPTH = 32;

export class FormulaError extends Error {
  /** @param {string} message @param {number} [pos] where in the formula (0-based) */
  constructor(message, pos) {
    super(pos === undefined ? message : `${message} (at ${pos + 1})`);
    this.name = 'FormulaError';
    this.pos = pos;
  }
}

/** The formula as a list of { type, value, pos }. */
export function tokenize(text) {
  const s = String(text);
  if (s.length > MAX_LENGTH) throw new FormulaError(`That formula is longer than ${MAX_LENGTH} characters`, MAX_LENGTH);
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if ('+-*/(),'.includes(ch)) {
      tokens.push({ type: ch, pos: i });
      i++;
      continue;
    }
    if ((ch >= '0' && ch <= '9') || ch === '.') {
      const rest = s.slice(i);
      // 1g50s25c, 75s, 12c, 1.5g: digits straight followed by g, s or c.
      const money = /^(?:(\d+(?:\.\d+)?)g)?(?:(\d+)s)?(?:(\d+)c)?(?![A-Za-z0-9_.])/i.exec(rest);
      if (money && money[0] !== '') {
        const value = Math.round(Number(money[1] ?? 0) * 10000 + Number(money[2] ?? 0) * 100 + Number(money[3] ?? 0));
        tokens.push({ type: 'num', value, pos: i, money: true });
        i += money[0].length;
        continue;
      }
      const num = /^(?:\d+(?:\.\d+)?|\.\d+)/.exec(rest);
      if (!num || /^[A-Za-z_]/.test(rest.slice(num[0].length))) {
        throw new FormulaError(`"${rest.match(/^[\w.]+/)?.[0] ?? ch}" isn't a number`, i);
      }
      i += num[0].length;
      if (s[i] === '%') {
        tokens.push({ type: 'pct', value: Number(num[0]) / 100, pos: i - num[0].length });
        i++;
      } else tokens.push({ type: 'num', value: Number(num[0]), pos: i - num[0].length });
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
    if (word) {
      tokens.push({ type: 'name', value: word[0].toLowerCase(), pos: i });
      i += word[0].length;
      continue;
    }
    throw new FormulaError(`Unexpected "${ch}"`, i);
  }
  tokens.push({ type: 'end', pos: s.length });
  return tokens;
}

/** The formula as a tree, or a FormulaError saying what is wrong and where. */
export function parseFormula(text) {
  if (typeof text !== 'string' || !text.trim()) throw new FormulaError('The formula is empty');
  const tokens = tokenize(text);
  let at = 0;
  const peek = () => tokens[at];
  const take = () => tokens[at++];

  const startsValue = (t) => t.type === 'num' || t.type === 'name' || t.type === '(' || t.type === 'pct';

  function expr(depth) {
    if (depth > MAX_DEPTH) throw new FormulaError('That formula nests too deeply', peek().pos);
    let left = term(depth);
    while (peek().type === '+' || peek().type === '-') {
      const op = take().type;
      left = { type: 'bin', op, left, right: term(depth) };
    }
    return left;
  }

  function term(depth) {
    let left = unary(depth);
    while (peek().type === '*' || peek().type === '/') {
      const op = take().type;
      left = { type: 'bin', op, left, right: unary(depth) };
    }
    return left;
  }

  function unary(depth) {
    if (peek().type === '-') {
      take();
      return { type: 'neg', arg: unary(depth + 1) };
    }
    return primary(depth);
  }

  function primary(depth) {
    const t = take();
    if (t.type === 'num') return { type: 'num', value: t.value };
    if (t.type === 'pct') {
      const node = { type: 'num', value: t.value };
      // "90% dbmarket": a percentage followed by a value multiplies it.
      if (startsValue(peek()) && peek().type !== 'pct') return { type: 'bin', op: '*', left: node, right: unary(depth + 1) };
      return node;
    }
    if (t.type === '(') {
      const inner = expr(depth + 1);
      if (peek().type !== ')') throw new FormulaError('Expected ")"', peek().pos);
      take();
      return inner;
    }
    if (t.type === 'name') {
      if (peek().type === '(') {
        const range = FUNCTIONS[t.value];
        if (!range) throw new FormulaError(`Unknown function "${t.value}"`, t.pos);
        take();
        const args = [];
        if (peek().type !== ')') {
          args.push(expr(depth + 1));
          while (peek().type === ',') {
            take();
            args.push(expr(depth + 1));
          }
        }
        if (peek().type !== ')') throw new FormulaError('Expected ")" or ","', peek().pos);
        take();
        if (args.length < range[0] || args.length > range[1]) {
          throw new FormulaError(`${t.value}() takes ${range[0] === range[1] ? range[0] : `${range[0]} to ${range[1]}`} value${range[1] === 1 ? '' : 's'}, not ${args.length}`, t.pos);
        }
        return { type: 'call', name: t.value, args };
      }
      if (!VARIABLES.includes(t.value)) {
        throw new FormulaError(FUNCTIONS[t.value] ? `${t.value} needs brackets, like ${t.value}(...)` : `Unknown price "${t.value}"`, t.pos);
      }
      return { type: 'var', name: t.value };
    }
    throw new FormulaError(t.type === 'end' ? 'The formula ends too soon' : `Unexpected "${t.type === 'name' || t.type === 'num' ? t.value : t.type}"`, t.pos);
  }

  const tree = expr(0);
  if (peek().type !== 'end') throw new FormulaError(peek().type === ')' ? 'Unmatched ")"' : 'Expected + - * / or the end of the formula', peek().pos);
  return tree;
}

/** The names of the prices a parsed formula uses. */
export function formulaVariables(tree, found = new Set()) {
  if (tree.type === 'var') found.add(tree.name);
  else if (tree.type === 'neg') formulaVariables(tree.arg, found);
  else if (tree.type === 'bin') {
    formulaVariables(tree.left, found);
    formulaVariables(tree.right, found);
  } else if (tree.type === 'call') for (const a of tree.args) formulaVariables(a, found);
  return found;
}

const finite = (n) => (Number.isFinite(n) ? n : null);

/** The value of a parsed formula for an item's prices ({ dbmarket: 1200, … }, missing = no data), or null when invalid. */
export function evaluate(tree, vars) {
  switch (tree.type) {
    case 'num':
      return tree.value;
    case 'var': {
      const v = vars && Object.hasOwn(vars, tree.name) ? vars[tree.name] : undefined;
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    }
    case 'neg': {
      const v = evaluate(tree.arg, vars);
      return v === null ? null : -v;
    }
    case 'bin': {
      const a = evaluate(tree.left, vars);
      const b = evaluate(tree.right, vars);
      if (a === null || b === null) return null;
      if (tree.op === '+') return finite(a + b);
      if (tree.op === '-') return finite(a - b);
      if (tree.op === '*') return finite(a * b);
      return b === 0 ? null : finite(a / b);
    }
    case 'call': {
      if (tree.name === 'first') {
        for (const arg of tree.args) {
          const v = evaluate(arg, vars);
          if (v !== null) return v;
        }
        return null;
      }
      const values = tree.args.map((a) => evaluate(a, vars));
      if (values.some((v) => v === null)) return null;
      switch (tree.name) {
        case 'min':
          return Math.min(...values);
        case 'max':
          return Math.max(...values);
        case 'avg':
          return values.reduce((x, y) => x + y, 0) / values.length;
        case 'round':
          return Math.round(values[0]);
        case 'floor':
          return Math.floor(values[0]);
        case 'ceil':
          return Math.ceil(values[0]);
        default:
          return Math.abs(values[0]);
      }
    }
    default:
      return null;
  }
}

const cache = new Map();

/** Parses (and remembers) a formula; throws FormulaError. */
export function compile(text) {
  let tree = cache.get(text);
  if (!tree) {
    tree = parseFormula(text);
    if (cache.size > 500) cache.clear();
    cache.set(text, tree);
  }
  return tree;
}

/** { ok: true, value } with value copper (rounded) or null when the item has no data; { ok: false, error } for a bad formula. Never throws. */
export function evalFormula(text, vars) {
  try {
    const v = evaluate(compile(text), vars);
    return { ok: true, value: v === null ? null : Math.round(v) };
  } catch (err) {
    if (err instanceof FormulaError) return { ok: false, error: err.message };
    throw err;
  }
}

/** null when the formula is fine, otherwise what is wrong with it. */
export function checkFormula(text) {
  try {
    compile(text);
    return null;
  } catch (err) {
    if (err instanceof FormulaError) return err.message;
    throw err;
  }
}
