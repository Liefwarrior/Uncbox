// The "Now playing" widget's side of the server: what's playing on this PC (Windows' media flyout,
// GSMTC), its controls, and the album art. A small PowerShell helper talks to Windows: it prints
// one JSON line a second and takes one JSON command per line on stdin.
//
//   GET  /api/media               what's playing, also pushed as a "media" event when it changes
//   GET  /api/media/art?v=<hash>  the current cover, as a small image
//   POST /api/media/control       { action: toggle | next | previous | seek, position? }; this PC only

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';

// ---- the helper's script ----

export const MEDIA_HELPER = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Drawing
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } | Select-Object -First 1
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$parent = Get-Process -Id ([int]$env:UNCBOX_PARENT)

# Covers are shown small, so anything over 300 px is scaled down (as a JPEG). $null means "send it as it is".
function Shrink($bytes) {
  try {
    $img = [System.Drawing.Image]::FromStream((New-Object System.IO.MemoryStream(,$bytes)))
    if ($img.Width -le 300 -and $img.Height -le 300) { return $null }
    $scale = 300 / [Math]::Max($img.Width, $img.Height)
    $w = [int][Math]::Max(1, [Math]::Round($img.Width * $scale))
    $h = [int][Math]::Max(1, [Math]::Round($img.Height * $scale))
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($img, 0, 0, $w, $h)
    $g.Dispose()
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
    $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
    $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]85)
    $out = New-Object System.IO.MemoryStream
    $bmp.Save($out, $codec, $ep)
    $bmp.Dispose(); $img.Dispose()
    return ,$out.ToArray()
  } catch { return $null }
}

# One command from the page: {"action":"toggle"|"next"|"previous"|"seek","position":seconds}
function Run-Command($line) {
  $c = $line | ConvertFrom-Json
  $s = $mgr.GetCurrentSession()
  if (-not $s) { return }
  switch ($c.action) {
    'toggle' { Await ($s.TryTogglePlayPauseAsync()) ([bool]) | Out-Null }
    'next' { Await ($s.TrySkipNextAsync()) ([bool]) | Out-Null }
    'previous' { Await ($s.TrySkipPreviousAsync()) ([bool]) | Out-Null }
    'seek' { Await ($s.TryChangePlaybackPositionAsync([long]([double]$c.position * 10000000))) ([bool]) | Out-Null }
  }
}

