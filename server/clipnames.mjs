// What clip files are called. The folder listing and every route that takes a name check against
// NAME, so a request can never reach outside the clips folder or at some other file in it.

/** "Uncbox 2026-10-18 21-30-05.mp4", "... vertical.mp4", and "... 2.mp4" when two land in a second. */
export const NAME = /^Uncbox \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}(?: vertical)?(?: \d+)?\.mp4$/;

/** The folder (inside the clips folder) that yt-dlp downloads go to. */
export const DOWNLOADS = 'Downloads';

/**
 * "Downloads/Some title [abc123].mp4": a video the yt-dlp widget saved. Only one folder level,
 * and no characters Windows forbids in a file name, so it can't reach outside Downloads.
 */
export const DOWNLOAD_NAME = /^Downloads\/(?![. ])[^\\/:*?"<>|\u0000-\u001f]+\.mp4$/;

/** True for any clip the list, player and share routes may touch: one of ours, or a download. */
export const isClipName = (name) => typeof name === 'string' && (NAME.test(name) || DOWNLOAD_NAME.test(name));

/** The kinds the upload route accepts: a normal clip, or a 9:16 short made from one. */
export const KINDS = ['clip', 'vertical'];

const pad = (n) => String(n).padStart(2, '0');

/** `n` is the 2nd, 3rd... clip made in the same second, so they don't overwrite each other. */
export function clipName(d = new Date(), kind = 'clip', n = 1) {
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  return `Uncbox ${date} ${time}${kind === 'vertical' ? ' vertical' : ''}${n > 1 ? ` ${n}` : ''}.mp4`;
}
