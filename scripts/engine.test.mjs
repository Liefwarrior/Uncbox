// Deciding whether Uncbox's own streaming engine has to be built (scripts/engine.mjs), the rule
// behind `npm run app:native`. Nothing is built here: only the decisions and the folder lookups.

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cargoEnv, engineExe, engineInputs, engineSourceMtimes, needsEngineBuild, wantsNative } from './engine.mjs';

describe('needsEngineBuild', () => {
  it('builds when the exe is missing', () => {
    expect(needsEngineBuild(null, [1000, 2000])).toBe(true);
    expect(needsEngineBuild(undefined, [1000])).toBe(true);
  });

  it('builds when any source is newer than the exe', () => {
    expect(needsEngineBuild(1500, [1000, 2000, 900])).toBe(true);
    expect(needsEngineBuild(1999, [2000])).toBe(true);
  });

  it('does not build when the exe is as new as its newest source or newer', () => {
    expect(needsEngineBuild(2000, [1000, 2000])).toBe(false);
    expect(needsEngineBuild(5000, [1000, 2000])).toBe(false);
  });

  it('has nothing to build from without the engine’s source, whether or not an exe is there', () => {
    expect(needsEngineBuild(null, [])).toBe(false);
    expect(needsEngineBuild(1000, [])).toBe(false);
  });

  it('looks at engine/src, Cargo.toml and Cargo.lock, and builds into engine/target/release', () => {
    const tail = (p) => p.split(path.sep).slice(-2).join('/');
    expect(engineInputs().map(tail)).toEqual(['engine/src', 'engine/Cargo.toml', 'engine/Cargo.lock']);
    expect(engineExe.split(path.sep).slice(-4).join('/')).toBe('engine/target/release/uncbox-stream.exe');
  });
});

describe('engineSourceMtimes', () => {
  let dir;
  beforeEach(() => void (dir = mkdtempSync(path.join(os.tmpdir(), 'uncbox-engine-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const touch = (file, seconds) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'x');
    utimesSync(file, seconds, seconds);
  };

  it('collects every file under the source folder and the two Cargo files, however deep', () => {
    touch(path.join(dir, 'src', 'main.rs'), 100);
    touch(path.join(dir, 'src', 'deep', 'er', 'mf.rs'), 300);
    touch(path.join(dir, 'Cargo.toml'), 200);
    touch(path.join(dir, 'Cargo.lock'), 150);
    expect(engineSourceMtimes([path.join(dir, 'src'), path.join(dir, 'Cargo.toml'), path.join(dir, 'Cargo.lock')]).sort((a, b) => a - b)).toEqual([100_000, 150_000, 200_000, 300_000]);
  });

  it('skips what is not there (a copy without the engine’s source)', () => {
    expect(engineSourceMtimes([path.join(dir, 'src'), path.join(dir, 'Cargo.toml')])).toEqual([]);
  });

  it('rebuilds after a source is edited, and not before', () => {
    touch(path.join(dir, 'src', 'main.rs'), 100);
    touch(path.join(dir, 'Cargo.toml'), 100);
    const inputs = [path.join(dir, 'src'), path.join(dir, 'Cargo.toml')];
    expect(needsEngineBuild(200_000, engineSourceMtimes(inputs))).toBe(false);
    touch(path.join(dir, 'src', 'main.rs'), 300);
    expect(needsEngineBuild(200_000, engineSourceMtimes(inputs))).toBe(true);
  });
});

describe('wantsNative', () => {
  it('is the flag, and the last one wins', () => {
    expect(wantsNative(['--engine=native'], {})).toBe(true);
    expect(wantsNative(['--windowed', '--ENGINE=Native'], {})).toBe(true);
    expect(wantsNative(['--engine=native', '--engine=ffmpeg'], {})).toBe(false);
    expect(wantsNative(['--engine=ffmpeg', '--engine=native'], {})).toBe(true);
  });

  it('is the variable set by hand when no flag says otherwise', () => {
    expect(wantsNative([], { UNCBOX_STREAM_ENGINE: 'native' })).toBe(true);
    expect(wantsNative(['--engine=ffmpeg'], { UNCBOX_STREAM_ENGINE: 'native' })).toBe(false);
  });

  it('is no for the default and for nonsense', () => {
    expect(wantsNative([], {})).toBe(false);
    expect(wantsNative(['--screen=1'], { UNCBOX_STREAM_ENGINE: 'ffmpeg' })).toBe(false);
    expect(wantsNative(['--engine=turbo'], { UNCBOX_STREAM_ENGINE: 'turbo' })).toBe(false);
    expect(wantsNative(['--engine=turbo'], { UNCBOX_STREAM_ENGINE: 'native' })).toBe(true);
  });
});

describe('cargoEnv', () => {
  let home;
  beforeEach(() => void (home = mkdtempSync(path.join(os.tmpdir(), 'uncbox-cargo-'))));
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('puts cargo’s folder and the winget LLVM-MinGW compiler ahead of PATH, and finds cargo', () => {
    const cargoBin = path.join(home, '.cargo', 'bin');
    const llvm = path.join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages', 'MartinStorsjo.LLVM-MinGW.UCRT_x', 'llvm-mingw-20261020-ucrt-x86_64', 'bin');
    mkdirSync(cargoBin, { recursive: true });
    mkdirSync(llvm, { recursive: true });
    const exec = vi.fn();
    const env = cargoEnv({ LOCALAPPDATA: path.join(home, 'AppData', 'Local'), PATH: '/usr/bin' }, home, exec);
    expect(env.PATH.split(path.delimiter)).toEqual([cargoBin, llvm, '/usr/bin']);
    expect(exec).toHaveBeenCalledWith('cargo', ['--version'], expect.objectContaining({ env }));
  });

  it('is null when there is no cargo to run', () => {
    const exec = vi.fn(() => {
      throw new Error('ENOENT');
    });
    expect(cargoEnv({ LOCALAPPDATA: path.join(home, 'none'), PATH: '' }, home, exec)).toBeNull();
  });
});
