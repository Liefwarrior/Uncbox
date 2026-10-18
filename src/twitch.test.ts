import { describe, expect, it } from 'vitest';
import { normalizeChannel, parseLine, splitEmotes } from './twitch';

describe('parseLine', () => {
  it('reads tags, prefix, command and the trailing parameter', () => {
    const line =
      '@badge-info=;color=#1E90FF;display-name=Liefwarrior;emotes=25:0-4;id=abc-123 :liefwarrior!liefwarrior@liefwarrior.tmi.twitch.tv PRIVMSG #liefwarrior :Kappa that was close';
    expect(parseLine(line)).toEqual({
      tags: { 'badge-info': '', color: '#1E90FF', 'display-name': 'Liefwarrior', emotes: '25:0-4', id: 'abc-123' },
      prefix: 'liefwarrior!liefwarrior@liefwarrior.tmi.twitch.tv',
      command: 'PRIVMSG',
      params: ['#liefwarrior', 'Kappa that was close'],
    });
  });

  it('unescapes tag values', () => {
    const { tags } = parseLine('@system-msg=5\\sraiders\\:\\shi\\\\ :tmi.twitch.tv USERNOTICE #x');
    expect(tags['system-msg']).toBe('5 raiders; hi\\');
  });

  it('handles lines without tags or a prefix', () => {
    expect(parseLine('PING :tmi.twitch.tv')).toEqual({ tags: {}, prefix: '', command: 'PING', params: ['tmi.twitch.tv'] });
  });
});

describe('splitEmotes', () => {
  it('returns plain text when there are no emotes', () => {
    expect(splitEmotes('hello', undefined)).toEqual([{ kind: 'text', text: 'hello' }]);
  });

  it('splits emotes out of the text in order', () => {
    expect(splitEmotes('Kappa hi Kappa PogChamp', '25:0-4,9-13/88:15-22')).toEqual([
      { kind: 'emote', id: '25', name: 'Kappa' },
      { kind: 'text', text: ' hi ' },
      { kind: 'emote', id: '25', name: 'Kappa' },
      { kind: 'text', text: ' ' },
      { kind: 'emote', id: '88', name: 'PogChamp' },
    ]);
  });

  it('counts code points, so emoji before an emote do not shift it', () => {
    expect(splitEmotes('🔥🔥 Kappa', '25:3-7')).toEqual([
      { kind: 'text', text: '🔥🔥 ' },
      { kind: 'emote', id: '25', name: 'Kappa' },
    ]);
  });

  it('ignores overlapping and malformed ranges', () => {
    expect(splitEmotes('Kappa', '25:0-4,2-3/9:x-y')).toEqual([{ kind: 'emote', id: '25', name: 'Kappa' }]);
  });
});

describe('normalizeChannel', () => {
  it('accepts a name, a #name or a channel link', () => {
    expect(normalizeChannel('  Liefwarrior ')).toBe('liefwarrior');
    expect(normalizeChannel('#liefwarrior')).toBe('liefwarrior');
    expect(normalizeChannel('https://www.twitch.tv/liefwarrior/videos')).toBe('liefwarrior');
  });

  it('rejects anything that cannot be a channel', () => {
    expect(normalizeChannel('a')).toBe('');
    expect(normalizeChannel('not a channel!')).toBe('');
  });
});
