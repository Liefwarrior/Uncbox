export const ADDON_DIR: string;
export function tocFiles(): string[];
export function luaTable(v: unknown): string;

export class Game {
  constructor(options?: { layout?: 'old' | 'new'; files?: string[] });
  load(file: string): void;
  run(code: string, name?: string): void;
  eval<T = any>(expr: string): T;
  saved(name?: string): string;
  pump(): void;
  start(): void;
  auctions(list: { id: number; name?: string; count?: number; buyout?: number; owner?: string; suffix?: number; minBid?: number }[]): void;
  close(): void;
}
