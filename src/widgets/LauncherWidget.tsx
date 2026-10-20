import { type FormEvent, useEffect, useState } from 'react';
import { Icon, type IconName } from '../components/Icon';
import type { WidgetSettings } from '../state/model';
import { offerUndo, showNotice } from '../undo';
import { faviconSources, findShortcuts, launchTile, saveTile, type Shortcut, TILE_KINDS, type Tile, type TileDraft, useTiles } from './launcher';

type SetSettings = (patch: Partial<WidgetSettings>) => void;

const GLYPH: Record<Tile['type'], IconName> = { app: 'monitor', folder: 'folder', file: 'file', url: 'globe', steam: 'gamepad' };

/** A small number from some text, to tell a changed icon from the old one in the browser's cache. */
const tag = (text: string) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36);

function TileIcon({ tile }: { tile: Tile }) {
  const sources = tile.type === 'url' ? faviconSources(tile.target) : tile.type === 'app' || tile.type === 'file' ? [`/api/launcher/icon/${tile.id}?v=${tag(tile.target)}`] : [];
  const [tried, setTried] = useState(0);
  useEffect(() => setTried(0), [tile.target]);
  const src = sources[tried];
  return src ? (
    <img className="launch-tile__icon" src={src} alt="" draggable={false} onError={() => setTried((n) => n + 1)} />
  ) : (
    <span className="launch-tile__icon launch-tile__icon--glyph">
      <Icon name={GLYPH[tile.type]} size={28} />
    </span>
  );
}

/** The tiles this widget shows, as buttons. Tiles launch by id: the page never sends a path. */
export function LauncherBody({ s, set, editing, tilesEditing }: { s: WidgetSettings; set: SetSettings; editing: boolean; tilesEditing: boolean }) {
  const all = useTiles();
  const [form, setForm] = useState<TileDraft | null>(null);
  const [busy, setBusy] = useState('');

  const byId = new Map((all ?? []).map((t) => [t.id, t]));
  const ids = s.launcherTiles.filter((id) => byId.has(id));
  const arranging = editing && tilesEditing;

  const launch = async (tile: Tile) => {
    setBusy(tile.id);
    try {
      await launchTile(tile.id);
    } catch (err) {
      showNotice(err instanceof Error ? err.message : `Couldn’t open ${tile.name}.`, true);
    }
    setTimeout(() => setBusy((b) => (b === tile.id ? '' : b)), 600);
  };

  const move = (from: number, by: number) => {
    const next = [...s.launcherTiles];
    const i = next.indexOf(ids[from]);
    const j = next.indexOf(ids[from + by]);
    if (i < 0 || j < 0) return;
    [next[i], next[j]] = [next[j], next[i]];
    set({ launcherTiles: next });
  };

  const remove = (tile: Tile) => {
    const before = s.launcherTiles;
    set({ launcherTiles: before.filter((id) => id !== tile.id) });
    offerUndo(`Removed ${tile.name}`, () => set({ launcherTiles: before }));
  };

  if (form && editing) {
    return (
      <TileForm
        draft={form}
        onCancel={() => setForm(null)}
        onSaved={(tile) => {
          if (!s.launcherTiles.includes(tile.id)) set({ launcherTiles: [...s.launcherTiles, tile.id] });
          setForm(null);
        }}
      />
    );
  }

  if (!all) return null;
  return (
    <ul className="launcher no-drag">
      {ids.map((id, i) => {
        const tile = byId.get(id)!;
        return (
          <li key={id} className="launch-tile-wrap">
            <button
              className={`launch-tile ${busy === id ? 'is-launching' : ''}`}
              title={arranging ? tile.name : `Open ${tile.name}`}
              disabled={!editing || arranging}
              onClick={() => void launch(tile)}
            >
              <TileIcon tile={tile} />
              <span className="launch-tile__label">{tile.name}</span>
            </button>
            {arranging && (
              <span className="launch-tile__tools">
                <button className="icon-btn" title="Move earlier" aria-label="Move earlier" disabled={i === 0} onClick={() => move(i, -1)}>
                  <Icon name="arrowLeft" size={12} />
                </button>
                <button className="icon-btn" title="Move later" aria-label="Move later" disabled={i === ids.length - 1} onClick={() => move(i, 1)}>
                  <Icon name="arrowRight" size={12} />
                </button>
                <button className="icon-btn" title="Change" aria-label="Change" onClick={() => setForm({ id: tile.id, name: tile.name, type: tile.type, target: tile.target })}>
                  <Icon name="pencil" size={12} />
                </button>
                <button className="icon-btn" title="Remove" aria-label="Remove" onClick={() => remove(tile)}>
                  <Icon name="x" size={12} />
                </button>
              </span>
            )}
          </li>
        );
      })}
      {editing && (arranging || !ids.length) && (
        <li className="launch-tile-wrap">
          <button className="launch-tile launch-tile--add" onClick={() => setForm({ name: '', type: 'app', target: '' })}>
            <span className="launch-tile__icon launch-tile__icon--glyph">
              <Icon name="plus" size={28} />
            </span>
            <span className="launch-tile__label">Add</span>
          </button>
        </li>
      )}
    </ul>
  );
}

