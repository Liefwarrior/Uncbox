// Reads and writes the Lua that WoW addons save and load.
//
// WoW writes an addon's SavedVariables to WTF\Account\<ACCOUNT>\SavedVariables\<Addon>.lua (and
// per character under <Realm>\<Character>\) when you log out or /reload, as plain assignments:
//
//   UncboxDB = {
//     ["guild"] = { ["name"] = "Uncbox", ["members"] = { { "Lief", 60, "WARRIOR" }, -- [1]
//     ...
//
// parseSavedVariables turns a file like that into { UncboxDB: {...} }. Tables whose keys are
// exactly 1..n become arrays; anything else becomes an object with string keys. toLua goes the
// other way, for data files Uncbox writes into an addon's folder for it to load on /reload.

const MAX_DEPTH = 64;

class LuaSyntaxError extends Error {
  constructor(message, at) {
    super(`${message} at character ${at}`);
    this.name = 'LuaSyntaxError';
  }
}

/** { name: value } for every top-level `name = value` in a SavedVariables file. */
export function parseSavedVariables(text) {
  const p = new Parser(String(text));
  const out = {};
  p.space();
  while (!p.done()) {
    const name = p.name();
    p.space();
    p.expect('=');
    p.space();
    out[name] = p.value(0);
    p.space();
    if (p.peek() === ';') p.i++;
    p.space();
  }
  return out;
}

/** One Lua value from its source text (a table, string, number, boolean or nil). */
export function parseLuaValue(text) {
  const p = new Parser(String(text));
  p.space();
  const v = p.value(0);
  p.space();
  if (!p.done()) throw new LuaSyntaxError('Unexpected text after the value', p.i);
  return v;
}

class Parser {
  constructor(s) {
    this.s = s;
    this.i = 0;
  }

  done() {
    return this.i >= this.s.length;
  }

  peek() {
    return this.s[this.i];
  }

  expect(ch) {
    if (this.s[this.i] !== ch) throw new LuaSyntaxError(`Expected "${ch}"`, this.i);
    this.i++;
  }

