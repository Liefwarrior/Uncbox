// Runs the UncboxAH addon's Lua in fengari (Lua 5.3 in JavaScript) against ahmock.lua, a fake of the
// Classic Era auction house, mail, bag and tooltip API. Used by ah.test.ts and server/wowah.test.mjs.
// The game's Lua is 5.1; the mock adds the few 5.1 names the addon uses, and the addon avoids what
// differs (integer division, goto, bit operators, numbers turning into text as 1.0).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fengari from 'fengari';

const { lua, lauxlib, lualib, to_luastring } = fengari;

const dir = path.dirname(fileURLToPath(import.meta.url));
export const ADDON_DIR = path.join(dir, 'addon', 'UncboxAH');

/** The files in load order, from the .toc. */
export function tocFiles() {
  const toc = readFileSync(path.join(ADDON_DIR, 'UncboxAH.toc'), 'utf8');
  return toc.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
}

/** A JS value as Lua table source (for test setup). */
export function luaTable(v) {
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `{${v.map(luaTable).join(',')}}`;
  return `{${Object.entries(v)
    .map(([k, x]) => `[${JSON.stringify(k)}]=${luaTable(x)}`)
    .join(',')}}`;
}

export class Game {
  /**
   * layout: which QueryAuctionItems the fake game has: "old" (11 arguments) or "new" (9, and
   * AuctionCategories exists). files: addon files to load (default: all in the .toc, except the
   * shipped empty data file).
   */
  constructor({ layout = 'old', files } = {}) {
    this.L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(this.L);
    this.run(readFileSync(path.join(dir, 'ahmock.lua'), 'utf8'), 'ahmock.lua');
    this.run(`Mock.layout = "${layout}"; ns = {}; ns.printed = {}; ns.errors = {}`);
    if (layout === 'new') this.run('AuctionCategories = {}');
    for (const f of files ?? tocFiles().filter((x) => x !== 'UncboxAHData.lua')) this.load(f);
  }

  /** Loads one addon file the way the game does: called with the addon name and its shared table. */
  load(file) {
    const src = readFileSync(path.join(ADDON_DIR, file), 'utf8');
    lua.lua_pushstring(this.L, to_luastring(src));
    lua.lua_setglobal(this.L, to_luastring('__src'));
    this.run(`assert(load(__src, "@UncboxAH/${file}"))("UncboxAH", ns)`);
  }

  /** Runs Lua code; throws the Lua error (with its location) if it fails. */
  run(code, name = 'test') {
    const src = to_luastring(code);
    let status = lauxlib.luaL_loadbuffer(this.L, src, src.length, to_luastring(`=${name}`));
    if (status === lua.LUA_OK) status = lua.lua_pcall(this.L, 0, 0, 0);
    if (status !== lua.LUA_OK) {
      const msg = lua.lua_tojsstring(this.L, -1);
      lua.lua_pop(this.L, 1);
      throw new Error(msg);
    }
  }

  /** A Lua global's string value. */
  #global(name) {
    lua.lua_getglobal(this.L, to_luastring(name));
    const text = lua.lua_tojsstring(this.L, -1);
    lua.lua_pop(this.L, 1);
    return text;
  }

  /** The value of a Lua expression, through JSON. */
  eval(expr) {
    this.run(`__out = json(${expr})`);
    return JSON.parse(this.#global('__out'));
  }

  /** Text of a global as WoW would save it to SavedVariables. */
  saved(name = 'UncboxAHDB') {
    this.run(`__out = Mock.serialize("${name}")`);
    return this.#global('__out');
  }

  /** Runs the addon's timers that are due. */
  pump() {
    this.run('Mock.pump()');
  }

  /** Starts the addon the way the game does (the load events). */
  start() {
    this.run('Mock.fire("ADDON_LOADED", "UncboxAH"); Mock.fire("PLAYER_LOGIN")');
  }

  /** Puts auctions on the fake house: [{ id, name?, count?, buyout?, owner?, suffix?, minBid? }]. */
  auctions(list) {
    for (const a of list) this.run(`Mock.auction(${luaTable(a)})`);
  }

  close() {
    lua.lua_close(this.L);
  }
}
