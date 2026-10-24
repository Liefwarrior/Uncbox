// fengari (Lua 5.3 in JavaScript) ships no types. The tests only use the parts below.
declare module 'fengari' {
  export const lua: any;
  export const lauxlib: any;
  export const lualib: any;
  export function to_luastring(text: string): Uint8Array;
  export function to_jsstring(bytes: Uint8Array): string;
  const fengari: { lua: any; lauxlib: any; lualib: any; to_luastring: typeof to_luastring; to_jsstring: typeof to_jsstring };
  export default fengari;
}
