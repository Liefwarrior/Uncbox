import { describe, expect, it, vi } from 'vitest';
import type { ObsSnapshot } from '../obs';
import { defaultState } from '../state/hydrate';
import { PANEL_IDS, PRESET_IDS, WIDGET_TYPES } from '../state/model';
import { activePreset } from '../state/presets';
import { newWidget } from '../widgets/catalog';
import type { DriveFile } from '../widgets/drive';
import { arrange, buildCommands, classifyQuery, type Command, type PaletteActions, type PaletteContext, recentBoost } from './commands';
import { bump, MAX_RECENT } from './recent';

const fakeActions = (): PaletteActions => ({
  saveClip: vi.fn(),
  watchClip: vi.fn(),
  revealClips: vi.fn(),
  launchTile: vi.fn(),
  openDriveFile: vi.fn(),
  obs: vi.fn(),
  openWeb: vi.fn(() => true),
  primeAudio: vi.fn(),
  callOut: vi.fn(),
  toggleStream: vi.fn(),
  browsePresets: vi.fn(),
});

/** A palette over a fresh default state; the changes the commands make are applied to that state. */
function setup(over: Partial<PaletteContext> = {}) {
  const state = over.state ?? defaultState();
  const actions = over.actions ?? fakeActions();
  const ctx: PaletteContext = {
    mutate: (recipe) => recipe(state),
    mutatePreset: (recipe) => recipe(activePreset(state).data),
    query: '',
    clips: { recording: false, saving: false, clips: [] },
    tiles: null,
    drive: { signedIn: false, results: [] },
    obs: null,
    now: 1_000_000,
    ...over,
    state,
    actions,
  };
  const commands = () => buildCommands(ctx);
  const find = (id: string) => commands().find((c) => c.id === id);
  return { ctx, state, actions, commands, find };
}

const obsSnapshot = (over: Partial<ObsSnapshot> = {}) =>
  ({
    status: 'online',
    connected: true,
    scene: 'Game',
    scenes: ['Game', 'Chatting', 'BRB'],
    record: { active: false, paused: false, timecode: '' },
    ...over,
  }) as ObsSnapshot;

const file = (id: string, name: string): DriveFile => ({
  id,
  name,
  mimeType: 'application/pdf',
  modifiedTime: '',
  webViewLink: `https://drive.example/${id}`,
  hasThumb: false,
  owner: '',
});

describe('presets', () => {
  it('lists every preset but the one showing, then Browse presets', () => {
    const { commands, state } = setup();
    const ids = commands()
      .filter((c) => c.group === 'Presets')
      .map((c) => c.id);
    expect(ids).toEqual([...PRESET_IDS.filter((id) => id !== state.preset).map((id) => `preset:${id}`), 'preset:browse']);
  });

  it('opens the gallery with Browse presets, and finds it by searching for gallery', () => {
    const { find, actions, commands } = setup();
    expect(find('preset:browse')!.title).toBe('Browse presets');
    find('preset:browse')!.run();
    expect(actions.browsePresets).toHaveBeenCalled();
    const sections = arrange(commands(), 'gallery', []);
    expect(sections[0].rows[0].command.id).toBe('preset:browse');
  });

  it('includes your own presets, and switches to one', () => {
    const { state, find } = setup();
    state.custom.push({ id: 'custom-abc', name: 'Night run', base: 'wow', data: structuredClone(state.presets.wow) });
    expect(find('preset:custom-abc')!.title).toBe('Switch to Night run');
    find('preset:custom-abc')!.run();
    expect(state.preset).toBe('custom-abc');
    // Now it is the one showing, so it is left out.
    expect(find('preset:custom-abc')).toBeUndefined();
  });
});

describe('panels and widgets', () => {
  it('offers to hide a shown panel and show a hidden one, and does it', () => {
    const { state, find } = setup();
    const { data } = activePreset(state);
    const shown = PANEL_IDS.find((id) => data.layout.some((i) => i.i === id))!;
    const hidden = PANEL_IDS.find((id) => !data.layout.some((i) => i.i === id))!;
    expect(find(`panel:${shown}`)!.title).toMatch(/^Hide /);
    expect(find(`panel:${hidden}`)!.title).toMatch(/^Show /);

    find(`panel:${hidden}`)!.run();
    expect(activePreset(state).data.layout.some((i) => i.i === hidden)).toBe(true);
    expect(find(`panel:${hidden}`)!.title).toMatch(/^Hide /);
    find(`panel:${shown}`)!.run();
    expect(activePreset(state).data.layout.some((i) => i.i === shown)).toBe(false);
  });

  it('adds a widget of each type, and points at it', () => {
    const { state, commands, find, actions } = setup();
    expect(commands().filter((c) => c.id.startsWith('widget:add:')).map((c) => c.id)).toEqual(WIDGET_TYPES.map((t) => `widget:add:${t}`));
    expect(find('widget:add:clock')!.title).toBe('Add widget: Clock');

    const before = activePreset(state).data.widgets.length;
    find('widget:add:clock')!.run();
    const { widgets, layout } = activePreset(state).data;
    expect(widgets.length).toBe(before + 1);
    expect(layout.some((i) => i.i === widgets.at(-1)!.id)).toBe(true);
    expect(actions.callOut).toHaveBeenCalledWith(widgets.at(-1)!.id);
  });
});

