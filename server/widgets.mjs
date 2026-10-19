// Data for the widgets that need this PC: system load, what's playing, and Windows notifications.
// Each starts only when a widget first asks, so none of it runs for people who don't use them.
//
//   GET /api/system          { cpu, memory: { used, total }, gpu: { name, load, temp, used, total } | null }
//   GET /api/media           what's playing, also pushed as a "media" event when it changes
//   GET /api/notifications   the latest Windows notifications ({ after } for newer ones); this PC only

import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

// ---- system ----

let lastCpu = os.cpus();
function cpuPercent() {
  const now = os.cpus();
  let idle = 0;
  let total = 0;
  now.forEach((c, i) => {
    const before = lastCpu[i]?.times;
    if (!before) return;
    for (const key of Object.keys(c.times)) total += c.times[key] - before[key];
    idle += c.times.idle - before.idle;
  });
  lastCpu = now;
  return total > 0 ? Math.round((1 - idle / total) * 100) : 0;
}

/** NVIDIA cards report through nvidia-smi; other cards just don't show a GPU line. */
let gpuMissing = false;
function gpuStats() {
  if (gpuMissing) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
      { windowsHide: true, timeout: 4000 },
      (err, out) => {
        if (err) {
          gpuMissing = err.code === 'ENOENT';
          return resolve(null);
        }
        const [name, load, temp, used, total] = out.split('\n')[0].split(',').map((s) => s.trim());
        resolve({ name, load: Number(load), temp: Number(temp), used: Number(used) * 1024 * 1024, total: Number(total) * 1024 * 1024 });
      },
    );
  });
}

let systemCache = null;
let systemAt = 0;
async function system() {
  // Several widgets or windows asking at once share one reading.
  if (systemCache && Date.now() - systemAt < 1500) return systemCache;
  systemAt = Date.now();
  systemCache = {
    cpu: cpuPercent(),
    memory: { used: os.totalmem() - os.freemem(), total: os.totalmem() },
    gpu: await gpuStats(),
  };
  return systemCache;
}

// ---- media: Windows' "now playing" (the media flyout's), read by a small PowerShell helper ----

const MEDIA_HELPER = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } | Select-Object -First 1
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$parent = Get-Process -Id ([int]$env:UNCBOX_PARENT)
$last = ''; $lastArt = ''; $art = ''
while (-not $parent.HasExited) {
  $out = @{ playing = $false }
  try {
    $s = $mgr.GetCurrentSession()
    if ($s) {
      $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $key = "$($p.Title)|$($p.Artist)"
      if ($key -ne $lastArt) {
        $lastArt = $key; $art = ''
        if ($p.Thumbnail) {
          $stream = Await ($p.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
          $ms = New-Object System.IO.MemoryStream
          [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream).CopyTo($ms)
          if ($ms.Length -lt 400000) { $art = 'data:' + $stream.ContentType + ';base64,' + [Convert]::ToBase64String($ms.ToArray()) }
        }
      }
      $out = @{ playing = ($s.GetPlaybackInfo().PlaybackStatus -eq 'Playing'); app = $s.SourceAppUserModelId; title = $p.Title; artist = $p.Artist; album = $p.AlbumTitle; art = $art }
    }
  } catch { }
  $json = $out | ConvertTo-Json -Compress
  if ($json -ne $last) { $last = $json; [Console]::Out.WriteLine($json); [Console]::Out.Flush() }
  Start-Sleep -Milliseconds 1000
}
`;

function startHelper(script, onLine) {
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, UNCBOX_PARENT: String(process.pid) } },
  );
  createInterface({ input: child.stdout }).on('line', onLine);
  child.on('error', () => {});
  return child;
}

/** "Spotify.exe" or "308046B0AF4A39CB" → a readable app name where Windows gives one. */
function appName(id) {
  if (!id) return '';
  const base = id.split('!')[0].replace(/\.exe$/i, '');
  const parts = base.split(/[._]/).filter((p) => p && !/^[0-9a-z]{13}$/.test(p));
  return parts.at(-1) ?? base;
}

// ---- notifications: read from Windows' own notification list ----

const NOTIFICATIONS_DB = path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Windows', 'Notifications', 'wpndatabase.db');
const FILETIME_EPOCH_MS = 11644473600000n;

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

/** A toast's texts: the first is its title, the rest its message. Exported for tests. */
export function toastTexts(xml) {
  return [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((m) => decodeXml(m[1]).trim()).filter(Boolean);
}

export { appName };

let sqlite;
async function openNotifications() {
  sqlite ??= await import('node:sqlite').catch(() => null);
  if (!sqlite) throw Object.assign(new Error('Notifications need Node.js 22.5 or newer.'), { status: 501 });
  return new sqlite.DatabaseSync(NOTIFICATIONS_DB, { readOnly: true });
}

async function notifications(after) {
  if (process.platform !== 'win32') throw Object.assign(new Error('Notifications are read from Windows.'), { status: 501 });
  const db = await openNotifications();
  try {
    const q = db.prepare(`
      SELECT n."Order" AS id, n.Payload AS payload, n.ArrivalTime AS at, h.PrimaryId AS app
      FROM Notification n JOIN NotificationHandler h ON h.RecordId = n.HandlerId
      WHERE n.Type = 'toast' AND n."Order" > ?
      ORDER BY n."Order" DESC LIMIT 20`);
    q.setReadBigInts(true);
    return q.all(BigInt(after)).map((r) => {
      const [title = '', ...body] = toastTexts(Buffer.from(r.payload).toString('utf8'));
      return {
        id: Number(r.id),
        app: appName(String(r.app)),
        title,
        body: body.join(' '),
        at: Number(BigInt(r.at) / 10000n - FILETIME_EPOCH_MS),
      };
    });
  } finally {
    db.close();
  }
}

// ---- routes ----

export function createWidgets({ broadcastEvent, isLocal, sendJson }) {
  let media = { playing: false };
  let mediaHelper = null;

  return async function handle(req, res, url) {
    try {
      if (url.pathname === '/api/system') return sendJson(res, 200, await system());
      if (url.pathname === '/api/media') {
        if (process.platform === 'win32' && !mediaHelper) {
          mediaHelper = startHelper(MEDIA_HELPER, (line) => {
            try {
              const m = JSON.parse(line);
              media = { ...m, app: appName(m.app) };
              broadcastEvent('media', media);
            } catch {
              // A partial line; the next poll sends it again.
            }
          });
          mediaHelper.on('exit', () => (mediaHelper = null));
        }
        return sendJson(res, 200, media);
      }
      if (url.pathname === '/api/notifications') {
        // Notifications can be private, so never to another device, even when HOST opens Uncbox to the LAN.
        if (!isLocal(req)) return sendJson(res, 403, { error: 'This PC only' });
        const after = Number(url.searchParams.get('after')) || 0;
        return sendJson(res, 200, { notifications: await notifications(after) });
      }
      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      return sendJson(res, err.status || 500, { error: err.message || 'Widget error' });
    }
  };
}
