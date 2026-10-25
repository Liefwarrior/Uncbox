// Runs the Uncbox addon's own Lua files, the way WoW would, against the pretend game in wowmock.lua.
// Lua 5.3 (fengari) stands in for WoW's Lua 5.1; wowmock.lua shims the differences. A test builds a
// World, sets up the game with run(), fires events, moves time and reads back what the strip showed.

import { lauxlib, lua, lualib, to_luastring } from 'fengari';
import { Assembler, fromBlocks } from './codec';

// @ts-expect-error node:fs only exists in the test runner
const { readFileSync } = (await import('node:fs')) as { readFileSync: (file: URL, encoding: string) => string };

const here = (name: string) => new URL(name, import.meta.url);
const addonFile = (name: string) => here(`addon/Uncbox/${name}`);

/** A value as Lua source: strings are written byte by byte so any text survives. */
export function lit(v: unknown): string {
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') {
    return `"${[...new TextEncoder().encode(v)].map((b) => (b >= 0x20 && b < 0x7f && b !== 0x22 && b !== 0x5c ? String.fromCharCode(b) : `\\${String(b).padStart(3, '0')}`)).join('')}"`;
  }
  if (Array.isArray(v)) return `{${v.map(lit).join(',')}}`;
  return `{${Object.entries(v as object).map(([k, x]) => `[${lit(k)}]=${lit(x)}`).join(',')}}`;
}

/** The Lua files in the order the addon's .toc loads them. */
export function tocFiles(): string[] {
  return readFileSync(addonFile('Uncbox.toc'), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

export interface Message {
  kind: number;
  text: string;
}

export class World {
  private L = lauxlib.luaL_newstate();
  /** What Uncbox's page does with the strip: puts pages back together. */
  private assembler = new Assembler();
  private backlog: Message[] = [];

  /** Loads the mock game, then the addon's files. `config` is the UncboxConfig table as Lua source. */
  constructor(config = '') {
    lualib.luaL_openlibs(this.L);
    this.run(readFileSync(here('wowmock.lua'), 'utf8'), 'wowmock.lua');
    if (config) this.run(`UncboxConfig = ${config}`, 'config');
    for (const file of tocFiles()) {
      // UncboxConfig.lua is the settings Uncbox writes: tests set their own.
      if (file === 'UncboxConfig.lua' && config) continue;
      this.run(readFileSync(addonFile(file), 'utf8'), file);
    }
  }

  run(code: string, name = 'test') {
    const bytes = to_luastring(code);
    const failed = lauxlib.luaL_loadbuffer(this.L, bytes, bytes.length, to_luastring(`=${name}`)) !== lua.LUA_OK || lua.lua_pcall(this.L, 0, 0, 0) !== lua.LUA_OK;
    if (failed) {
      const message = lua.lua_tojsstring(this.L, -1);
      lua.lua_pop(this.L, 1);
      throw new Error(message);
    }
  }

  /** A Lua expression's value, as JSON (empty tables come back as []). */
  json<T = unknown>(expr: string): T {
    this.run(`__out = __json(${expr})`);
    lua.lua_getglobal(this.L, to_luastring('__out'));
    const text = lua.lua_tojsstring(this.L, -1);
    lua.lua_pop(this.L, 1);
    return JSON.parse(text) as T;
  }

  /** UncboxDB as the file WoW would save it. */
  savedVariables(): string {
    this.run(`__out = __savedvariables("UncboxDB")`);
    lua.lua_getglobal(this.L, to_luastring("__out"));
    const text = lua.lua_tojsstring(this.L, -1);
    lua.lua_pop(this.L, 1);
    return text;
  }

  fire(event: string, ...args: unknown[]) {
    this.run(`__fire(${[lit(event), ...args.map(lit)].join(',')})`);
  }

  /** Moves the clock. What the strip shows meanwhile is kept for the next messages() call. */
  advance(seconds: number) {
    this.backlog.push(...this.read(seconds));
  }

  login() {
    this.fire('PLAYER_LOGIN');
  }

  /** Runs the clock for this many seconds and returns what the page would read off the strip, plus what came up during earlier advance() calls. */
  messages(seconds: number): Message[] {
    const out = [...this.backlog, ...this.read(seconds)];
    this.backlog = [];
    return out;
  }

  private read(seconds: number): Message[] {
    const frames = this.json<string[]>(`__capture(${seconds})`);
    const out: Message[] = [];
    for (const digits of frames) {
      const page = fromBlocks([...digits].map(Number));
      const text = page && this.assembler.push(page);
      if (text) out.push(text);
    }
    return out;
  }
}
