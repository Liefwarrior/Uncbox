import { describe, expect, it } from 'vitest';
import { DRIVE_FILE_SCOPE, applyEvent, canSaveToDrive } from './drive';

const ev = (over: object) => ({ name: 'a.mp4', sent: 0, total: 0, done: false, error: '', link: '', ...over });

describe('applyEvent', () => {
  it('follows an upload from start to finish', () => {
    let s = applyEvent({}, ev({ sent: 0, total: 100 }));
    expect(s['a.mp4']).toMatchObject({ state: 'uploading', fraction: 0 });
    s = applyEvent(s, ev({ sent: 25, total: 100 }));
    expect(s['a.mp4'].fraction).toBe(0.25);
    s = applyEvent(s, ev({ done: true, link: 'https://drive.google.com/file/d/x/view' }));
    expect(s['a.mp4']).toEqual({ state: 'done', fraction: 1, link: 'https://drive.google.com/file/d/x/view', error: '' });
  });

  it('keeps clips apart, and doesn’t change the old state', () => {
    const before = applyEvent({}, ev({ name: 'a.mp4', sent: 1, total: 2 }));
    const after = applyEvent(before, ev({ name: 'b.mp4', sent: 1, total: 4 }));
    expect(Object.keys(after)).toEqual(['a.mp4', 'b.mp4']);
    expect(Object.keys(before)).toEqual(['a.mp4']);
  });

  it('keeps what went wrong', () => {
    const s = applyEvent({}, ev({ done: true, error: 'Sign in to Google in a Drive widget first.' }));
    expect(s['a.mp4']).toMatchObject({ state: 'error', error: 'Sign in to Google in a Drive widget first.' });
  });

  it('forgets a cancelled upload', () => {
    const s = applyEvent(applyEvent({}, ev({ sent: 1, total: 2 })), ev({ done: true, cancelled: true }));
    expect(s).toEqual({});
  });

  it('never reports more than all of it', () => {
    expect(applyEvent({}, ev({ sent: 30, total: 20 }))['a.mp4'].fraction).toBe(1);
  });
});

describe('canSaveToDrive', () => {
  it('needs a sign-in that covers saving files', () => {
    expect(canSaveToDrive(null)).toBe(false);
    expect(canSaveToDrive({ signedIn: false, scopes: [DRIVE_FILE_SCOPE] })).toBe(false);
    expect(canSaveToDrive({ signedIn: true, scopes: ['openid'] })).toBe(false);
    expect(canSaveToDrive({ signedIn: true, scopes: ['openid', DRIVE_FILE_SCOPE] })).toBe(true);
  });
});
