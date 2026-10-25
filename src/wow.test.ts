import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addonLine, announcement, markWowSeen, seenLine, sendWowLive, SEEN_WITHIN_MS, windowLine, wowExes, wowWindowMatch, type InstallReport, type WowStatus } from './wow';

const install = (over: Partial<WowStatus['installs'][number]> = {}) => ({
  flavor: '_classic_beta_',
  label: 'WoW Forever (beta)',
  path: 'C:\\WoW\\_classic_beta_\\Interface\\AddOns',
  exes: ['WowB.exe'],
  version: '1.2.0',
  addons: { Uncbox: '1.2.0' },
  ...over,
});
const status = (over: Partial<WowStatus> = {}): WowStatus => ({
  bundled: '1.2.0',
  addons: { Uncbox: '1.2.0' },
  preferred: install().path,
  installs: [install()],
  autoInstall: true,
  flavor: '',
  settings: { strip: { enabled: true, corner: 'TOPLEFT' }, modules: { character: true, quests: true, party: true, guild: true, raid: true, loot: true }, lootMinQuality: 2 },
  ...over,
});

describe('the Get set up lines for WoW', () => {
  it('says where the addon stands', () => {
    expect(addonLine(null)).toEqual({ done: false, note: 'Looking for WoW…' });
    expect(addonLine(status({ installs: [] }))).toEqual({ done: false, note: 'WoW wasn’t found on this PC' });
    expect(addonLine(status())).toEqual({ done: true, note: 'Version 1.2.0 in WoW Forever (beta)' });
    expect(addonLine(status({ installs: [install({ version: null })] }))).toEqual({ done: false, note: 'Installing in WoW Forever (beta)…' });
    expect(addonLine(status({ autoInstall: false, installs: [install({ version: null })] }))).toEqual({ done: false, note: 'Not in WoW Forever (beta) yet' });
    expect(addonLine(status({ installs: [install({ version: '1.0.0' })] }))).toEqual({ done: false, note: 'Version 1.0.0, 1.2.0 is ready' });
  });

  it('counts the strip as seen for ten minutes', () => {
    const now = 1_000_000_000_000;
    expect(seenLine(0, now)).toMatchObject({ done: false });
    expect(seenLine(now - 20_000, now)).toEqual({ done: true, note: 'Just now' });
    expect(seenLine(now - 3 * 60_000, now)).toEqual({ done: true, note: '3 minutes ago' });
    expect(seenLine(now - 60_000, now).note).toBe('1 minute ago');
    expect(seenLine(now - SEEN_WITHIN_MS, now).done).toBe(true);
    expect(seenLine(now - SEEN_WITHIN_MS - 1, now)).toMatchObject({ done: false, note: expect.stringContaining('/reload') });
  });

  it('says whether the game window is shown, or could be', () => {
    expect(windowLine(true, false).done).toBe(true);
    expect(windowLine(false, true)).toEqual({ done: false, note: 'WoW is running. Click to show it' });
    expect(windowLine(false, false).note).toMatch(/Start WoW/);
  });
});

describe('what the page does with the addon', () => {
  const report = (action: InstallReport['addons'][number]['action'], path = 'p'): InstallReport => ({ path, flavor: 'f', label: 'l', addons: [{ name: 'Uncbox', action, from: null, to: '1.2.0' }] });

  it('announces a new install with Undo, and an update without', () => {
    expect(announcement([])).toBeNull();
    expect(announcement([report('current')])).toBeNull();
    expect(announcement([report('installed', 'a'), report('installed', 'b')])).toEqual({ message: 'Uncbox installed its WoW addon. Type /reload in WoW.', undo: ['a', 'b'] });
    expect(announcement([report('updated')])).toEqual({ message: 'Uncbox updated its WoW addon to 1.2.0. Type /reload in WoW.', undo: null });
  });

  it('puts the running WoW in the panel by its program name', () => {
    expect(wowWindowMatch('WowClassic.exe')).toEqual({ process: 'WowClassic', title: 'World of Warcraft' });
    expect(wowWindowMatch('wowb.EXE').process).toBe('wowb');
  });

  it('watches for the preferred install’s program first, and the usual ones before WoW is found', () => {
    const era = install({ flavor: '_classic_era_', path: 'era', exes: ['WowClassic.exe'] });
    expect(wowExes(status({ installs: [era, install()] }))).toEqual(['WowB.exe', 'WowClassic.exe']);
    expect(wowExes(null)).toContain('WowClassic.exe');
    expect(wowExes(status({ installs: [] }))).toContain('Wow.exe');
  });
});

describe('sending the strip’s news to the server', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('batches guild and raid messages, and leaves the character alone', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    sendWowLive(1, 'character');
    sendWowLive(5, 'a');
    sendWowLive(7, 'b');
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/wow/live');
    expect(JSON.parse(init.body as string)).toEqual({ messages: [{ kind: 5, text: 'a' }, { kind: 7, text: 'b' }] });
  });

  it('sends a long backlog in several posts, losing nothing', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    for (let i = 0; i < 250; i++) sendWowLive(5, String(i));
    await vi.advanceTimersByTimeAsync(2000);
    const sent = fetchMock.mock.calls.flatMap((c) => JSON.parse(((c as unknown as [string, RequestInit])[1].body as string)).messages);
    expect(sent).toHaveLength(250);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not mind the server being down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('down'))));
    sendWowLive(5, 'a');
    await vi.advanceTimersByTimeAsync(400);
  });
});

describe('seen in game', () => {
  it('is remembered, and not noted more than every few seconds', () => {
    const set = vi.fn();
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: set });
    markWowSeen(9_000_000_000_000);
    markWowSeen(9_000_000_001_000);
    expect(set).toHaveBeenCalledTimes(1);
    markWowSeen(9_000_000_010_000);
    expect(set).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
});
