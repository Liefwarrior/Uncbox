// Reads text off small pictures with Windows' own OCR (Windows.Media.Ocr), for the Stats panel's
// boxes on the game screen. A PowerShell helper starts on first use and stays up: about a quarter
// second to start, then a few milliseconds a picture.
//
//   POST /api/ocr   { images: [base64 PNG or JPEG, …], words? } → { texts: [string, …] }, this PC only
//                   With words: true, also { lines: [[{ text, words: [[text, x, y, w, h], …] }, …], …] }
//                   per picture, positions in the picture's pixels: for reading tables and screens.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const MAX_IMAGES = 16;
const MAX_IMAGE_CHARS = 2_000_000;

const HELPER = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } | Select-Object -First 1
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()
# Each request is "T <base64>" for the text, or "W <base64>" for lines and words with positions (JSON).
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $out = ''
  $words = $line.StartsWith('W ')
  try {
    $ms = New-Object System.IO.MemoryStream(,[Convert]::FromBase64String($line.Substring(2)))
    $ras = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($ms)
    $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ras)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bmp = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
    if ($words) {
      $lines = @($result.Lines | ForEach-Object {
        @{ text = $_.Text; words = @($_.Words | ForEach-Object { ,@($_.Text, [int]$_.BoundingRect.X, [int]$_.BoundingRect.Y, [int]$_.BoundingRect.Width, [int]$_.BoundingRect.Height) }) }
      })
      $out = ConvertTo-Json -InputObject $lines -Compress -Depth 5
    } else {
      $out = $result.Text -replace '\\s+', ' '
    }
  } catch { if ($words) { $out = '[]' } }
  [Console]::Out.WriteLine($out); [Console]::Out.Flush()
}
`;

export function createOcr({ isLocal, sendJson, readBody }) {
  let helper = null;
  /** Replies come back one line per picture, in order. */
  const waiting = [];

  function start() {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(HELPER, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] },
    );
    let ready = false;
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (!ready) {
        ready = line === 'ready';
        return;
      }
      waiting.shift()?.(line.trim());
    });
    child.on('error', () => {});
    child.on('exit', () => {
      if (helper === child) helper = null;
      while (waiting.length) waiting.shift()('');
    });
    // The helper outlives no one: it reads until its input closes, which happens when Uncbox exits.
    return child;
  }

  function read(image, words) {
    helper ??= start();
    return new Promise((resolve) => {
      waiting.push(resolve);
      helper.stdin.write(`${words ? 'W' : 'T'} ${image}\n`);
    });
  }

  return async function handle(req, res) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
    if (!isLocal(req)) return sendJson(res, 403, { error: 'This PC only' });
    if (process.platform !== 'win32') return sendJson(res, 501, { error: 'Reading the screen uses Windows’ own text recognition.' });
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: 'Invalid JSON' });
    }
    const images = Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES) : [];
    if (!images.every((i) => typeof i === 'string' && i.length < MAX_IMAGE_CHARS && /^[A-Za-z0-9+/=]*$/.test(i))) {
      return sendJson(res, 400, { error: 'Images must be base64 PNGs' });
    }
    if (!body.words) {
      const texts = [];
      for (const image of images) texts.push(await read(image, false));
      return sendJson(res, 200, { texts });
    }
    const lines = [];
    for (const image of images) {
      let parsed = [];
      try {
        parsed = JSON.parse((await read(image, true)) || '[]');
      } catch {
        // A picture Windows couldn't read gives no lines.
      }
      // PowerShell turns a one-item list into the item itself.
      lines.push((Array.isArray(parsed) ? parsed : [parsed]).map((l) => ({ ...l, words: Array.isArray(l.words?.[0]) ? l.words : [l.words].filter(Boolean) })));
    }
    return sendJson(res, 200, { texts: lines.map((ls) => ls.map((l) => l.text).join(' ')), lines });
  };
}
