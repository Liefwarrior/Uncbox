import { useEffect, useState } from 'react';

// The Web widget's page-side logic: what a typed address means, the widget's own back / forward
// list (an iframe can't tell us where the page inside went), and whether a site can be framed.
// In the Uncbox app a real WebView2 shows the page instead (see native.ts).

export const SEARCH_ENGINES = [
  { id: 'google', name: 'Google', url: 'https://www.google.com/search?q=' },
  { id: 'duckduckgo', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q=' },
  { id: 'brave', name: 'Brave Search', url: 'https://search.brave.com/search?q=' },
] as const;

export const isSearchEngine = (id: string) => SEARCH_ENGINES.some((e) => e.id === id);

export const MIN_ZOOM = 50;
export const MAX_ZOOM = 200;
export const clampZoom = (zoom: number) => (Number.isFinite(zoom) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(zoom))) : 100);

/** Only web pages: no file:, javascript:, data: and so on. */
export function isWebUrl(text: string): boolean {
  try {
    const u = new URL(text);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== '';
  } catch {
    return false;
  }
}

// A host as people type it: localhost, an IPv4 address, or dotted names ending in letters
// ("wiki.example.org"), with an optional port and path.
const LOOKS_LIKE_HOST = /^(localhost|(\d{1,3}\.){3}\d{1,3}|[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,})(:\d{1,5})?([/?#].*)?$/i;
const WITH_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
// Schemes written without "//" that must never be opened (or searched for, as they'd be a mistake).
const BLOCKED_SCHEME = /^(javascript|data|vbscript|file|blob|about|chrome|edge|view-source|mailto|tel|ftp):/i;

export type Address = { kind: 'url' | 'search'; url: string } | { kind: 'blocked' } | { kind: 'empty' };

/**
 * What a typed address means: a web address (with https:// added if it was left off), a web
 * search for anything else, or "blocked" for other kinds of address.
 */
export function resolveAddress(input: string, engineId = 'google'): Address {
  const text = input.trim();
  if (!text) return { kind: 'empty' };
  if (WITH_SCHEME.test(text)) return isWebUrl(text) ? { kind: 'url', url: new URL(text).href } : { kind: 'blocked' };
  if (BLOCKED_SCHEME.test(text)) return { kind: 'blocked' };
  if (!/\s/.test(text) && LOOKS_LIKE_HOST.test(text)) {
    // This PC and home networks rarely have a certificate.
    const local = /^(localhost|\d{1,3}(\.\d{1,3}){3})(:|\/|\?|#|$)/i.test(text);
    const url = `${local ? 'http' : 'https'}://${text}`;
    return isWebUrl(url) ? { kind: 'url', url: new URL(url).href } : { kind: 'search', url: searchUrl(text, engineId) };
  }
  return { kind: 'search', url: searchUrl(text, engineId) };
}

export function searchUrl(query: string, engineId: string): string {
  const engine = SEARCH_ENGINES.find((e) => e.id === engineId) ?? SEARCH_ENGINES[0];
  return engine.url + encodeURIComponent(query.trim());
}

/** A saved address that is still fine to open: web pages only, else ''. */
export const cleanUrl = (text: unknown): string => (typeof text === 'string' && isWebUrl(text.trim()) ? text.trim() : '');

// ---- the widget's own history ----

export interface History {
  stack: string[];
  /** Where in the stack the page is; -1 when nothing is open. */
  index: number;
}

export const startHistory = (url: string): History => (url ? { stack: [url], index: 0 } : { stack: [], index: -1 });
export const currentOf = (h: History): string => h.stack[h.index] ?? '';
export const canGoBack = (h: History) => h.index > 0;
export const canGoForward = (h: History) => h.index >= 0 && h.index < h.stack.length - 1;

/** A new page: whatever was ahead of this one is dropped. Going to the page you're on adds nothing. */
export function visit(h: History, url: string): History {
  if (currentOf(h) === url) return h;
  return { stack: [...h.stack.slice(0, h.index + 1), url], index: h.index + 1 };
}
export const goBack = (h: History): History => (canGoBack(h) ? { ...h, index: h.index - 1 } : h);
export const goForward = (h: History): History => (canGoForward(h) ? { ...h, index: h.index + 1 } : h);

// ---- can this site be shown in a frame? ----

export type Frameable = 'checking' | 'ok' | 'blocked';

const probes = new Map<string, Promise<boolean>>();

/** Asks the server (which can read the site's headers; the page can't) whether the site allows framing. */
export function checkFrameable(url: string): Promise<boolean> {
  const key = `${window.location.origin} ${url}`;
  let probe = probes.get(key);
  if (!probe) {
    const query = new URLSearchParams({ url, from: window.location.origin });
    probe = fetch(`/api/web/frameable?${query}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ frameable: boolean }>) : { frameable: true }))
      .then((r) => r.frameable !== false)
      // If we can't tell, let the frame try.
      .catch(() => true);
    probes.set(key, probe);
    // Sites change their headers, so a probe is only reused for a minute.
    setTimeout(() => probes.delete(key), 60_000);
  }
  return probe;
}

export function useFrameable(url: string, enabled: boolean): Frameable {
  const [result, setResult] = useState<{ url: string; ok: boolean } | null>(null);
  useEffect(() => {
    if (!enabled || !url) return;
    let stale = false;
    void checkFrameable(url).then((ok) => !stale && setResult({ url, ok }));
    return () => {
      stale = true;
    };
  }, [url, enabled]);
  if (!enabled || !url) return 'ok';
  return result?.url === url ? (result.ok ? 'ok' : 'blocked') : 'checking';
}

/** The iframe's sandbox: scripts, forms, popups and so on, but a page of Uncbox's own origin gets no same-origin rights. */
export function sandboxFor(url: string, pageOrigin: string): string {
  const flags = ['allow-scripts', 'allow-forms', 'allow-popups', 'allow-popups-to-escape-sandbox', 'allow-presentation', 'allow-downloads', 'allow-modals'];
  let sameOrigin = false;
  try {
    sameOrigin = new URL(url).origin === pageOrigin;
  } catch {
    // An address that doesn't parse is never opened anyway.
  }
  if (!sameOrigin) flags.push('allow-same-origin');
  return flags.join(' ');
}

export const FRAME_ALLOW = 'fullscreen; autoplay; clipboard-write; picture-in-picture; encrypted-media';