$artKey = ''; $artId = 0; $artTries = 0; $hasArt = $false
$cmd = [Console]::In.ReadLineAsync()
$nextPoll = [DateTime]::UtcNow
while (-not $parent.HasExited) {
  if ($cmd -and $cmd.IsCompleted) {
    $line = $null
    try { $line = $cmd.Result } catch { }
    if ($null -eq $line) { $cmd = $null } else {
      $cmd = [Console]::In.ReadLineAsync()
      try { Run-Command $line } catch { }
      $nextPoll = [DateTime]::UtcNow.AddMilliseconds(300)
    }
  }
  if ([DateTime]::UtcNow -ge $nextPoll) {
    $nextPoll = [DateTime]::UtcNow.AddMilliseconds(1000)
    $out = @{ playing = $false }
    try {
      $s = $mgr.GetCurrentSession()
      if ($s) {
        $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
        $key = "$($p.Title)|$($p.Artist)|$($p.AlbumTitle)"
        # Some apps send the cover a moment after the title, so a track with no cover is tried a few more times.
        if ($key -ne $artKey -or (-not $hasArt -and $artTries -lt 5)) {
          if ($key -ne $artKey) { $artKey = $key; $artTries = 0; $hasArt = $false }
          $artTries++
          if ($p.Thumbnail) {
            try {
              $stream = Await ($p.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
              $ms = New-Object System.IO.MemoryStream
              [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream).CopyTo($ms)
              $bytes = $ms.ToArray()
              $type = $stream.ContentType
              $small = Shrink $bytes
              if ($small) { $bytes = $small; $type = 'image/jpeg' }
              if ($bytes.Length -gt 0 -and $bytes.Length -lt 2000000) {
                $artId++; $hasArt = $true
                [Console]::Out.WriteLine((@{ kind = 'art'; id = $artId; contentType = $type; data = [Convert]::ToBase64String($bytes) } | ConvertTo-Json -Compress))
                [Console]::Out.Flush()
              }
            } catch { }
          }
        }
        $info = $s.GetPlaybackInfo()
        $playing = ($info.PlaybackStatus -eq 'Playing')
        $cs = $info.Controls
        $pos = 0.0; $dur = 0.0
        try {
          $tl = $s.GetTimelineProperties()
          $dur = ($tl.EndTime - $tl.StartTime).TotalSeconds
          $pos = $tl.Position.TotalSeconds
          $age = ([DateTimeOffset]::UtcNow - $tl.LastUpdatedTime).TotalSeconds
          if ($playing -and $age -gt 0 -and $tl.LastUpdatedTime.Year -gt 2000) { $pos += $age }
          if ($dur -gt 0 -and $pos -gt $dur) { $pos = $dur }
        } catch { }
        $out = @{
          playing = $playing; app = $s.SourceAppUserModelId; title = $p.Title; artist = $p.Artist; album = $p.AlbumTitle
          hasArt = $hasArt; artId = $artId
          position = [Math]::Round($pos, 1); duration = [Math]::Round($dur, 1); at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
          controls = @{ playPause = ($cs.IsPlayEnabled -or $cs.IsPauseEnabled); next = $cs.IsNextEnabled; previous = $cs.IsPreviousEnabled; seek = $cs.IsPlaybackPositionEnabled }
        }
      }
    } catch { }
    [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress -Depth 4))
    [Console]::Out.Flush()
  }
  Start-Sleep -Milliseconds 100
}
`;

// ---- what the helper prints ----

const NO_CONTROLS = { playPause: false, next: false, previous: false, seek: false };
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);

/**
 * One line from the helper: a track state ({ kind: 'state', ... }), a cover ({ kind: 'art', id,
 * contentType, bytes }), or null for a partial or garbled line.
 */
export function parseMediaLine(line) {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return null;
  }
  if (!m || typeof m !== 'object') return null;
  if (m.kind === 'art') {
    const bytes = Buffer.from(String(m.data ?? ''), 'base64');
    if (!bytes.length) return null;
    return { kind: 'art', id: num(m.id), contentType: String(m.contentType || 'image/jpeg'), bytes };
  }
  const c = m.controls ?? {};
  return {
    kind: 'state',
    playing: m.playing === true,
    app: String(m.app ?? ''),
    title: String(m.title ?? ''),
    artist: String(m.artist ?? ''),
    album: String(m.album ?? ''),
    hasArt: m.hasArt === true,
    artId: num(m.artId),
    position: num(m.position),
    duration: num(m.duration),
    at: num(m.at),
    controls: { playPause: c.playPause === true, next: c.next === true, previous: c.previous === true, seek: c.seek === true },
  };
}

/** The page's view of a state: a readable app name and the cover's version, without the helper's bookkeeping. */
export function buildSnapshot(state, art, appName) {
  const { kind, hasArt, artId, ...rest } = state;
  return { ...rest, app: appName(state.app), art: hasArt ? art.versionFor(artId) : '' };
}

/**
 * Whether a new reading is worth pushing. The position moves every second while playing, so it
 * only counts when it jumps (a seek) or when a while has passed without any push.
 */
export function shouldBroadcast(prev, next) {
  if (!prev) return true;
  for (const key of ['playing', 'app', 'title', 'artist', 'album', 'art', 'duration']) if (prev[key] !== next[key]) return true;
  for (const key of Object.keys(NO_CONTROLS)) if (prev.controls[key] !== next.controls[key]) return true;
  const expected = prev.playing ? prev.position + (next.at - prev.at) / 1000 : prev.position;
  if (Math.abs(next.position - expected) > 1.5) return true;
  return next.at - prev.at > 15_000;
}

// ---- commands to the helper ----

export const MEDIA_ACTIONS = ['toggle', 'next', 'previous', 'seek'];

/** A request body → a clean command, or null when it isn't one. */
export function normalizeCommand(body) {
  if (!body || !MEDIA_ACTIONS.includes(body.action)) return null;
  if (body.action !== 'seek') return { action: body.action };
  const position = Number(body.position);
  if (body.position == null || !Number.isFinite(position) || position < 0) return null;
  return { action: 'seek', position: Math.round(position * 10) / 10 };
}

/** The line the helper reads from stdin. */
export const encodeCommand = (cmd) => JSON.stringify(cmd);

/** The other end of encodeCommand, as the helper reads it. */
export function decodeCommand(line) {
  try {
    return normalizeCommand(JSON.parse(line));
  } catch {
    return null;
  }
}

// ---- the cover ----

/** The current cover only, kept in memory. Its version changes whenever the picture does. */
export function createArtCache() {
  let current = null;
  return {
    set(id, contentType, bytes) {
      current = { id, contentType, bytes, version: createHash('sha1').update(bytes).digest('hex').slice(0, 12) };
      return current.version;
    },
    clear() {
      current = null;
    },
    /** The version of the cover for the helper's art number, or '' while it hasn't arrived. */
    versionFor(id) {
      return current && current.id === id ? current.version : '';
    },
    /** The cover for a version asked for by the page, or null when it has moved on. */
    get(version) {
      return current && current.version === version ? current : null;
    },
  };
}

// ---- routes ----

function startHelper(onLine) {
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(MEDIA_HELPER, 'utf16le').toString('base64')],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, UNCBOX_PARENT: String(process.pid) } },
  );
  createInterface({ input: child.stdout }).on('line', onLine);
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  return child;
}

export function createMedia({ broadcastEvent, isLocal, sendJson, readJson, appName }) {
  const art = createArtCache();
  let media = null;
  let helper = null;

  // How old the reading is when it leaves, so a page with a different clock can still animate it.
  const stamped = () => ({ ...(media ?? { playing: false, controls: NO_CONTROLS }), age: media?.at ? Math.max(0, Date.now() - media.at) : 0 });

  function onLine(line) {
    const m = parseMediaLine(line);
    if (!m) return;
    if (m.kind === 'art') {
      art.set(m.id, m.contentType, m.bytes);
      // The state that goes with this cover may have been sent before it arrived.
      if (media?.title && media.art === '') {
        media = { ...media, art: art.versionFor(m.id) };
        if (media.art) broadcastEvent('media', stamped());
      }
      return;
    }
    const next = buildSnapshot(m, art, appName);
    const send = shouldBroadcast(media, next);
    media = next;
    if (send) broadcastEvent('media', stamped());
  }

  function ensureHelper() {
    if (process.platform !== 'win32' || helper) return;
    helper = startHelper(onLine);
    helper.on('exit', () => (helper = null));
  }

  return async function handle(req, res, url) {
    try {
      if (url.pathname === '/api/media') {
        ensureHelper();
        return sendJson(res, 200, stamped());
      }
      if (url.pathname === '/api/media/art') {
        const cover = art.get(url.searchParams.get('v') ?? '');
        if (!cover) return sendJson(res, 404, { error: 'No cover' });
        // The version is in the address, so a given address never changes.
        res.writeHead(200, { 'Content-Type': cover.contentType, 'Content-Length': cover.bytes.length, 'Cache-Control': 'public, max-age=31536000, immutable' });
        return res.end(cover.bytes);
      }
      if (url.pathname === '/api/media/control' && req.method === 'POST') {
        // These press the buttons on this PC's music, so never from another device on the LAN.
        if (!isLocal(req)) return sendJson(res, 403, { error: 'This PC only' });
        const cmd = normalizeCommand(await readJson(req));
        if (!cmd) return sendJson(res, 400, { error: 'Unknown control' });
        if (!helper) return sendJson(res, 409, { error: 'Nothing is playing' });
        helper.stdin.write(`${encodeCommand(cmd)}\n`);
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      return sendJson(res, err.status || 500, { error: err.message || 'Media error' });
    }
  };
}