describe('clips and stream mode', () => {
  it('only offers what can be done', () => {
    const none = setup();
    expect(none.find('clip:save')).toBeUndefined();
    expect(none.find('clip:latest')).toBeUndefined();
    expect(none.find('clip:folder')).toBeDefined();
    expect(none.find('stream:toggle')?.shortcut).toBe('F8');

    const clips = [
      { name: 'new.mp4', size: 1, at: 2 },
      { name: 'old.mp4', size: 1, at: 1 },
    ];
    const ready = setup({ clips: { recording: true, saving: false, clips } });
    ready.state.clips.enabled = true;
    expect(ready.find('clip:save')).toBeDefined();
    ready.find('clip:latest')!.run();
    expect(ready.actions.watchClip).toHaveBeenCalledWith('new.mp4');
    ready.find('clip:save')!.run();
    expect(ready.actions.saveClip).toHaveBeenCalled();
    ready.find('stream:toggle')!.run();
    expect(ready.actions.toggleStream).toHaveBeenCalled();
  });

  it('hides Save a clip while one is being saved', () => {
    const busy = setup({ clips: { recording: true, saving: true, clips: [] } });
    busy.state.clips.enabled = true;
    expect(busy.find('clip:save')).toBeUndefined();
  });
});

describe('launcher', () => {
  it('has a command per saved tile, none before the server answers', () => {
    expect(setup().commands().some((c) => c.group === 'Launcher')).toBe(false);
    const tile = { id: 't1', name: 'Notepad', type: 'app' as const, target: 'notepad.exe' };
    const { find, actions } = setup({ tiles: [tile] });
    expect(find('launch:t1')!.title).toBe('Launch Notepad');
    find('launch:t1')!.run();
    expect(actions.launchTile).toHaveBeenCalledWith(tile);
  });
});

describe('web', () => {
  it('classifies the typed text like the Web widget does', () => {
    expect(classifyQuery('example.com/page')).toEqual({ kind: 'url', url: 'https://example.com/page' });
    expect(classifyQuery('localhost:3000')).toEqual({ kind: 'url', url: 'http://localhost:3000/' });
    expect(classifyQuery('best pizza near me')).toEqual({ kind: 'search', url: 'https://www.google.com/search?q=best%20pizza%20near%20me' });
    expect(classifyQuery('best pizza', 'duckduckgo').url).toBe('https://duckduckgo.com/?q=best%20pizza');
    expect(classifyQuery('javascript:alert(1)').kind).toBe('none');
    expect(classifyQuery('file:///c:/secret').kind).toBe('none');
    expect(classifyQuery('   ').kind).toBe('none');
  });

  it('offers nothing without a query, or with a blocked address', () => {
    expect(setup().commands().some((c) => c.group === 'Web')).toBe(false);
    expect(setup({ query: 'javascript:alert(1)' }).commands().some((c) => c.group === 'Web')).toBe(false);
  });

  it('offers to open an address and to search for it; plain words only search', () => {
    const url = setup({ query: 'example.com' });
    expect(url.find('web:open')!.title).toBe('Open example.com in a web widget');
    expect(url.find('web:search')).toBeDefined();
    const words = setup({ query: 'cat videos' });
    expect(words.find('web:open')).toBeUndefined();
    expect(words.find('web:search')!.title).toBe('Search the web for cat videos');
  });

  it('adds a Web widget when there is none, already on the page', () => {
    const { state, find, actions } = setup({ query: 'example.com' });
    find('web:open')!.run();
    const web = activePreset(state).data.widgets.filter((w) => w.type === 'web');
    expect(web).toHaveLength(1);
    expect(web[0].settings.url).toBe('https://example.com/');
    expect(actions.callOut).toHaveBeenCalledWith(web[0].id);
    expect(actions.openWeb).not.toHaveBeenCalled();
  });

  it('reuses the first Web widget, and searches with its engine', () => {
    const state = defaultState();
    const [first, second] = [newWidget('web'), newWidget('web')];
    first.settings.searchEngine = 'duckduckgo';
    activePreset(state).data.widgets.push(first, second);
    const { find, actions } = setup({ state, query: 'cat videos' });
    find('web:search')!.run();
    expect(actions.openWeb).toHaveBeenCalledWith(first.id, 'https://duckduckgo.com/?q=cat%20videos');
    expect(activePreset(state).data.widgets.filter((w) => w.type === 'web')).toHaveLength(2);
  });

  it('falls back to the widget’s saved page when it is not on screen', () => {
    const state = defaultState();
    const web = newWidget('web');
    activePreset(state).data.widgets.push(web);
    const actions = { ...fakeActions(), openWeb: vi.fn(() => false) };
    const { find } = setup({ state, actions, query: 'example.com' });
    find('web:open')!.run();
    expect(web.settings.url).toBe('https://example.com/');
  });
});

