import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '../events';

// What the Google widgets (Drive, Calendar, Gmail) share on the page: the sign-in state, the calls
// that set it up, and a hook that keeps a list from the server fresh. The page never holds a
// Google token or the client secret: it only learns whether sign-in is set up and done, and asks
// the server (server/google.mjs and each widget's own module) for the data.

export interface GoogleStatus {
  configured: boolean;
  signedIn: boolean;
  email: string;
  /** Scopes the sign-in covers, and whether a widget needs one it doesn't (sign in again to add it). */
  scopes: string[];
  needsConsent: boolean;
}

/** What a Google widget needs from the sign-in, and the words the setup screens use for it. */
export interface GoogleFeature {
  /** "Google Calendar" */
  name: string;
  /** "Calendar API": what to turn on in Google Cloud Console. */
  api: string;
  apiPage: 'google-drive-api' | 'google-calendar-api' | 'google-gmail-api';
  /** The Google scopes it reads with (see GOOGLE_SCOPES in server/google.mjs). */
  scopes: string[];
  /** "your events": what the setup screen says stays private. */
  data: string;
  /** "calendar access": the heading when only that permission is missing. */
  access: string;
  /** "see your calendar events" */
  permission: string;
  /** The box to tick on Google's consent page. */
  box: string;
  /** A line for the consent-screen step, if the scope has to be listed there. */
  consentHint?: string;
}

export const DRIVE_FEATURE: GoogleFeature = {
  name: 'Google Drive',
  api: 'Drive API',
  apiPage: 'google-drive-api',
  scopes: ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.file'],
  data: 'your files',
  access: 'access to your files',
  permission: 'see your Drive files',
  box: 'Drive',
};

export const CALENDAR_FEATURE: GoogleFeature = {
  name: 'Google Calendar',
  api: 'Calendar API',
  apiPage: 'google-calendar-api',
  scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
  data: 'your events',
  access: 'calendar access',
  permission: 'see your calendar events',
  box: 'Calendar',
  consentHint: 'Under Data access, add the scope “…/auth/calendar.readonly”.',
};

export const GMAIL_FEATURE: GoogleFeature = {
  name: 'Gmail',
  api: 'Gmail API',
  apiPage: 'google-gmail-api',
  scopes: ['https://www.googleapis.com/auth/gmail.metadata'],
  data: 'your mail details',
  access: 'Gmail access',
  permission: 'see who wrote to you (senders, subjects and labels, never the messages themselves)',
  box: 'Gmail',
  consentHint: 'Under Data access, add the scope “…/auth/gmail.metadata”.',
};

/** Whether the sign-in already covers what a widget reads with. */
export const hasGoogleScopes = (status: GoogleStatus, scopes: string[]) => status.signedIn && scopes.every((s) => status.scopes.includes(s));

export async function post<T>(url: string, body: unknown = {}): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Something went wrong. Try again.');
  return data as T;
}

export const google = {
  saveClient: (clientId: string, clientSecret: string) => post<GoogleStatus>('/api/google/client', { clientId, clientSecret }),
  signOut: () => post<GoogleStatus>('/api/google/signout'),
  /**
   * The server opens Google's page in your browser; if it couldn't, the page opens it itself.
   * `scopes` asks for just a widget's own (plus what you've allowed before).
   */
  async signIn(scopes?: string[]) {
    const { url, opened } = await post<{ url: string; opened: boolean }>('/api/google/signin', scopes ? { scopes } : {});
    if (!opened) window.open(url, '_blank', 'noopener');
  },
};

/** Sign-in state. null until the server answers; `reachable` is false when it can't be asked (or isn't this PC). */
export function useGoogle(): { status: GoogleStatus | null; reachable: boolean } {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [reachable, setReachable] = useState(true);
  useEffect(() => {
    let alive = true;
    fetch('/api/google/status')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('unreachable'))))
      .then((s) => alive && (setStatus(s), setReachable(true)))
      .catch(() => alive && setReachable(false));
    // Sign-in finishes in another browser tab; the server tells us when it does.
    const stop = listen('google', (data) => {
      setStatus(JSON.parse(data));
      setReachable(true);
    });
    return () => {
      alive = false;
      stop();
    };
  }, []);
  return { status, reachable };
}

/** Asks the server to open a link in the browser (it only opens the kinds of link that widget shows). */
export function openLink(route: string, url: string) {
  void post(route, { url }).catch(() => {});
}

/** What went wrong, with a code the widget can act on: signin, scope, api, busy, down, label, other. */
export interface GoogleDataError {
  code: string;
  message: string;
}

export const REFRESH_MS = 60_000;

/**
 * Data from one of the server's Google routes, fetched again every minute while the page is
 * visible (and when it comes back). Nothing is fetched while `url` is null. A different url
 * starts with nothing, not the last one's data.
 */
export function useGoogleData<T>(url: string | null, everyMs = REFRESH_MS) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<GoogleDataError | null>(null);
  const [loading, setLoading] = useState(false);
  /** Newer requests win: a slow answer to an old url is dropped. */
  const latest = useRef(0);

  const load = useCallback(async () => {
    if (!url) return;
    const mine = ++latest.current;
    setLoading(true);
    try {
      const r = await fetch(url);
      const d = await r.json().catch(() => ({}));
      if (mine !== latest.current) return;
      if (!r.ok) {
        setError({ code: d.code || 'other', message: d.error || 'Couldn’t load that.' });
        return;
      }
      setError(null);
      setData(d as T);
    } catch {
      if (mine === latest.current) setError({ code: 'other', message: 'Couldn’t reach Uncbox. Is it still running?' });
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    setData(null);
    setError(null);
    if (!url) return;
    void load();
    const tick = () => document.visibilityState === 'visible' && void load();
    const timer = everyMs > 0 ? setInterval(tick, everyMs) : undefined;
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
      latest.current++;
    };
  }, [load, url, everyMs]);

  return { data, error, loading, reload: () => void load() };
}
