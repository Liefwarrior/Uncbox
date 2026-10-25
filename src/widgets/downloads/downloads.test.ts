import { describe, expect, it } from 'vitest';
import { clipLabel, isVerticalClip } from '../../clips/replay';
import { codecLabel, downloadUrl, etaText, qualityLabel, qualityText, speedText, type DownloadItem } from './downloads';

describe('quality text', () => {
  it('shows the resolution, with the frame rate above 30 like sites do', () => {
    expect(qualityLabel({ height: 1080, fps: 60, audioOnly: false })).toBe('1080p60');
    expect(qualityLabel({ height: 2160, fps: 59.94, audioOnly: false })).toBe('2160p60');
    expect(qualityLabel({ height: 720, fps: 30, audioOnly: false })).toBe('720p');
    expect(qualityLabel({ height: 1080, fps: null, audioOnly: false })).toBe('1080p');
    expect(qualityLabel({ height: null, fps: null, audioOnly: false })).toBe('');
    expect(qualityLabel({ height: null, fps: null, audioOnly: true })).toBe('Audio');
  });

  it('names the codec', () => {
    expect(codecLabel('avc1.640028')).toBe('H.264');
    expect(codecLabel('vp09.00.40.08')).toBe('VP9');
    expect(codecLabel('av01.0.12M.08')).toBe('AV1');
    expect(codecLabel('hev1.1.6.L93')).toBe('H.265');
    expect(codecLabel('none')).toBe('');
    expect(codecLabel('')).toBe('');
    expect(codecLabel('theora')).toBe('THEORA');
  });

  it('puts them together as "1080p60 · VP9"', () => {
    const item = { height: 1080, fps: 60, vcodec: 'vp09.00.40.08', audioOnly: false } as DownloadItem;
    expect(qualityText(item)).toBe('1080p60 · VP9');
    expect(qualityText({ ...item, height: null, fps: null, vcodec: '' })).toBe('');
  });
});

describe('speed and time left', () => {
  it('reads plainly', () => {
    expect(speedText(3_200_000)).toBe('3.2 MB/s');
    expect(speedText(840_000)).toBe('840 KB/s');
    expect(speedText(null)).toBe('');
    expect(etaText(65)).toBe('1:05');
    expect(etaText(3723)).toBe('1:02:03');
    expect(etaText(0)).toBe('0:00');
    expect(etaText(null)).toBe('');
  });
});

describe('downloadUrl', () => {
  it('takes web addresses only, never something yt-dlp could read as an option', () => {
    expect(downloadUrl(' https://youtu.be/abc ')).toBe('https://youtu.be/abc');
    for (const bad of ['', '-o x', '--version', 'file:///x.mp4', 'javascript:alert(1)', 'youtube.com/watch', 'https://a.com/a b']) {
      expect(downloadUrl(bad), bad).toBeNull();
    }
  });
});

describe('clip names for downloads', () => {
  it('shows a download by its title and keeps vertical for the clips made that way', () => {
    expect(clipLabel('Downloads/My video [abc].mp4')).toBe('My video [abc]');
    expect(clipLabel('Uncbox 2026-10-18 21-30-05.mp4')).toBe('Uncbox 2026-10-18 21-30-05');
    expect(isVerticalClip('Uncbox 2026-10-18 21-30-05 vertical.mp4')).toBe(true);
    expect(isVerticalClip('Uncbox 2026-10-18 21-30-05 vertical 2.mp4')).toBe(true);
    expect(isVerticalClip('Downloads/How to go vertical [abc].mp4')).toBe(false);
    expect(isVerticalClip('Uncbox 2026-10-18 21-30-05.mp4')).toBe(false);
  });
});