describe('drive', () => {
  const results = [file('1', 'Budget.pdf'), file('2', 'Notes.pdf')];

  it('lists results only when signed in and the query is long enough', () => {
    expect(setup({ query: 'bud', drive: { signedIn: false, results } }).commands().some((c) => c.group === 'Drive')).toBe(false);
    expect(setup({ query: 'bu', drive: { signedIn: true, results } }).commands().some((c) => c.group === 'Drive')).toBe(false);
    const ok = setup({ query: 'bud', drive: { signedIn: true, results } });
    expect(ok.commands().filter((c) => c.group === 'Drive').map((c) => c.title)).toEqual(['Budget.pdf', 'Notes.pdf']);
    ok.find('drive:1')!.run();
    expect(ok.actions.openDriveFile).toHaveBeenCalledWith(results[0]);
  });
});

describe('obs', () => {
  it('is left out unless OBS is connected', () => {
    expect(setup().commands().some((c) => c.group === 'OBS')).toBe(false);
    expect(setup({ obs: obsSnapshot({ connected: false }) }).commands().some((c) => c.group === 'OBS')).toBe(false);
  });

  it('switches to the other scenes and toggles recording, but never stops the stream', () => {
    const { commands, find, actions } = setup({ obs: obsSnapshot() });
    expect(commands().filter((c) => c.id.startsWith('obs:scene:')).map((c) => c.title)).toEqual(['Switch OBS to Chatting', 'Switch OBS to BRB']);
    find('obs:scene:BRB')!.run();
    expect(actions.obs).toHaveBeenCalledWith({ type: 'SetCurrentProgramScene', sceneName: 'BRB' });
    expect(find('obs:record')!.title).toBe('Start recording');
    find('obs:record')!.run();
    expect(actions.obs).toHaveBeenCalledWith({ type: 'StartRecord' });
    expect(commands().some((c) => c.group === 'OBS' && /stream/i.test(c.title))).toBe(false);
  });

  it('offers Stop recording while recording', () => {
    const { find, actions } = setup({ obs: obsSnapshot({ record: { active: true, paused: false, timecode: '' } }) });
    expect(find('obs:record')!.title).toBe('Stop recording');
    find('obs:record')!.run();
    expect(actions.obs).toHaveBeenCalledWith({ type: 'StopRecord' });
  });
});

describe('focus timer', () => {
  it('is left out without a Focus timer widget', () => {
    expect(setup().commands().some((c) => c.group === 'Focus timer')).toBe(false);
  });

  it('starts, pauses and resumes the timer', () => {
    const state = defaultState();
    const w = newWidget('focus');
    activePreset(state).data.widgets.push(w);
    const first = setup({ state, now: Date.now() });
    expect(first.find('focus:toggle:main')!.title).toBe('Start the focus timer');
    first.find('focus:toggle:main')!.run();
    expect(first.actions.primeAudio).toHaveBeenCalled();
    expect(w.settings.focusEndsAt).toBeGreaterThan(0);

    // Built again, as the palette does on each render.
    const running = setup({ state, now: Date.now() });
    expect(running.find('focus:toggle:main')!.title).toBe('Pause the focus timer');
    running.find('focus:toggle:main')!.run();
    expect(w.settings.focusEndsAt).toBe(0);
    expect(w.settings.focusLeft).toBeGreaterThan(0);
    expect(setup({ state, now: Date.now() }).find('focus:toggle:main')!.title).toBe('Resume the focus timer');
  });
});

