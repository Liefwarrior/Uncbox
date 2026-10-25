// yt-dlp downloads: the arguments, the progress lines, tool detection, the queue and the history.
// yt-dlp, ffmpeg and winget are never run: spawn is replaced by a fake, and the files they would
// make are made by the test itself.

import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDownloadArgs,
  buildWingetArgs,
  cleanPartials,
  clipNameFor,
  createYtdlp,
  errorFrom,
  findTool,
  parseLine,
  parseVersion,
  toolsFor,
  validateUrl,
} from './ytdlp.mjs';

const EXE = process.platform === 'win32' ? '.exe' : '';

describe('validateUrl', () => {
  it('takes http and https addresses', () => {
    expect(validateUrl('https://www.youtube.com/watch?v=abc')).toBe('https://www.youtube.com/watch?v=abc');
    expect(validateUrl('  http://example.com/v  ')).toBe('http://example.com/v');
  });

  it('turns away anything that could be an option, or is not a web address', () => {
    for (const bad of [
      '-o /etc/passwd',
      '--exec calc https://x.com',
      ' --version',
      'file:///C:/secret.mp4',
      'ftp://example.com/a.mp4',
      'javascript:alert(1)',
      'C:\\Users\\me\\a.mp4',
      'https://',
      'https://exa mple.com',
      'https://example.com/a b',
      'https://example.com/\u0000',
      '',
      null,
      42,
      `https://example.com/${'a'.repeat(3000)}`,
    ]) {
      expect(validateUrl(bad), String(bad)).toBeNull();
    }
  });
});

