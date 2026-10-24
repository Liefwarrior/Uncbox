import { ROLES, type Role, type RoleChoice } from './comp';

export type CompSettings = {
  /** Roles chosen by hand, by player name (a list: settings keep lists whole). Anyone not here is guessed from their class. */
  roles: RoleChoice[];
};

export const defaultCompSettings = (): CompSettings => ({ roles: [] });

/** At most this many hand-picked roles are kept. */
const MAX_ROLES = 400;

export function cleanCompSettings(s: CompSettings): CompSettings {
  const seen = new Set<string>();
  const roles: RoleChoice[] = [];
  for (const r of Array.isArray(s.roles) ? s.roles : []) {
    if (!r || typeof r.name !== 'string' || !r.name || r.name.length > 40 || !ROLES.includes(r.role as Role) || seen.has(r.name)) continue;
    seen.add(r.name);
    roles.push({ name: r.name, role: r.role });
    if (roles.length >= MAX_ROLES) break;
  }
  return { ...s, roles };
}

/** Player names mean nothing to whoever gets a shared preset. */
export const compForSharing = (s: CompSettings): CompSettings => ({ ...s, roles: [] });
