import { describe, expect, it } from 'vitest';
import { driveView, fileIcon, fileKind, formatModified } from './drive';

describe('driveView', () => {
  it('keeps the four views and turns anything else into Recent', () => {
    for (const v of ['recent', 'starred', 'shared', 'search']) expect(driveView(v)).toBe(v);
    expect(driveView('')).toBe('recent');
    expect(driveView('trash')).toBe('recent');
  });
});

describe('fileKind and fileIcon', () => {
  it('names Google files and common formats', () => {
    expect(fileKind('application/vnd.google-apps.document')).toBe('Doc');
    expect(fileKind('application/vnd.google-apps.spreadsheet')).toBe('Sheet');
    expect(fileKind('application/vnd.google-apps.presentation')).toBe('Slides');
    expect(fileKind('application/vnd.google-apps.folder')).toBe('Folder');
    expect(fileKind('application/pdf')).toBe('PDF');
    expect(fileKind('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('Word');
    expect(fileKind('image/png')).toBe('Image');
    expect(fileKind('application/octet-stream')).toBe('File');
  });

  it('picks an icon for the kind of file', () => {
    expect(fileIcon('application/vnd.google-apps.folder')).toBe('folder');
    expect(fileIcon('image/jpeg')).toBe('image');
    expect(fileIcon('video/mp4')).toBe('video');
    expect(fileIcon('audio/mpeg')).toBe('music');
    expect(fileIcon('application/pdf')).toBe('file');
  });
});

describe('formatModified', () => {
  const now = new Date(2026, 5, 15, 12, 0);
  it('shows the time for today, the day for this year, and the year before that', () => {
    expect(formatModified(new Date(2026, 5, 15, 9, 5).toISOString(), now)).toMatch(/9:05/);
    expect(formatModified(new Date(2026, 2, 4, 9, 5).toISOString(), now)).not.toMatch(/2026|:/);
    expect(formatModified(new Date(2025, 2, 4, 9, 5).toISOString(), now)).toMatch(/2025/);
  });

  it('shows nothing for a missing or broken date', () => {
    expect(formatModified('', now)).toBe('');
    expect(formatModified('not a date', now)).toBe('');
  });
});
