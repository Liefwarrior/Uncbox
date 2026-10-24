import { describe, expect, it } from 'vitest';
import {
  MEDIA_HELPER,
  buildSnapshot,
  createArtCache,
  decodeCommand,
  encodeCommand,
  normalizeCommand,
  parseMediaLine,
  shouldBroadcast,
} from './media.mjs';
import { appName } from './widgets.mjs';

const stateLine = (over = {}) =>
  JSON.stringify({
    playing: true,
    app: 'Spotify.exe',
    title: 'Song',
    artist: 'Band',
    album: 'Record',
    hasArt: true,
    artId: 3,
    position: 41.5,
    duration: 180.2,
    at: 1_700_000_000_000,
    controls: { playPause: true, next: true, previous: false, seek: true },
    ...over,
  });

describe('parseMediaLine', () => {
  it('reads a full state line, including the timeline and controls', () => {
    expect(parseMediaLine(stateLine())).toEqual({
      kind: 'state',
      playing: true,
      app: 'Spotify.exe',
      title: 'Song',
      artist: 'Band',
      album: 'Record',
      hasArt: true,
      artId: 3,
      position: 41.5,
      duration: 180.2,
      at: 1_700_000_000_000,
      controls: { playPause: true, next: true, previous: false, seek: true },
    });
  });

  it('fills in the blanks when nothing is playing', () => {
    const m = parseMediaLine('{"playing":false}');
    expect(m).toMatchObject({ kind: 'state', playing: false, title: '', position: 0, duration: 0, hasArt: false });
    expect(m.controls).toEqual({ playPause: false, next: false, previous: false, seek: false });
  });

  it('turns junk numbers into zero and keeps controls strictly on or off', () => {
    const m = parseMediaLine(stateLine({ position: 'x', duration: -4, controls: { next: 1, seek: 'yes' } }));
    expect(m.position).toBe(0);
    expect(m.duration).toBe(0);
    expect(m.controls).toEqual({ playPause: false, next: false, previous: false, seek: false });
  });

  it('reads a cover line into bytes', () => {
    const m = parseMediaLine(JSON.stringify({ kind: 'art', id: 2, contentType: 'image/jpeg', data: Buffer.from([1, 2, 3]).toString('base64') }));
    expect(m).toMatchObject({ kind: 'art', id: 2, contentType: 'image/jpeg' });
    expect([...m.bytes]).toEqual([1, 2, 3]);
  });

  it('skips partial, empty and non-object lines', () => {
    expect(parseMediaLine('{"playing":tr')).toBeNull();
    expect(parseMediaLine('')).toBeNull();
    expect(parseMediaLine('42')).toBeNull();
    expect(parseMediaLine('{"kind":"art","id":1,"data":""}')).toBeNull();
  });
});

describe('commands', () => {
  it('survives the trip to the helper and back', () => {
    for (const cmd of [{ action: 'toggle' }, { action: 'next' }, { action: 'previous' }, { action: 'seek', position: 95.5 }]) {
      expect(decodeCommand(encodeCommand(cmd))).toEqual(cmd);
    }
    expect(encodeCommand({ action: 'seek', position: 12 })).toBe('{"action":"seek","position":12}');
  });

  it('is one line, so the helper reads one command per line', () => {
    expect(encodeCommand({ action: 'seek', position: 1 })).not.toContain('\n');
  });

  it('refuses anything that is not a control', () => {
    expect(normalizeCommand({ action: 'stop' })).toBeNull();
    expect(normalizeCommand(null)).toBeNull();
    expect(normalizeCommand({ action: 'seek' })).toBeNull();
    expect(normalizeCommand({ action: 'seek', position: -3 })).toBeNull();
    expect(normalizeCommand({ action: 'seek', position: 'soon' })).toBeNull();
    expect(decodeCommand('not json')).toBeNull();
  });

  it('drops a stray position from the other actions', () => {
    expect(normalizeCommand({ action: 'next', position: 5, extra: 1 })).toEqual({ action: 'next' });
  });

  it('is understood by the helper script', () => {
    for (const word of ['TryTogglePlayPauseAsync', 'TrySkipNextAsync', 'TrySkipPreviousAsync', 'TryChangePlaybackPositionAsync', 'GetTimelineProperties']) {
      expect(MEDIA_HELPER).toContain(word);
    }
  });
});