  /** Skips whitespace and comments: -- line, and --[[ block ]] / --[==[ block ]==]. */
  space() {
    for (;;) {
      while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
      if (this.s.startsWith('--', this.i)) {
        const long = /^--\[(=*)\[/.exec(this.s.slice(this.i, this.i + 64));
        if (long) {
          const close = `]${long[1]}]`;
          const end = this.s.indexOf(close, this.i + long[0].length);
          this.i = end < 0 ? this.s.length : end + close.length;
        } else {
          const end = this.s.indexOf('\n', this.i);
          this.i = end < 0 ? this.s.length : end + 1;
        }
        continue;
      }
      return;
    }
  }

  name() {
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.s.slice(this.i, this.i + 256));
    if (!m) throw new LuaSyntaxError('Expected a name', this.i);
    this.i += m[0].length;
    return m[0];
  }

  value(depth) {
    if (depth > MAX_DEPTH) throw new LuaSyntaxError('Tables nested too deep', this.i);
    const ch = this.peek();
    if (ch === '{') return this.table(depth);
    if (ch === '"' || ch === "'") return this.string();
    if (ch === '[' && /^\[=*\[/.test(this.s.slice(this.i, this.i + 64))) return this.longString();
    if (ch === '-' || ch === '.' || (ch >= '0' && ch <= '9') || /^(?:inf|nan)(?![A-Za-z0-9_])/.test(this.s.slice(this.i, this.i + 4))) return this.number();
    const word = /^[A-Za-z_]+/.exec(this.s.slice(this.i, this.i + 16))?.[0];
    if (word === 'true' || word === 'false' || word === 'nil') {
      this.i += word.length;
      return word === 'true' ? true : word === 'false' ? false : null;
    }
    throw new LuaSyntaxError('Expected a value', this.i);
  }

  number() {
    const m = /^-?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|inf|nan)/.exec(this.s.slice(this.i, this.i + 64));
    if (!m) throw new LuaSyntaxError('Expected a number', this.i);
    this.i += m[0].length;
    const t = m[0];
    if (/inf$/.test(t)) return t.startsWith('-') ? -Infinity : Infinity;
    if (/nan$/.test(t)) return NaN;
    if (/^-?0[xX]/.test(t)) return (t.startsWith('-') ? -1 : 1) * parseInt(t.replace(/^-?0[xX]/, ''), 16);
    return Number(t);
  }

  string() {
    const quote = this.s[this.i++];
    // Lua strings are bytes: \ddd escapes are single bytes of UTF-8 text, so collect bytes and
    // decode once at the end.
    const bytes = [];
    const push = (text) => bytes.push(...Buffer.from(text, 'utf8'));
    for (;;) {
      if (this.done()) throw new LuaSyntaxError('Unfinished string', this.i);
      const c = this.s[this.i++];
      if (c === quote) return Buffer.from(bytes).toString('utf8');
      if (c === '\n') throw new LuaSyntaxError('Line break inside a string', this.i);
      if (c !== '\\') {
        push(c);
        continue;
      }
      const e = this.s[this.i++];
      const simple = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', '\\': '\\', '"': '"', "'": "'", '\n': '\n' };
      if (e in simple) push(simple[e]);
      else if (e >= '0' && e <= '9') {
        const m = /^\d{1,3}/.exec(this.s.slice(this.i - 1, this.i + 2));
        this.i += m[0].length - 1;
        bytes.push(Number(m[0]) & 255);
      } else throw new LuaSyntaxError(`Unknown escape "\\${e}"`, this.i);
    }
  }

  longString() {
    const open = /^\[(=*)\[/.exec(this.s.slice(this.i, this.i + 64));
    const close = `]${open[1]}]`;
    let start = this.i + open[0].length;
    if (this.s[start] === '\r') start++;
    if (this.s[start] === '\n') start++;
    const end = this.s.indexOf(close, start);
    if (end < 0) throw new LuaSyntaxError('Unfinished long string', this.i);
    this.i = end + close.length;
    return this.s.slice(start, end);
  }

  table(depth) {
    this.expect('{');
    const entries = [];
    let next = 1;
    for (;;) {
      this.space();
      if (this.peek() === '}') {
        this.i++;
        break;
      }
      let key;
      if (this.peek() === '[' && !/^\[=*\[/.test(this.s.slice(this.i, this.i + 64))) {
        this.i++;
        this.space();
        key = this.value(depth + 1);
        this.space();
        this.expect(']');
        this.space();
        this.expect('=');
        this.space();
      } else {
        const save = this.i;
        const m = /^[A-Za-z_][A-Za-z0-9_]*\s*=(?!=)/.exec(this.s.slice(this.i, this.i + 300));
        if (m && !/^(true|false|nil)\s*=/.test(m[0])) {
          key = m[0].replace(/\s*=$/, '');
          this.i += m[0].length;
          this.space();
        } else {
          this.i = save;
          key = next++;
        }
      }
      const value = this.value(depth + 1);
      if (value !== null) entries.push([key, value]);
      this.space();
      if (this.peek() === ',' || this.peek() === ';') this.i++;
    }
    return fromEntries(entries);
  }
}

/** An array when the keys are exactly 1..n (any order); otherwise an object with string keys. */
function fromEntries(entries) {
  const n = entries.length;
  const isArray = n > 0 && entries.every(([k]) => Number.isInteger(k) && k >= 1 && k <= n) && new Set(entries.map(([k]) => k)).size === n;
  if (isArray) {
    const arr = new Array(n);
    for (const [k, v] of entries) arr[k - 1] = v;
    return arr;
  }
  const obj = {};
  for (const [k, v] of entries) obj[String(k)] = v;
  return obj;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set(
  'and break do else elseif end false for function if in local nil not or repeat return then true until while goto'.split(' '),
);

/** A Lua string literal; every byte outside printable ASCII is written as \ddd, the way WoW does. */
export function luaString(s) {
  const bytes = Buffer.from(String(s), 'utf8');
  let out = '"';
  for (const b of bytes) {
    if (b === 0x22) out += '\\"';
    else if (b === 0x5c) out += '\\\\';
    else if (b === 0x0a) out += '\\n';
    else if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b);
    else out += `\\${b}`;
  }
  return `${out}"`;
}

/** Lua source for a value: objects become { ["key"] = … }, arrays { …, … }. */
export function toLua(value, indent = '') {
  if (value === null || value === undefined) return 'nil';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return '0/0';
    if (!Number.isFinite(value)) return value > 0 ? 'math.huge' : '-math.huge';
    return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(15)));
  }
  if (typeof value === 'string') return luaString(value);
  const inner = `${indent}\t`;
  if (Array.isArray(value)) {
    if (value.length === 0) return '{}';
    return `{\n${value.map((v) => `${inner}${toLua(v, inner)},`).join('\n')}\n${indent}}`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined);
    if (keys.length === 0) return '{}';
    // Integer-looking keys came from Lua number keys (a sparse table), so they go back as numbers.
    const key = (k) => (/^-?\d+$/.test(k) ? `[${k}]` : `[${luaString(k)}]`);
    return `{\n${keys.map((k) => `${inner}${key(k)} = ${toLua(value[k], inner)},`).join('\n')}\n${indent}}`;
  }
  throw new TypeError(`Can't write a ${typeof value} as Lua`);
}

/** A whole data file: `Name = {...}` lines an addon loads like any of its .lua files. */
export function toLuaFile(globals, header = '') {
  const lines = header ? header.split('\n').map((l) => `-- ${l}`) : [];
  for (const [name, value] of Object.entries(globals)) {
    if (!IDENT.test(name) || RESERVED.has(name)) throw new TypeError(`"${name}" isn't a Lua global name`);
    lines.push(`${name} = ${toLua(value)}`);
  }
  return `${lines.join('\n')}\n`;
}

export { LuaSyntaxError };
