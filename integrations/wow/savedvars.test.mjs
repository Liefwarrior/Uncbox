import { describe, expect, it } from 'vitest';
import { LuaSyntaxError, luaString, parseLuaValue, parseSavedVariables, toLua, toLuaFile } from './savedvars.mjs';

// The shape WoW writes: tabs, ["key"] = value, trailing commas, "-- [n]" comments on array items.
const SAVED = `
UncboxDB = {
	["version"] = 3,
	["enabled"] = true,
	["guild"] = {
		["name"] = "Night\\'s Watch",
		["members"] = {
			{
				"Lief", -- [1]
				60, -- [2]
				"WARRIOR", -- [3]
			}, -- [1]
			{
				"Zoë", -- [1]
				58, -- [2]
				"PRIEST", -- [3]
			}, -- [2]
		},
	},
	["gold"] = 1234567,
	["ratio"] = 0.25,
	["note"] = nil,
}
UncboxCharDB = nil
OtherDB = {
}
`;

describe('parseSavedVariables', () => {
  it('reads every top-level assignment the way WoW writes them', () => {
    const sv = parseSavedVariables(SAVED);
    expect(Object.keys(sv)).toEqual(['UncboxDB', 'UncboxCharDB', 'OtherDB']);
    expect(sv.UncboxDB.version).toBe(3);
    expect(sv.UncboxDB.enabled).toBe(true);
    expect(sv.UncboxDB.guild.name).toBe("Night's Watch");
    expect(sv.UncboxDB.guild.members).toEqual([
      ['Lief', 60, 'WARRIOR'],
      ['Zoë', 58, 'PRIEST'],
    ]);
    expect(sv.UncboxDB.gold).toBe(1234567);
    expect(sv.UncboxDB.ratio).toBe(0.25);
    expect('note' in sv.UncboxDB).toBe(false);
    expect(sv.UncboxCharDB).toBeNull();
    expect(sv.OtherDB).toEqual({});
  });

  it('keeps sparse or mixed tables as objects with string keys', () => {
    expect(parseLuaValue('{ [2] = "b", [5] = "e" }')).toEqual({ 2: 'b', 5: 'e' });
    expect(parseLuaValue('{ "a", ["x"] = 1 }')).toEqual({ 1: 'a', x: 1 });
    expect(parseLuaValue('{ [3] = "c", [1] = "a", [2] = "b" }')).toEqual(['a', 'b', 'c']);
  });

  it('reads bare-name keys, semicolons and positional items', () => {
    expect(parseLuaValue('{ a = 1; b = { 1, 2; 3 }, 4 }')).toEqual({ a: 1, b: [1, 2, 3], 1: 4 });
  });

  it('decodes escapes, \\ddd UTF-8 bytes and long strings', () => {
    expect(parseLuaValue('"tab\\there\\nnew \\"q\\" back\\\\slash"')).toBe('tab\there\nnew "q" back\\slash');
    expect(parseLuaValue('"Zo\\195\\171"')).toBe('Zoë');
    expect(parseLuaValue('[[line one\nline two]]')).toBe('line one\nline two');
    expect(parseLuaValue('[==[has ]] inside]==]')).toBe('has ]] inside');
  });

  it('reads the number forms Lua writes', () => {
    expect(parseLuaValue('-12')).toBe(-12);
    expect(parseLuaValue('1.5e3')).toBe(1500);
    expect(parseLuaValue('0x1F')).toBe(31);
    expect(parseLuaValue('.5')).toBe(0.5);
    expect(parseLuaValue('inf')).toBe(Infinity);
    expect(parseLuaValue('-inf')).toBe(-Infinity);
  });

  it('skips line and block comments anywhere', () => {
    const sv = parseSavedVariables('--[[ header\nmore ]]\nA = { -- note\n 1, --[==[ x ]==] 2 }\n-- trailing');
    expect(sv.A).toEqual([1, 2]);
  });

  it('says where a broken file goes wrong instead of guessing', () => {
    expect(() => parseSavedVariables('A = { 1, 2')).toThrow(LuaSyntaxError);
    expect(() => parseSavedVariables('A = "open')).toThrow(/Unfinished string/);
    expect(() => parseSavedVariables('= 3')).toThrow(/Expected a name/);
    expect(() => parseLuaValue('{ } extra')).toThrow(/after the value/);
  });

  it('refuses absurdly deep nesting rather than overflowing the stack', () => {
    expect(() => parseLuaValue('{'.repeat(200) + '}'.repeat(200))).toThrow(/too deep/);
  });
});

describe('toLua', () => {
  it('writes values that read back the same', () => {
    const value = {
      version: 2,
      prices: { 2589: { market: 1250, min: 990 }, 4306: { market: 4100.5, min: 3800 } },
      list: ['Linen Cloth', 'Zoë’s "special"\nline', 'back\\slash'],
      flags: { on: true, off: false },
      empty: {},
      none: [],
    };
    const back = parseLuaValue(toLua(value));
    expect(back).toEqual({ ...value, empty: {}, none: {} });
  });

  it('writes integer-looking keys back as Lua numbers', () => {
    expect(toLua({ 2589: 1 })).toContain('[2589] = 1');
    expect(toLua({ name: 1 })).toContain('["name"] = 1');
  });

  it('escapes every non-printable byte so the file is plain ASCII', () => {
    expect(luaString('Zoë')).toBe('"Zo\\195\\171"');
    expect(luaString('a"b\\c\nd')).toBe('"a\\"b\\\\c\\nd"');
    expect(/^[\x20-\x7e\n\t]*$/.test(toLua({ s: 'ünïcødé ✓' }))).toBe(true);
  });

  it('writes special numbers and nil', () => {
    expect(toLua(null)).toBe('nil');
    expect(toLua(Infinity)).toBe('math.huge');
    expect(toLua(-Infinity)).toBe('-math.huge');
    expect(toLua(0.1 + 0.2)).toBe('0.3');
  });

  it('builds a whole data file of globals with a comment header', () => {
    expect(toLuaFile({})).toBe('\n');
    const text = toLuaFile({ UncboxAHData: { v: 1 } }, 'Written by Uncbox.\nDo not edit.');
    expect(text.startsWith('-- Written by Uncbox.\n-- Do not edit.\nUncboxAHData = {')).toBe(true);
    expect(parseSavedVariables(text)).toEqual({ UncboxAHData: { v: 1 } });
    expect(() => toLuaFile({ 'not a name': 1 })).toThrow(/global name/);
    expect(() => toLuaFile({ end: 1 })).toThrow(/global name/);
  });
});
