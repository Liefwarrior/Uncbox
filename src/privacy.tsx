import { createContext, type ReactNode, useCallback, useContext, useMemo, useSyncExternalStore } from 'react';
import { type ObsSnapshot, useObs } from './obs';

// While Eli is on air, everything Uncbox draws is public. "Private" is the one signal every widget
// asks before it shows something personal (a subject line, a file name, a path, an address). It is
// separate from the stream mode view (full screen, edit controls hidden), which is only a layout.
// Private is on when ANY of these is true: the stream mode view, OBS streaming or recording, or the
// "On air" switch in the sidebar.

export interface PrivacyInputs {
  streamMode: boolean;
  obsLive: boolean;
  onAir: boolean;
}

/** Why private is on, in the order the sidebar explains it; null when it is off. */
export type PrivateReason = 'obs' | 'stream' | 'manual' | null;

export const privateReason = ({ streamMode, obsLive, onAir }: PrivacyInputs): PrivateReason => (obsLive ? 'obs' : streamMode ? 'stream' : onAir ? 'manual' : null);

/** Whether personal data is hidden: any one of the three signals turns it on. */
export const isPrivate = (inputs: PrivacyInputs): boolean => privateReason(inputs) !== null;

/** Whether OBS is streaming or recording right now (a missing or disconnected OBS is not live). */
export const obsIsLive = (snap: Pick<ObsSnapshot, 'connected' | 'stream' | 'record'> | null): boolean =>
  Boolean(snap?.connected && (snap.stream.active || snap.stream.reconnecting || snap.record.active));

// ---- the manual "On air" switch: remembered in this browser ----

const KEY = 'uncbox.onAir';
let onAirNow: boolean | null = null;
const listeners = new Set<() => void>();

function readOnAir(): boolean {
  if (onAirNow === null) {
    try {
      onAirNow = localStorage.getItem(KEY) === '1';
    } catch {
      onAirNow = false;
    }
  }
  return onAirNow;
}

export function setOnAir(on: boolean) {
  onAirNow = on;
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    // Not remembered, but still on for this session.
  }
  listeners.forEach((l) => l());
}

/** Forgets the in-memory copy so the next read goes to storage again. For tests. */
export function resetOnAirForTests() {
  onAirNow = null;
  listeners.forEach((l) => l());
}

function useOnAir(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    readOnAir,
    () => false,
  );
}

// ---- what widgets read ----

export interface Privacy {
  /** Hide personal data. */
  private: boolean;
  reason: PrivateReason;
  onAir: boolean;
  setOnAir: (on: boolean) => void;
}

const OFF: Privacy = { private: false, reason: null, onAir: false, setOnAir };
const PrivacyContext = createContext<Privacy>(OFF);

/** True while personal data should be hidden. The one thing widgets ask. */
export const usePrivate = (): boolean => useContext(PrivacyContext).private;
export const usePrivacy = (): Privacy => useContext(PrivacyContext);

/** Provides the privacy signal to the whole page. `obs` is for tests that need OBS fixed. */
export function PrivacyProvider({ streamMode, children, obs }: { streamMode: boolean; children: ReactNode; obs?: ObsSnapshot | null }) {
  const live = useObs(obs === undefined);
  const onAir = useOnAir();
  const obsLive = obsIsLive(obs === undefined ? live : obs);
  const reason = privateReason({ streamMode, obsLive, onAir });
  const set = useCallback((on: boolean) => setOnAir(on), []);
  const value = useMemo<Privacy>(() => ({ private: reason !== null, reason, onAir, setOnAir: set }), [reason, onAir, set]);
  return <PrivacyContext.Provider value={value}>{children}</PrivacyContext.Provider>;
}

/** For tests: a fixed signal. */
export function FixedPrivacy({ on, children }: { on: boolean; children: ReactNode }) {
  const value = useMemo<Privacy>(() => ({ private: on, reason: on ? 'manual' : null, onAir: on, setOnAir }), [on]);
  return <PrivacyContext.Provider value={value}>{children}</PrivacyContext.Provider>;
}

// ---- shortening what must stay recognisable but not readable ----

/** The text, or a plain label in its place while private. */
export const hideWhenPrivate = (text: string, on: boolean, label: string): string => (on ? label : text);

/** Just the site of a web address ("mail.google.com"), so a private page's path and query don't show. */
export function siteHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** Replaces any email address or Windows path inside free text, for toasts that could carry either. */
export function scrubText(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'an email address')
    .replace(/[A-Za-z]:[\\/][^\s"'<>|?*]*/g, 'a folder on this PC')
    .replace(/\\\\[^\s"'<>|?*]+/g, 'a network folder');
}