describe('buildCommands', () => {
  it('leaves out disabled commands and runs every provider', () => {
    const { ctx } = setup();
    const extra = () => [
      { id: 'x:on', title: 'On', group: 'X', run: () => {} },
      { id: 'x:off', title: 'Off', group: 'X', enabled: false, run: () => {} },
    ];
    expect(buildCommands(ctx, [extra]).map((c) => c.id)).toEqual(['x:on']);
  });
});

describe('arrange', () => {
  const make = (id: string, title: string, group = 'Presets', extra: Partial<Command> = {}): Command => ({ id, title, group, run: () => {}, ...extra });
  const commands = [
    make('a', 'Save a clip', 'Clips'),
    make('b', 'Open the clips folder', 'Clips'),
    make('c', 'Switch to Pokémon', 'Presets'),
    make('d', 'Show Chat panel', 'Panels'),
  ];
  const ids = (list: Command[], query: string, recent: string[] = []) => arrange(list, query, recent).flatMap((s) => s.rows.map((r) => r.command.id));

  it('lists every heading in its usual order when nothing is typed', () => {
    expect(arrange(commands, '', []).map((s) => s.group)).toEqual(['Presets', 'Panels', 'Clips']);
    expect(ids(commands, '')).toEqual(['c', 'd', 'a', 'b']);
  });

  it('puts recently used commands first under Recent when nothing is typed, latest first', () => {
    const sections = arrange(commands, '', ['d', 'b']);
    expect(sections[0].group).toBe('Recent');
    expect(sections[0].rows.map((r) => r.command.id)).toEqual(['d', 'b']);
    // Not listed twice.
    expect(ids(commands, '', ['d', 'b'])).toEqual(['d', 'b', 'c', 'a']);
  });

  it('forgets recent commands that are gone', () => {
    expect(ids(commands, '', ['gone', 'a'])).toEqual(['a', 'c', 'd', 'b']);
  });

  it('keeps only matches, best first, with the best match’s heading first', () => {
    const sections = arrange(commands, 'clip', []);
    expect(sections.map((s) => s.group)).toEqual(['Clips']);
    expect(sections[0].rows.map((r) => r.command.id)).toEqual(['a', 'b']);
    expect(sections[0].rows[0].positions.length).toBeGreaterThan(0);
    expect(ids(commands, 'zzz')).toEqual([]);
  });

  it('lifts a recent command over an equal match', () => {
    const twins = [make('x', 'Open alpha', 'Clips'), make('y', 'Open alpha', 'Clips')];
    expect(ids(twins, 'open')).toEqual(['x', 'y']);
    expect(ids(twins, 'open', ['y'])).toEqual(['y', 'x']);
  });

  it('puts the latest of several recent commands highest', () => {
    const twins = [make('x', 'Open alpha'), make('y', 'Open alpha'), make('z', 'Open alpha')];
    expect(ids(twins, 'open', ['z', 'x'])).toEqual(['z', 'x', 'y']);
    expect(recentBoost(0)).toBeGreaterThan(recentBoost(1));
  });

  it('finds a command by its heading or keywords, below title matches', () => {
    const list = [make('k', 'Switch scene', 'OBS', { keywords: 'obs record' }), make('t', 'Save a record', 'Clips')];
    expect(ids(list, 'record')).toEqual(['t', 'k']);
    expect(ids(list, 'obs')).toEqual(['k']);
  });

  it('shows live commands whatever is typed, ranks them by their own score, and does not boost them', () => {
    const list = [make('w', 'Open example.com in a web widget', 'Web', { live: 1000 }), make('a', 'Save a clip', 'Clips')];
    expect(ids(list, 'example.com', ['w'])).toEqual(['w']);
    const search = [make('s', 'Search the web for clip', 'Web', { live: -100 }), make('a', 'Save a clip', 'Clips')];
    // The real command comes first, so Enter does what the words say.
    expect(ids(search, 'clip')).toEqual(['a', 's']);
  });

  it('never lists live commands under Recent', () => {
    const list = [make('s', 'Search the web for clip', 'Web', { live: 5 })];
    expect(arrange(list, '', ['s']).map((s) => s.group)).toEqual(['Web']);
  });
});

describe('bump', () => {
  it('puts the id first, once, and keeps the list short', () => {
    expect(bump(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
    expect(bump([], 'a')).toEqual(['a']);
    const many = Array.from({ length: MAX_RECENT }, (_, i) => `c${i}`);
    const next = bump(many, 'new');
    expect(next).toHaveLength(MAX_RECENT);
    expect(next[0]).toBe('new');
    expect(next).not.toContain(`c${MAX_RECENT - 1}`);
  });
});