describe('buildDownloadArgs', () => {
  const dir = 'C:\\Videos\\Uncbox\\Downloads';
  const ffmpeg = 'C:\\Tools\\ffmpeg.exe';
  const url = 'https://example.com/watch?v=1';

  it('asks for the best video and audio, sorted by resolution then frame rate, into MP4', () => {
    expect(buildDownloadArgs({ url, dir, ffmpeg })).toEqual([
      '--ignore-config',
      '--newline',
      '--progress',
      '--progress-template', expect.stringMatching(/^download:UBXD \{/),
      '--progress-template', expect.stringMatching(/^postprocess:UBXP \{/),
      '--print', expect.stringMatching(/^before_dl:UBXI \{/),
      '--print', expect.stringMatching(/^after_move:UBXF \{/),
      '--no-simulate',
      '--no-playlist',
      '--windows-filenames',
      '--trim-filenames', '180',
      '-N', '4',
      '-P', dir,
      '-o', '%(title).120s [%(id)s].%(ext)s',
      '--ffmpeg-location', ffmpeg,
      '-f', 'bv*+ba/b',
      '-S', 'res,fps,vcodec:h264,acodec:m4a',
      '--merge-output-format', 'mp4',
      '--',
      url,
    ]);
  });

  it('never caps the resolution or the frame rate', () => {
    const args = buildDownloadArgs({ url, dir, ffmpeg }).join(' ');
    // No height/width/fps limits in the format, no sort field with a limit, no re-encode to a size.
    expect(args).not.toMatch(/\[(height|width|fps|res)\s*[<>]/);
    expect(args).not.toMatch(/(res|fps|height|width)[:~]\d/);
    expect(args).not.toMatch(/--recode|--remux-video|-t /);
    expect(args).toContain('-S res,fps,');
  });

  it('puts the address last, after "--", so it is never read as an option', () => {
    const hostile = 'https://example.com/?--exec=calc';
    const args = buildDownloadArgs({ url: hostile, dir, ffmpeg });
    expect(args.at(-1)).toBe(hostile);
    expect(args.at(-2)).toBe('--');
    expect(args.filter((a) => a === '--')).toHaveLength(1);
  });

  it('takes just the sound for audio only, still at the best quality on offer', () => {
    const args = buildDownloadArgs({ url, dir, ffmpeg, audioOnly: true });
    expect(args.slice(args.indexOf('--ffmpeg-location'))).toEqual(['--ffmpeg-location', ffmpeg, '-f', 'ba/b', '-x', '--', url]);
  });

  it('downloads a playlist only when asked, and only the first 25', () => {
    const args = buildDownloadArgs({ url, dir, ffmpeg, playlist: true });
    expect(args).not.toContain('--no-playlist');
    expect(args.slice(args.indexOf('--yes-playlist'), args.indexOf('--yes-playlist') + 3)).toEqual(['--yes-playlist', '--playlist-items', '1:25']);
  });
});

describe('install commands', () => {
  it('are fixed text for yt-dlp and ffmpeg', () => {
    expect(buildWingetArgs('yt-dlp')).toEqual(['install', '--id', 'yt-dlp.yt-dlp', '-e', '--silent', '--accept-source-agreements', '--accept-package-agreements']);
    expect(buildWingetArgs('ffmpeg')).toEqual(['install', '--id', 'Gyan.FFmpeg', '-e', '--silent', '--accept-source-agreements', '--accept-package-agreements']);
    expect(buildWingetArgs('ffmpeg', true)[0]).toBe('upgrade');
  });

  it('refuse any other name, so no text of the user’s reaches winget', () => {
    expect(buildWingetArgs('yt-dlp; calc')).toBeNull();
    expect(buildWingetArgs('__proto__')).toBeNull();
    expect(toolsFor('both')).toEqual(['yt-dlp', 'ffmpeg']);
    expect(toolsFor('ffmpeg')).toEqual(['ffmpeg']);
    expect(toolsFor('constructor')).toEqual([]);
    expect(toolsFor('--help')).toEqual([]);
  });
});

describe('parseLine', () => {
  it('reads the chosen quality', () => {
    const line = 'UBXI {"h":1080,"fps":60,"vc":"vp09.00.40.08","ac":"opus","id":"abc","title":"A \\"title\\" | here","n":["248","251"]}';
    expect(parseLine(line)).toEqual({
      type: 'info',
      height: 1080,
      fps: 60,
      vcodec: 'vp09.00.40.08',
      acodec: 'opus',
      id: 'abc',
      title: 'A "title" | here',
      streams: 2,
    });
  });

  it('copes with fields yt-dlp does not have ("NA")', () => {
    const info = parseLine('UBXI {"h":"NA","fps":"NA","vc":"NA","ac":"NA","id":"x","title":"T","n":"NA"}');
    expect(info).toMatchObject({ height: null, fps: null, vcodec: '', streams: 1 });
  });

  it('reads progress as a fraction, speed and time left', () => {
    expect(parseLine('UBXD {"s":"downloading","d":2500,"t":10000,"e":"NA","v":1048576.5,"eta":7,"f":"C:\\\\a\\\\x.f137.mp4","p":"C:\\\\a\\\\x.f137.mp4.part"}')).toEqual({
      type: 'progress',
      status: 'downloading',
      fraction: 0.25,
      speed: 1048576.5,
      eta: 7,
      file: 'C:\\a\\x.f137.mp4',
      temp: 'C:\\a\\x.f137.mp4.part',
    });
  });

  it('falls back to the estimated size, and to no fraction when there is none', () => {
    expect(parseLine('UBXD {"s":"downloading","d":50,"t":"NA","e":200,"v":null,"eta":null,"f":"a","p":"a.part"}')).toMatchObject({ fraction: 0.25, speed: null, eta: null });
    expect(parseLine('UBXD {"s":"downloading","d":50,"t":"NA","e":"NA","v":null,"eta":null,"f":"a","p":"a.part"}').fraction).toBeNull();
  });

  it('reads merging and the finished file', () => {
    expect(parseLine('UBXP {"s":"started","pp":"Merger"}')).toEqual({ type: 'post', status: 'started', processor: 'Merger' });
    expect(parseLine('UBXF {"f":"C:\\\\Videos\\\\Downloads\\\\Title [id].mp4"}')).toEqual({ type: 'file', file: 'C:\\Videos\\Downloads\\Title [id].mp4' });
  });

  it('ignores everything else yt-dlp says', () => {
    for (const line of ['[youtube] abc: Downloading webpage', 'UBXD not json', 'UBXI {broken', 'UBXF {"f":"NA"}', 'UBXX {"a":1}', '']) {
      expect(parseLine(line), line).toBeNull();
    }
  });
});

describe('errorFrom and parseVersion', () => {
  it('finds yt-dlp’s last complaint without the site prefix', () => {
    const err = 'WARNING: something\nERROR: [youtube] abc123: Video unavailable\n';
    expect(errorFrom(err)).toBe('Video unavailable');
    expect(errorFrom('ERROR: Unsupported URL: https://x.com')).toBe('Unsupported URL: https://x.com');
    expect(errorFrom('nothing here')).toBe('');
  });

  it('reads the version of each tool', () => {
    expect(parseVersion('yt-dlp', '2026.07.04\n')).toBe('2026.07.04');
    expect(parseVersion('ffmpeg', 'ffmpeg version 7.1-full_build-www.gyan.dev Copyright (c) 2000-2025\nbuilt with gcc')).toBe('7.1-full_build-www.gyan.dev');
    expect(parseVersion('yt-dlp', 'garbage with spaces')).toBe('');
  });
});

/** A fake file system: `files` are paths that exist; folders are what contain them. */
function fakeFs(files) {
  const norm = (p) => p.replaceAll('/', '\\').toLowerCase();
  const all = files.map(norm);
  return {
    stat: async (p) => {
      const n = norm(p);
      if (all.includes(n)) return { isFile: () => true };
      if (all.some((f) => f.startsWith(`${n}\\`))) return { isFile: () => false };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    readdir: async (p) => {
      const n = `${norm(p)}\\`;
      const names = new Set(files.filter((f) => norm(f).startsWith(n)).map((f) => f.slice(n.length).split(/[\\/]/)[0]));
      if (!names.size) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return [...names];
    },
  };
}

describe('findTool', () => {
  const local = 'C:\\Users\\eli\\AppData\\Local';
  const env = (PATH) => ({ PATH, LOCALAPPDATA: local });
  const find = (tool, files, PATH = 'C:\\Windows;C:\\Tools') => findTool(tool, { env: env(PATH), platform: 'win32', fs: fakeFs(files) });

  it('looks on PATH first', async () => {
    const files = ['C:\\Tools\\yt-dlp.exe', `${local}\\Microsoft\\WinGet\\Links\\yt-dlp.exe`];
    expect(await find('yt-dlp', files)).toBe('C:\\Tools\\yt-dlp.exe');
  });

  it('then the shims winget leaves in WinGet\\Links, which a server started before the install does not have on PATH', async () => {
    const files = [`${local}\\Microsoft\\WinGet\\Links\\ffmpeg.exe`];
    expect(await find('ffmpeg', files)).toBe(`${local}\\Microsoft\\WinGet\\Links\\ffmpeg.exe`);
  });

  it('then the package folders, including the one Gyan.FFmpeg unpacks into', async () => {
    const pk = `${local}\\Microsoft\\WinGet\\Packages`;
    const files = [
      `${pk}\\yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe\\yt-dlp.exe`,
      `${pk}\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-7.1-full_build\\bin\\ffmpeg.exe`,
      `${pk}\\Other.Thing_x\\yt-dlp.exe`,
    ];
    expect(await find('yt-dlp', files)).toBe(files[0]);
    expect(await find('ffmpeg', files)).toBe(files[1]);
  });

  it('says nothing when it is nowhere, with no LOCALAPPDATA, or with no PATH at all', async () => {
    expect(await find('yt-dlp', ['C:\\Other\\yt-dlp.exe'])).toBe('');
    expect(await findTool('yt-dlp', { env: {}, platform: 'win32', fs: fakeFs([]) })).toBe('');
  });
});

describe('cleanPartials', () => {
  let tmp;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'uncbox-ytdlp-clean-'));
  });
  afterEach(() => rm(tmp, { recursive: true, force: true }));

  it('removes .part, .ytdl, fragment and lone stream files, and never the finished video', async () => {
    const f = (n) => path.join(tmp, n);
    for (const n of ['A [x].f137.mp4.part', 'A [x].f137.mp4.ytdl', 'A [x].f137.mp4.part-Frag3', 'A [x].f251.webm', 'A [x].mp4', 'B [y].mp4']) {
      await writeFile(f(n), 'x');
    }
    await cleanPartials([f('A [x].f137.mp4.part'), f('A [x].f251.webm')]);
    expect((await readdir(tmp)).sort()).toEqual(['A [x].mp4', 'B [y].mp4']);
  });
});

describe('clipNameFor', () => {
  it('names a file in the Downloads folder as a clip, and nothing else', () => {
    const dl = path.join(os.tmpdir(), 'clips', 'Downloads');
    expect(clipNameFor(path.join(dl, 'Title [id].mp4'), dl)).toBe('Downloads/Title [id].mp4');
    expect(clipNameFor(path.join(dl, 'Song [id].m4a'), dl)).toBe('');
    expect(clipNameFor(path.join(dl, '..', 'Title [id].mp4'), dl)).toBe('');
    expect(clipNameFor('', dl)).toBe('');
  });
});

// ---- the module, with fake programs ----

/** A child process that does nothing until the test makes it. */
function fakeChild(pid) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = pid;
  child.kill = vi.fn();
  child.unref = vi.fn();
  return child;
}

describe('createYtdlp', () => {
  let tmp;
  let events;
  let calls;
  let jobs;
  let winget;
  let dl;
  let local;
  let made;

  /** Starts `yt-dlp` and `ffmpeg` found on PATH (empty files), unless told not to. */
  async function make({ tools = true, wingetExe = false, emitMs = 0 } = {}) {
    const bin = path.join(tmp, 'bin');
    await mkdir(bin, { recursive: true });
    if (tools) for (const t of ['yt-dlp', 'ffmpeg']) await writeFile(path.join(bin, t + EXE), '');
    if (wingetExe) await writeFile(path.join(bin, `winget${EXE}`), '');
    const spawn = vi.fn((file, args, opts) => {
      calls.push({ file, args, opts });
      const name = path.basename(file).replace(/\.exe$/, '');
      const child = fakeChild(100 + calls.length);
      if (name === 'yt-dlp' && args[0] === '--version') {
        setImmediate(() => {
          child.stdout.emit('data', '2026.07.04\n');
          child.emit('close', 0);
        });
      } else if (name === 'ffmpeg') {
        setImmediate(() => {
          child.stdout.emit('data', 'ffmpeg version 7.1 Copyright\n');
          child.emit('close', 0);
        });
      } else if (name === 'yt-dlp') jobs.push(child);
      else if (name === 'winget') winget.push(child);
      else if (name === 'taskkill') setImmediate(() => child.emit('close', 0));
      return child;
    });
    const y = createYtdlp({
      broadcastEvent: (name, data) => events.push([name, data]),
      sendJson: (res, status, body) => Object.assign(res, { status, body }),
      isLocal: (req) => req.local !== false,
      readJson: async (req) => req.body ?? {},
      dataDir: path.join(tmp, 'data'),
      clipsFolder: () => path.join(tmp, 'clips'),
      onFinished: (item) => local.push(item.id),
      spawn,
      env: { PATH: bin, LOCALAPPDATA: path.join(tmp, 'nothing') },
      emitMs,
    });
    made.push(y);
    return y;
  }

  const call = async (y, method, route, body, local = true) => {
    const res = {};
    await y.handle({ method, body, local }, res, new URL(`http://x/api/ytdlp${route}`));
    return res;
  };
  const tick = () => new Promise((r) => setImmediate(r));
  const until = (fn) => vi.waitFor(fn, { timeout: 2000, interval: 5 });

  const INFO = 'UBXI {"h":2160,"fps":60,"vc":"vp09.00.51.08","ac":"opus","id":"abc","title":"Big video","n":["313","251"]}\n';
  const prog = (file, d, t) => `UBXD {"s":"downloading","d":${d},"t":${t},"e":"NA","v":2000000,"eta":5,"f":${JSON.stringify(file)},"p":${JSON.stringify(`${file}.part`)}}\n`;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'uncbox-ytdlp-'));
    events = [];
    calls = [];
    jobs = [];
    winget = [];
    local = [];
    made = [];
    dl =path.join(tmp, 'clips', 'Downloads');
  });
  afterEach(async () => {
    vi.useRealTimers();
    for (const y of made) y.close();
    // Let a download that was still running write its last history entry before the folder goes.
    await new Promise((r) => setTimeout(r, 150));
    await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('reports where the tools are and their versions, cached for a minute', async () => {
    const y = await make();
    const first = (await call(y, 'GET', '')).body;
    expect(first.tools).toMatchObject({
      ytdlp: { found: true, version: '2026.07.04' },
      ffmpeg: { found: true, version: '7.1' },
      winget: false,
    });
    expect(first.tools.helpUrl).toMatch(/yt-dlp\/yt-dlp\/wiki\/Installation/);
    const spawned = calls.length;
    await call(y, 'GET', '');
    expect(calls.length).toBe(spawned);
  });

  it('says so when they are missing, and refuses a download for it', async () => {
    const y = await make({ tools: false });
    expect((await call(y, 'GET', '')).body.tools).toMatchObject({ ytdlp: { found: false }, ffmpeg: { found: false } });
    const id = (await call(y, 'POST', '/download', { url: 'https://example.com/v' })).body.id;
    await until(() => expect(y.snapshot()).resolves.toMatchObject({ queue: [] }));
    const item = (await y.snapshot()).history.find((i) => i.id === id);
    expect(item).toMatchObject({ state: 'error' });
    expect(item.error).toMatch(/isn’t installed/);
  });

  it('answers only the PC it runs on, and turns away bad addresses and wrong verbs', async () => {
    const y = await make();
    expect((await call(y, 'GET', '', undefined, false)).status).toBe(403);
    expect((await call(y, 'POST', '/download', { url: 'https://example.com/v' }, false)).status).toBe(403);
    expect((await call(y, 'POST', '/download', { url: '--version' })).status).toBe(400);
    expect((await call(y, 'POST', '/download', { url: 'file:///C:/x.mp4' })).status).toBe(400);
    expect((await call(y, 'GET', '/download')).status).toBe(405);
    expect((await call(y, 'POST', '/nope')).status).toBe(404);
    expect(jobs).toHaveLength(0);
  });

  it('runs a download, follows its progress and finishes it as a clip', async () => {
    const y = await make();
    const url = 'https://example.com/watch?v=abc';
    const res = await call(y, 'POST', '/download', { url });
    expect(res.status).toBe(200);
    await until(() => expect(jobs).toHaveLength(1));

    // yt-dlp got the clips folder's Downloads folder, the ffmpeg that was found, and the address last.
    const run = calls.find((c) => c.args.includes('--no-simulate'));
    expect(run.args).toEqual(buildDownloadArgs({ url, dir: dl, ffmpeg: path.join(tmp, 'bin', `ffmpeg${EXE}`) }));
    expect(run.opts.shell).toBeUndefined();
    expect(run.opts.windowsHide).toBe(true);

    const child = jobs[0];
    const video = path.join(dl, 'Big video [abc].f313.mp4');
    const audio = path.join(dl, 'Big video [abc].f251.webm');
    child.stdout.emit('data', INFO + prog(video, 50, 100).slice(0, 20));
    child.stdout.emit('data', prog(video, 50, 100).slice(20));
    await tick();
    let item = (await y.snapshot()).queue[0];
    expect(item).toMatchObject({ title: 'Big video', height: 2160, fps: 60, vcodec: 'vp09.00.51.08', state: 'downloading', percent: 25, speed: 2000000, eta: 5 });

    // The audio stream is the second half of the bar.
    child.stdout.emit('data', prog(video, 100, 100) + prog(audio, 50, 100));
    await tick();
    expect((await y.snapshot()).queue[0].percent).toBe(75);

    child.stdout.emit('data', 'UBXP {"s":"started","pp":"Merger"}\n');
    await tick();
    expect((await y.snapshot()).queue[0]).toMatchObject({ state: 'merging', speed: null, eta: null });

    const final = path.join(dl, 'Big video [abc].mp4');
    child.stdout.emit('data', `UBXF {"f":${JSON.stringify(final)}}\n`);
    child.emit('close', 0);
    await until(() => expect(local).toHaveLength(1));

    const snap = await y.snapshot();
    expect(snap.queue).toEqual([]);
    expect(snap.history[0]).toMatchObject({
      state: 'done',
      percent: 100,
      file: 'Big video [abc].mp4',
      name: 'Downloads/Big video [abc].mp4',
      height: 2160,
      fps: 60,
    });
    // The page is told about it as it goes.
    expect(events.some(([n, d]) => n === 'ytdlp' && d.queue[0]?.state === 'merging')).toBe(true);
    expect((await readdir(dl)).length).toBe(0);
  });

  it('lets one download run at a time, in the order they came', async () => {
    const y = await make();
    await call(y, 'POST', '/download', { url: 'https://example.com/a' });
    await call(y, 'POST', '/download', { url: 'https://example.com/b' });
    await until(() => expect(jobs).toHaveLength(1));
    await tick();
    expect(jobs).toHaveLength(1);
    expect((await y.snapshot()).queue.map((i) => i.state)).toEqual(['downloading', 'queued']);

    jobs[0].emit('close', 0);
    await until(() => expect(jobs).toHaveLength(2));
    expect(calls.filter((c) => c.args.includes('--no-simulate')).map((c) => c.args.at(-1))).toEqual(['https://example.com/a', 'https://example.com/b']);
    jobs[1].emit('close', 0);
    await until(() => expect(y.snapshot()).resolves.toMatchObject({ queue: [] }));
  });

  it('does not queue the same address twice', async () => {
    const y = await make();
    expect((await call(y, 'POST', '/download', { url: 'https://example.com/a' })).status).toBe(200);
    expect((await call(y, 'POST', '/download', { url: 'https://example.com/a' })).status).toBe(409);
    expect((await call(y, 'POST', '/download', { url: 'https://example.com/a', audioOnly: true })).status).toBe(200);
  });

  it('takes the reason from yt-dlp when a download fails', async () => {
    const y = await make();
    await call(y, 'POST', '/download', { url: 'https://example.com/a' });
    await until(() => expect(jobs).toHaveLength(1));
    jobs[0].stderr.emit('data', 'ERROR: [generic] a: Unsupported URL: https://example.com/a\n');
    jobs[0].emit('close', 1);
    await until(() => expect(local).toHaveLength(1));
    expect((await y.snapshot()).history[0]).toMatchObject({ state: 'error', error: 'Unsupported URL: https://example.com/a' });
  });

  it('cancels the running download: kills the whole process tree and clears .part files', async () => {
    const y = await make();
    const id = (await call(y, 'POST', '/download', { url: 'https://example.com/a' })).body.id;
    const queued = (await call(y, 'POST', '/download', { url: 'https://example.com/b' })).body.id;
    await until(() => expect(jobs).toHaveLength(1));

    await mkdir(dl, { recursive: true });
    const part = path.join(dl, 'T [a].f137.mp4.part');
    await writeFile(part, 'x');
    await writeFile(path.join(dl, 'T [a].f137.mp4.ytdl'), 'x');
    jobs[0].stdout.emit('data', prog(path.join(dl, 'T [a].f137.mp4'), 10, 100));
    await tick();

    expect((await call(y, 'POST', '/cancel', { id })).status).toBe(200);
    const kill = calls.find((c) => c.file === 'taskkill' || c.file.endsWith('taskkill.exe'));
    if (process.platform === 'win32') expect(kill.args).toEqual(['/PID', String(jobs[0].pid), '/T', '/F']);
    else expect(jobs[0].kill).toHaveBeenCalledWith('SIGKILL');
    jobs[0].emit('close', 1);

    await until(() => expect(local).toContain(id));
    expect((await y.snapshot()).history.find((i) => i.id === id)).toMatchObject({ state: 'cancelled', error: '' });
    expect(await readdir(dl)).toEqual([]);

    // The next one in line starts; cancelling one still waiting never starts it.
    await until(() => expect(jobs).toHaveLength(2));
    const third = (await call(y, 'POST', '/download', { url: 'https://example.com/c' })).body.id;
    expect((await call(y, 'POST', '/cancel', { id: third })).status).toBe(200);
    await until(() => expect(local).toContain(third));
    expect(jobs).toHaveLength(2);
    expect((await call(y, 'POST', '/cancel', { id: 'dl-nope' })).status).toBe(404);
    expect(queued).toBeTruthy();
  });

  it('stops a running download when the server closes', async () => {
    const y = await make();
    await call(y, 'POST', '/download', { url: 'https://example.com/a' });
    await until(() => expect(jobs).toHaveLength(1));
    y.close();
    if (process.platform === 'win32') expect(calls.some((c) => c.args[0] === '/PID' && c.args[1] === String(jobs[0].pid))).toBe(true);
    else expect(jobs[0].kill).toHaveBeenCalled();
  });

  it('keeps the last 50 finished downloads in data/ytdlp.json, and brings them back', async () => {
    const y = await make();
    for (let n = 0; n < 52; n++) {
      await call(y, 'POST', '/download', { url: `https://example.com/v${n}` });
      await until(() => expect(jobs).toHaveLength(n + 1));
      jobs[n].stdout.emit('data', `UBXI {"h":720,"fps":30,"vc":"avc1","ac":"mp4a","id":"i${n}","title":"Video ${n}","n":["1","2"]}\n`);
      jobs[n].emit('close', 0);
      await until(() => expect(local).toHaveLength(n + 1));
    }
    const saved = JSON.parse(await readFile(path.join(tmp, 'data', 'ytdlp.json'), 'utf8'));
    expect(saved.history).toHaveLength(50);
    expect(saved.history[0].title).toBe('Video 51');
    expect(saved.history.at(-1).title).toBe('Video 2');

    const again = await make();
    const snap = await again.snapshot();
    expect(snap.history).toHaveLength(50);
    expect(snap.history[0]).toMatchObject({ title: 'Video 51', state: 'done', height: 720, fps: 30 });
  }, 20_000);

  it('ignores a damaged history file', async () => {
    await mkdir(path.join(tmp, 'data'), { recursive: true });
    await writeFile(path.join(tmp, 'data', 'ytdlp.json'), '{not json');
    const y = await make();
    expect((await y.snapshot()).history).toEqual([]);
  });

  it('clears the list but not the files', async () => {
    const y = await make();
    await call(y, 'POST', '/download', { url: 'https://example.com/a' });
    await until(() => expect(jobs).toHaveLength(1));
    jobs[0].emit('close', 1);
    await until(() => expect(local).toHaveLength(1));
    expect((await y.snapshot()).history).toHaveLength(1);
    await call(y, 'POST', '/clear');
    expect((await y.snapshot()).history).toEqual([]);
    expect(JSON.parse(await readFile(path.join(tmp, 'data', 'ytdlp.json'), 'utf8'))).toEqual({ history: [] });
  });

  it('pushes progress at most four times a second', async () => {
    const y = await make({ emitMs: 250 });
    await call(y, 'POST', '/download', { url: 'https://example.com/a' });
    await until(() => expect(jobs).toHaveLength(1));
    await tick();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(1_000_000);
    const count = () => events.filter(([n]) => n === 'ytdlp').length;
    const file = path.join(dl, 'x.mp4');
    jobs[0].stdout.emit('data', prog(file, 1, 100));
    await tick();
    const first = count();
    for (let n = 2; n < 40; n++) jobs[0].stdout.emit('data', prog(file, n, 100));
    await tick();
    // Within the same quarter second: nothing more than one already queued.
    expect(count()).toBeLessThanOrEqual(first + 1);
    await vi.advanceTimersByTimeAsync(260);
    const after = count();
    expect(after).toBeLessThanOrEqual(first + 2);
    expect((await y.snapshot()).queue[0].percent).toBeGreaterThan(15);
  });

  describe('install', () => {
    const yes = { tool: 'both' };

    it('says so, with a link, when winget is missing', async () => {
      const y = await make({ tools: false });
      const res = await call(y, 'POST', '/install', yes);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'no-winget', helpUrl: 'https://github.com/yt-dlp/yt-dlp/wiki/Installation' });
      expect(winget).toHaveLength(0);
    });

    it('turns away unknown tools', async () => {
      const y = await make({ wingetExe: true });
      expect((await call(y, 'POST', '/install', { tool: 'rm -rf' })).status).toBe(400);
      expect((await call(y, 'POST', '/install', {})).status).toBe(400);
      expect(winget).toHaveLength(0);
    });

    it('runs winget with fixed arguments, one tool after the other, streams its lines and looks again', async () => {
      const y = await make({ tools: false, wingetExe: true });
      expect((await call(y, 'POST', '/install', yes)).status).toBe(200);
      expect((await call(y, 'POST', '/install', yes)).status).toBe(409);
      await until(() => expect(winget).toHaveLength(1));
      const first = calls.find((c) => /winget/.test(c.file));
      expect(first.args).toEqual(buildWingetArgs('yt-dlp'));
      expect(first.opts.shell).toBeUndefined();

      // The tools show up as winget finishes (here: the test puts them there).
      await writeFile(path.join(tmp, 'bin', `yt-dlp${EXE}`), '');
      await writeFile(path.join(tmp, 'bin', `ffmpeg${EXE}`), '');
      winget[0].stdout.emit('data', '\r-\r\\\rFound yt-dlp [yt-dlp.yt-dlp]\r\n  ██████░░░░ 3 MB / 9 MB\r\nSuccessfully installed\r\n');
      winget[0].emit('close', 0);
      await until(() => expect(winget).toHaveLength(2));
      expect(calls.filter((c) => /winget/.test(c.file)).at(-1).args).toEqual(buildWingetArgs('ffmpeg'));
      winget[1].emit('close', 0);

      await until(() => expect(events.filter(([n]) => n === 'ytdlp-install').at(-1)[1].running).toBe(false));
      const lines = events.filter(([n, d]) => n === 'ytdlp-install' && d.line).map(([, d]) => d.line);
      expect(lines).toEqual(['Found yt-dlp [yt-dlp.yt-dlp]', 'Successfully installed']);
      expect(events.filter(([n]) => n === 'ytdlp-install').at(-1)[1].error).toBe('');
      expect((await call(y, 'GET', '')).body.tools).toMatchObject({ ytdlp: { found: true }, ffmpeg: { found: true } });
    });

    it('updates with winget upgrade, and counts "already up to date" as fine', async () => {
      const y = await make({ wingetExe: true });
      await call(y, 'POST', '/install', { tool: 'yt-dlp', upgrade: true });
      await until(() => expect(winget).toHaveLength(1));
      expect(calls.find((c) => /winget/.test(c.file)).args[0]).toBe('upgrade');
      winget[0].emit('close', 0x8a15002b);
      await until(() => expect(events.filter(([n]) => n === 'ytdlp-install').at(-1)[1].running).toBe(false));
      expect(events.filter(([n]) => n === 'ytdlp-install').at(-1)[1].error).toBe('');
    });

    it('reports a failed install', async () => {
      const y = await make({ wingetExe: true });
      await call(y, 'POST', '/install', { tool: 'ffmpeg' });
      await until(() => expect(winget).toHaveLength(1));
      winget[0].emit('close', 1);
      await until(() => expect(events.filter(([n]) => n === 'ytdlp-install').at(-1)[1].running).toBe(false));
      expect(events.filter(([n]) => n === 'ytdlp-install').at(-1)[1].error).toMatch(/Couldn’t install ffmpeg/);
    });
  });
});
