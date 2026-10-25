import { defineWidget } from '../types';
import { DownloadsBody } from './DownloadsWidget';

export const downloads = defineWidget({
  kind: 'downloads',
  name: 'Video downloader',
  hint: 'Save a video at its own quality, with yt-dlp',
  icon: 'download',
  category: 'Media & info',
  keywords: 'youtube download save video yt-dlp ffmpeg clip twitch',
  presets: ['steam', 'desk'],
  w: 6,
  h: 6,
  minW: 3,
  minH: 3,
  defaults: () => ({}),
  body: DownloadsBody,
});
