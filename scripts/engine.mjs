// Building Uncbox's own streaming engine (engine/, Rust) for the scripts that need it: `npm run
// app:native` (scripts/app.mjs) and `npm run package` (scripts/package.mjs). The decisions are
// plain functions so scripts/engine.test.mjs can check them; building is the only part that runs
// anything. Setting up the toolchain is described in engine/README.md.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const engineDir = path.join(root, 'engine');
export const engineExe = path.join(engineDir, 'target', 'release', 'uncbox-stream.exe');

/** What a build of the engine reads: the sources and the two files that pin its dependencies. */
export const engineInputs = () => [path.join(engineDir, 'src'), path.join(engineDir, 'Cargo.toml'), path.join(engineDir, 'Cargo.lock')];

/**
 * Whether the engine has to be built (again): its exe is missing (`exeMtime` null or undefined) or
 * older than the newest of its inputs. `sourceMtimes` are the modification times, in ms, of
 * everything under engine/src plus Cargo.toml and Cargo.lock; none at all (a copy without the
 * engine's source) means there is nothing to build from.
 */
export function needsEngineBuild(exeMtime, sourceMtimes) {
  if (!sourceMtimes.length) return false;
  if (exeMtime === null || exeMtime === undefined) return true;
  return exeMtime < Math.max(...sourceMtimes);
}

/**
 * Whether this launch asks for the engine: `--engine=native` (the last --engine= wins), else
 * UNCBOX_STREAM_ENGINE=native set by hand. Same rule as the app itself (native/UncboxShell/StreamEngine.cs).
 */
export function wantsNative(args, env = process.env) {
  const given = args.filter((a) => /^--engine=/i.test(a)).map((a) => a.slice('--engine='.length).trim().toLowerCase()).filter((v) => v === 'native' || v === 'ffmpeg');
  return (given.at(-1) ?? String(env.UNCBOX_STREAM_ENGINE ?? '').trim().toLowerCase()) === 'native';
}

/** The modification times of every file under the engine's inputs. */
export function engineSourceMtimes(inputs = engineInputs()) {
  const times = [];
  for (const input of inputs) {
    if (!existsSync(input)) continue;
    const info = statSync(input);
    if (info.isFile()) times.push(info.mtimeMs);
    else for (const entry of readdirSync(input, { withFileTypes: true, recursive: true })) if (entry.isFile()) times.push(statSync(path.join(entry.parentPath, entry.name)).mtimeMs);
  }
  return times;
}

/** The engine's exe modification time in ms, or null when it isn't built. */
export const engineExeMtime = () => (existsSync(engineExe) ? statSync(engineExe).mtimeMs : null);

/** Whether the engine should be built now. */
export const engineNeedsBuild = () => needsEngineBuild(engineExeMtime(), engineSourceMtimes());

/**
 * A PATH that can build the engine: the one given, with Cargo's per-user folder and the folder of
 * the LLVM-MinGW compiler the winget package installs added when they exist. Returns the env to
 * run cargo with, or null when there is no cargo to be found.
 */
export function cargoEnv(env = process.env, home = os.homedir(), exec = execFileSync) {
  const sep = path.delimiter;
  const cargoBin = path.join(env.CARGO_HOME || path.join(home, '.cargo'), 'bin');
  const extra = [];
  if (existsSync(cargoBin)) extra.push(cargoBin);
  const packages = path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Packages');
  try {
    for (const pkg of readdirSync(packages).filter((n) => n.startsWith('MartinStorsjo.LLVM-MinGW'))) {
      for (const inner of readdirSync(path.join(packages, pkg)).filter((n) => n.startsWith('llvm-mingw'))) {
        const bin = path.join(packages, pkg, inner, 'bin');
        if (existsSync(bin)) extra.push(bin);
      }
    }
  } catch {
    // No winget packages folder: whatever is on PATH has to do.
  }
  const next = { ...env, PATH: [...extra, env.PATH ?? env.Path ?? ''].filter(Boolean).join(sep) };
  delete next.Path;
  try {
    exec('cargo', ['--version'], { env: next, stdio: 'pipe' });
    return next;
  } catch {
    return null;
  }
}

/** Where to read how to get cargo and the compiler. */
export const ENGINE_SETUP_HELP = 'To build it you need Rust and the LLVM-MinGW compiler (both install per user, no admin): see engine/README.md, "Building".';

/**
 * Builds the engine (cargo build --release in engine/). Resolves to { ok, built, message }: `ok`
 * is whether an engine exe can be used afterwards (a stale one counts, with a message), `built`
 * whether this call built it. Never throws and never exits, so the caller can carry on with FFmpeg.
 */
export function ensureEngine({ log = console.log } = {}) {
  const exists = existsSync(engineExe);
  if (!engineNeedsBuild()) return { ok: exists, built: false, message: exists ? '' : 'The engine’s source isn’t here, so it can’t be built.' };
  const env = cargoEnv();
  if (!env) {
    const message = exists
      ? `Uncbox's own streaming engine is out of date and cargo wasn't found to rebuild it, so the older build is used. ${ENGINE_SETUP_HELP}`
      : `Uncbox's own streaming engine isn't built, and cargo (Rust) wasn't found to build it. ${ENGINE_SETUP_HELP}`;
    return { ok: exists, built: false, message };
  }
  log('Building Uncbox’s streaming engine (first run, or it was updated)…');
  try {
    execFileSync('cargo', ['build', '--release', '--quiet'], { cwd: engineDir, env, stdio: 'inherit' });
  } catch {
    const message = exists ? 'Building Uncbox’s streaming engine failed, so the older build is used.' : `Building Uncbox's streaming engine failed. ${ENGINE_SETUP_HELP}`;
    return { ok: exists, built: false, message };
  }
  return { ok: existsSync(engineExe), built: true, message: '' };
}