function TileForm({ draft, onCancel, onSaved }: { draft: TileDraft; onCancel: () => void; onSaved: (tile: Tile) => void }) {
  const [v, setV] = useState(draft);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const kind = TILE_KINDS.find((k) => k.type === v.type)!;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      onSaved(await saveTile(v));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t save that.');
      setSaving(false);
    }
  };

  if (browsing) {
    return (
      <Browse
        onCancel={() => setBrowsing(false)}
        onPick={(s) => {
          setV({ ...v, type: 'app', name: v.name.trim() ? v.name : s.name, target: s.path });
          setBrowsing(false);
        }}
      />
    );
  }

  return (
    <form className="widget-settings no-drag" onSubmit={(e) => void submit(e)}>
      <label>
        Name
        <input data-setup="" value={v.name} maxLength={60} placeholder="Discord" onChange={(e) => setV({ ...v, name: e.target.value })} />
      </label>
      <label>
        Kind
        <select value={v.type} onChange={(e) => setV({ ...v, type: e.target.value as TileDraft['type'] })}>
          {TILE_KINDS.map((k) => (
            <option key={k.type} value={k.type}>
              {k.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        {v.type === 'url' || v.type === 'steam' ? 'Link' : 'Path'}
        <span className="row">
          <input value={v.target} placeholder={kind.placeholder} onChange={(e) => setV({ ...v, target: e.target.value })} />
          {v.type === 'app' && (
            <button className="btn btn--small" type="button" onClick={() => setBrowsing(true)}>
              Browse…
            </button>
          )}
        </span>
      </label>
      {error && <p className="error">{error}</p>}
      <span className="row">
        <button className="btn btn--small btn--accent" type="submit" disabled={saving}>
          {draft.id ? 'Save' : 'Add'}
        </button>
        <button className="btn btn--small" type="button" onClick={onCancel}>
          Cancel
        </button>
      </span>
    </form>
  );
}

/** Start menu shortcuts to pick from, narrowed as you type. */
function Browse({ onPick, onCancel }: { onPick: (s: Shortcut) => void; onCancel: () => void }) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<Shortcut[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      findShortcuts(query)
        .then((list) => alive && (setItems(list), setError('')))
        .catch(() => alive && setError('Couldn’t read the Start menu.'));
    }, 150);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query]);

  return (
    <div className="widget-settings launcher-browse no-drag">
      <span className="row">
        <input data-setup="" autoFocus value={query} placeholder="Search your apps" onChange={(e) => setQuery(e.target.value)} />
        <button className="btn btn--small" type="button" onClick={onCancel}>
          Back
        </button>
      </span>
      {error && <p className="error">{error}</p>}
      {items && !items.length && <p className="muted">No apps found.</p>}
      <ul className="launcher-browse__list">
        {items?.map((s) => (
          <li key={s.path}>
            <button type="button" onClick={() => onPick(s)}>
              {s.name}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
