type Obj = Record<string, unknown>;

export function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Lay saved data over the defaults so fields added in newer versions still get a value.
 * Arrays are taken whole from the saved side; type mismatches fall back to the default.
 */
export function overlay<T>(base: T, saved: unknown): T {
  if (saved === undefined || saved === null) return base;
  if (isObj(base)) {
    if (!isObj(saved)) return base;
    const out: Obj = { ...base };
    for (const key of Object.keys(base)) out[key] = overlay((base as Obj)[key], saved[key]);
    return out as T;
  }
  if (Array.isArray(base)) return (Array.isArray(saved) ? saved : base) as T;
  return (typeof saved === typeof base ? saved : base) as T;
}
