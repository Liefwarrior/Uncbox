import type { Widget } from '../../state/model';
import { clampZoom, cleanUrl, isSearchEngine } from '../../web';

export type WebSettings = {
  /** The page it is on now (saved, so it comes back after a reload), and the one it starts on. */
  url: string;
  homeUrl: string;
  /** What an address that isn't a web address is searched with (an id from src/web.ts). */
  searchEngine: string;
  /** Leave the back / address / reload bar out, for a clean view on stream. */
  hideToolbar: boolean;
  /** Page zoom in percent, 50 to 200. */
  zoom: number;
};

export const isWebWidget = (w: Widget): w is Widget<WebSettings> => w.kind === 'web';

export const defaultWebSettings = (): WebSettings => ({ url: '', homeUrl: '', searchEngine: 'google', hideToolbar: false, zoom: 100 });

/** A hand-edited or shared file can't make a Web widget open anything but a web page. */
export function cleanWebSettings(s: WebSettings): WebSettings {
  s.url = cleanUrl(s.url);
  s.homeUrl = cleanUrl(s.homeUrl);
  if (!isSearchEngine(s.searchEngine)) s.searchEngine = 'google';
  s.zoom = clampZoom(s.zoom);
  return s;
}
