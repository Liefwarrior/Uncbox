// The clip hotkey, pressed while a game has focus. Browsers only see keys while their own window
// is in front, so on Windows a small helper watches the one key Uncbox asks for and reports each
// press. It reads the key's state rather than registering a hotkey, so the key still reaches the
// game and every other app (typing "=" in chat keeps working), and it never sees any other key.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/** KeyboardEvent.code → Windows virtual-key code, for the keys src/clips/keys.ts offers. */
export function vkFor(code) {
  if (typeof code !== 'string') return 0;
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1].charCodeAt(0);
  if ((m = /^Digit(\d)$/.exec(code))) return 0x30 + Number(m[1]);
  if ((m = /^Numpad(\d)$/.exec(code))) return 0x60 + Number(m[1]);
  if ((m = /^F(\d{1,2})$/.exec(code)) && Number(m[1]) >= 1 && Number(m[1]) <= 24) return 0x6f + Number(m[1]);
  return VK[code] ?? 0;
}

const VK = {
  Equal: 0xbb,
  Minus: 0xbd,
  Comma: 0xbc,
  Period: 0xbe,
  Semicolon: 0xba,
  Slash: 0xbf,
  Backquote: 0xc0,
  BracketLeft: 0xdb,
  Backslash: 0xdc,
  BracketRight: 0xdd,
  Quote: 0xde,
  NumpadMultiply: 0x6a,
  NumpadAdd: 0x6b,
  NumpadSubtract: 0x6d,
  NumpadDecimal: 0x6e,
  NumpadDivide: 0x6f,
  Insert: 0x2d,
  Delete: 0x2e,
  Home: 0x24,
  End: 0x23,
  PageUp: 0x21,
  PageDown: 0x22,
  Pause: 0x13,
  ScrollLock: 0x91,
};

// Polls the key every 15 ms and prints "press" on each new press with no Shift, Ctrl, Alt or
// Windows key held (so Shift+= for "+" doesn't clip). It exits on its own once Uncbox is gone.
const HELPER = `
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class UncboxClipKey {
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
  static bool Down(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }
  public static void Run(int vk, int parent) {
    Process owner = Process.GetProcessById(parent);
    Console.Out.WriteLine("ready");
    Console.Out.Flush();
    bool was = true;
    for (int i = 0; ; i++) {
      Thread.Sleep(15);
      if (i % 64 == 0 && owner.HasExited) return;
      bool down = Down(vk);
      if (down && !was && !Down(0x10) && !Down(0x11) && !Down(0x12) && !Down(0x5B) && !Down(0x5C)) {
        Console.Out.WriteLine("press");
        Console.Out.Flush();
      }
      was = down;
    }
  }
}
'@
[UncboxClipKey]::Run([int]$env:UNCBOX_VK, [int]$env:UNCBOX_PARENT)
`;

/**
 * Watches one key and calls onPress for each press. status() is 'on' once the helper runs,
 * 'starting' before, 'off' with no key, and 'unsupported' off Windows or if the helper can't run.
 */
export function createHotkey({ onPress, onStatus = () => {} }) {
  let child = null;
  let vk = 0;
  let status = process.platform === 'win32' ? 'off' : 'unsupported';
  const set = (s) => {
    if (s === status) return;
    status = s;
    onStatus(s);
  };

  const stop = () => {
    if (!child) return;
    child.removeAllListeners('exit');
    child.kill();
    child = null;
  };

  const start = () => {
    set('starting');
    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(HELPER, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, UNCBOX_VK: String(vk), UNCBOX_PARENT: String(process.pid) } },
    );
    child = proc;
    let errors = '';
    proc.stderr.on('data', (d) => (errors += d));
    createInterface({ input: proc.stdout }).on('line', (line) => {
      if (line === 'ready') set('on');
      else if (line === 'press') onPress();
    });
    proc.on('error', () => {});
    proc.on('exit', () => {
      if (child !== proc) return;
      child = null;
      if (errors.trim()) console.warn(`Uncbox: the clip hotkey stopped: ${errors.trim().split('\n')[0]}`);
      set('unsupported');
    });
  };

  return {
    status: () => status,
    /** Watches this key (a KeyboardEvent.code), or nothing for an empty or unknown one. */
    watch(code) {
      if (process.platform !== 'win32') return;
      const next = vkFor(code);
      if (next === vk && (child || !next)) return;
      vk = next;
      stop();
      if (vk) start();
      else set('off');
    },
    close: stop,
  };
}