describe('art cache', () => {
  it('versions a cover by its bytes', () => {
    const cache = createArtCache();
    const a = cache.set(1, 'image/jpeg', Buffer.from('one'));
    const same = cache.set(2, 'image/jpeg', Buffer.from('one'));
    const b = cache.set(3, 'image/png', Buffer.from('two'));
    expect(a).toBe(same);
    expect(b).not.toBe(a);
    expect(b).toMatch(/^[0-9a-f]{12}$/);
  });

  it('serves only the current version', () => {
    const cache = createArtCache();
    const old = cache.set(1, 'image/jpeg', Buffer.from('one'));
    const now = cache.set(2, 'image/png', Buffer.from('two'));
    expect(cache.get(old)).toBeNull();
    expect(cache.get(now)).toMatchObject({ contentType: 'image/png' });
    expect(cache.get('')).toBeNull();
  });

  it('has no version for a track whose cover has not arrived yet', () => {
    const cache = createArtCache();
    const v = cache.set(4, 'image/jpeg', Buffer.from('x'));
    expect(cache.versionFor(4)).toBe(v);
    expect(cache.versionFor(5)).toBe('');
    cache.clear();
    expect(cache.versionFor(4)).toBe('');
  });

  it('puts the version in the snapshot, and leaves the helper bookkeeping out', () => {
    const cache = createArtCache();
    const v = cache.set(3, 'image/jpeg', Buffer.from('x'));
    const snap = buildSnapshot(parseMediaLine(stateLine()), cache, appName);
    expect(snap).toMatchObject({ app: 'Spotify', title: 'Song', art: v, position: 41.5 });
    expect(snap).not.toHaveProperty('hasArt');
    expect(snap).not.toHaveProperty('artId');
    expect(buildSnapshot(parseMediaLine(stateLine({ hasArt: false })), cache, appName).art).toBe('');
    expect(buildSnapshot(parseMediaLine(stateLine({ artId: 9 })), cache, appName).art).toBe('');
  });
});

describe('shouldBroadcast', () => {
  const cache = createArtCache();
  const snap = (over) => buildSnapshot(parseMediaLine(stateLine(over)), cache, appName);
  const base = snap({});

  it('always sends the first reading', () => {
    expect(shouldBroadcast(null, base)).toBe(true);
  });

  it('stays quiet while the position just ticks along', () => {
    expect(shouldBroadcast(base, snap({ position: 42.5, at: base.at + 1000 }))).toBe(false);
  });

  it('sends a new track, a pause or a change of controls', () => {
    expect(shouldBroadcast(base, snap({ title: 'Other', at: base.at + 1000 }))).toBe(true);
    expect(shouldBroadcast(base, snap({ playing: false, at: base.at + 1000 }))).toBe(true);
    expect(shouldBroadcast(base, snap({ controls: { playPause: true }, at: base.at + 1000 }))).toBe(true);
  });

  it('sends a seek, and an occasional refresh', () => {
    expect(shouldBroadcast(base, snap({ position: 120, at: base.at + 1000 }))).toBe(true);
    expect(shouldBroadcast(base, snap({ position: 41.5 + 20, at: base.at + 20_000 }))).toBe(true);
  });

  it('does not expect a paused track to move', () => {
    const paused = snap({ playing: false });
    expect(shouldBroadcast(paused, snap({ playing: false, position: 43.5, at: paused.at + 2000 }))).toBe(true);
    expect(shouldBroadcast(paused, snap({ playing: false, at: paused.at + 2000 }))).toBe(false);
  });
});
