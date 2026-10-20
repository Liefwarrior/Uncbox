import { type CSSProperties, useState } from 'react';
import { useBoard } from '../components/Board';
import { Icon } from '../components/Icon';
import { Panel } from '../components/Panel';
import type { Widget, WidgetSettings } from '../state/model';
import type { MutatePreset } from '../state/useAppState';
import { type ObsSnapshot, useObs } from '../obs';
import { WIDGET_INFO, widgetTitle } from './catalog';
import { DriveBody, DriveSettings } from './DriveWidget';
import { describeWeather, findPlace, useMedia, useNetstats, useNotifications, useSystem, useWeather, type PingStats } from './data';
import { fpsTone, pingTone, SPARK_H, SPARK_W, sparkline, type Tone } from './netstats';
import { ObsBody } from './ObsWidget';
import { FocusBody, FocusSettings } from './FocusWidget';
import { LauncherBody } from './LauncherWidget';
import { useNow } from './useNow';
import { WebPanel } from './WebWidget';

interface Props {
  widget: Widget;
  mutatePreset: MutatePreset;
}

type SetSettings = (patch: Partial<WidgetSettings>) => void;

/** One widget from the library, in a panel like any other. Settings open from its ⋯ menu. */
export function WidgetPanel(props: Props) {
  return props.widget.type === 'web' ? <WebPanel {...props} /> : <SimpleWidgetPanel {...props} />;
}

function SimpleWidgetPanel({ widget, mutatePreset }: Props) {
  const { editing } = useBoard();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tilesEditing, setTilesEditing] = useState(false);
  const s = widget.settings;
  const edit = (recipe: (w: Widget) => void) =>
    mutatePreset((d) => {
      const w = d.widgets.find((x) => x.id === widget.id);
      if (w) recipe(w);
    });
  const set: SetSettings = (patch) => edit((w) => void Object.assign(w.settings, patch));
  // OBS keeps its connection settings on the server, so its form is its own ("OBS connection" in the menu).
  const obs = useObs(widget.type === 'obs');
  const hasSettings = !['media', 'system', 'obs', 'launcher'].includes(widget.type);
  const unset =
    (widget.type === 'weather' && !s.lat && !s.lon) ||
    (widget.type === 'countdown' && !s.target) ||
    (widget.type === 'text' && !s.text.trim()) ||
    // Nothing to show viewers while OBS isn't there.
    (widget.type === 'obs' && !obs?.connected) ||
    (widget.type === 'launcher' && !s.launcherTiles.length);

  return (
    <Panel
      id={widget.id}
      className={`panel--widget widget--${widget.type}`}
      label={widgetTitle(widget)}
      empty={unset && !settingsOpen}
      title={
        editing ? (
          <input
            className="ghost-input panel__title-input"
            value={widget.title}
            placeholder={WIDGET_INFO[widget.type].name}
            onChange={(e) => edit((w) => void (w.title = e.target.value))}
          />
        ) : (
          widgetTitle(widget)
        )
      }
      menu={
        hasSettings || widget.type === 'obs'
          ? [{ label: widget.type === 'obs' ? 'OBS connection' : settingsOpen ? 'Close settings' : 'Settings', icon: 'list', onSelect: () => setSettingsOpen((o) => !o) }]
          : widget.type === 'launcher'
            ? [{ label: tilesEditing ? 'Done editing tiles' : 'Edit tiles', icon: 'pencil', onSelect: () => setTilesEditing((o) => !o) }]
            : undefined
      }
    >
      {widget.type === 'drive' && settingsOpen ? (
        // Signing out and replacing the client work outside edit mode too.
        <DriveSettings onDone={() => setSettingsOpen(false)} />
      ) : editing && (settingsOpen || unset) && hasSettings && widget.type !== 'drive' ? (
        <Settings widget={widget} set={set} onDone={() => setSettingsOpen(false)} />
      ) : (
        <Body
          widget={widget}
          set={set}
          editing={editing}
          tilesEditing={tilesEditing}
          obs={obs}
          setup={settingsOpen}
          onSetupDone={() => setSettingsOpen(false)}
        />
      )}
    </Panel>
  );
}

interface BodyProps {
  widget: Widget;
  set: SetSettings;
  editing: boolean;
  tilesEditing: boolean;
  obs: ObsSnapshot | null;
  setup: boolean;
  onSetupDone: () => void;
}

function Body({ widget, set, editing, tilesEditing, obs, setup, onSetupDone }: BodyProps) {
  const s = widget.settings;
  switch (widget.type) {
    case 'clock':
      return <Clock s={s} />;
    case 'weather':
      return <WeatherBody s={s} />;
    case 'media':
      return <MediaBody />;
    case 'notifications':
      return <NotificationsBody s={s} />;
    case 'system':
      return <SystemBody />;
    case 'network':
      return <NetworkBody s={s} />;
    case 'countdown':
      return <Countdown s={s} />;
    case 'focus':
      return <FocusBody s={s} set={set} editing={editing} />;
    case 'launcher':
      return <LauncherBody s={s} set={set} editing={editing} tilesEditing={tilesEditing} />;
    case 'text':
      return <p className="widget-text">{s.text}</p>;
    case 'obs':
      return <ObsBody obs={obs} setup={setup} onSetupDone={onSetupDone} />;
    case 'web':
      return null; // its own panel, see WebWidget.tsx
    case 'drive':
      return <DriveBody s={s} set={set} />;
  }
}

function Clock({ s }: { s: WidgetSettings }) {
  const now = useNow(s.seconds ? 1000 : 60_000);
  const zone = s.timeZone || undefined;
  let time: string;
  let date: string;
  try {
    time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: s.seconds ? '2-digit' : undefined, hour12: s.hour12, timeZone: zone }).format(now);
    date = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric', timeZone: zone }).format(now);
  } catch {
    return <p className="muted">Unknown time zone: {s.timeZone}</p>;
  }
  return (
    <div className="widget-clock">
      <strong>{time}</strong>
      <span>
        {date}
        {zone && ` · ${zone.split('/').pop()!.replace(/_/g, ' ')}`}
      </span>
    </div>
  );
}

function Countdown({ s }: { s: WidgetSettings }) {
  const now = useNow(1000);
  const left = Math.max(0, s.target - now);
  const d = Math.floor(left / 86_400_000);
  const h = Math.floor(left / 3_600_000) % 24;
  const m = Math.floor(left / 60_000) % 60;
  const sec = Math.floor(left / 1000) % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    <div className="widget-countdown">
      <strong>{left === 0 ? 'Now!' : `${d > 0 ? `${d}d ` : ''}${pad(h)}:${pad(m)}:${pad(sec)}`}</strong>
      {s.text && <span>{s.text}</span>}
    </div>
  );
}

function WeatherBody({ s }: { s: WidgetSettings }) {
  const w = useWeather(s);
  if (!w) return <p className="muted">Getting the weather for {s.place}…</p>;
  const [label, symbol] = describeWeather(w.code, w.day);
  return (
    <div className="widget-weather">
      <span className="widget-weather__symbol" aria-hidden="true">
        {symbol}
      </span>
      <div>
        <strong>{w.temp}°</strong>
        <span>
          {label} · {w.high}° / {w.low}°
        </span>
        <small>{s.place.split(',')[0]}</small>
      </div>
    </div>
  );
}

function MediaBody() {
  const m = useMedia();
  if (!m) return null;
  if (!m.title) return <p className="muted">Nothing is playing.</p>;
  return (
    <div className={`widget-media ${m.playing ? 'is-playing' : ''}`}>
      {m.art ? <img src={m.art} alt="" /> : <span className="widget-media__art"><Icon name="music" size={22} /></span>}
      <div>
        <strong>{m.title}</strong>
        <span>{[m.artist, m.album].filter(Boolean).join(' · ')}</span>
        {!m.playing && <small>Paused</small>}
      </div>
    </div>
  );
}

function NotificationsBody({ s }: { s: WidgetSettings }) {
  const { toasts, error } = useNotifications(s.apps);
  if (error) return <p className="error">{error}</p>;
  if (!toasts.length) return <p className="muted">New notifications show up here.</p>;
  return (
    <ol className="widget-toasts">
      {toasts.map((t) => (
        <li key={t.id}>
          <span className="widget-toasts__app">{t.app}</span>
          <strong>{t.title}</strong>
          {s.showBody && t.body && <p>{t.body}</p>}
        </li>
      ))}
    </ol>
  );
}

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

function Meter({ label, value, detail }: { label: string; value: number; detail: string }) {
  return (
    <div className="meter" style={{ '--v': `${Math.min(100, Math.max(0, value))}%` } as CSSProperties}>
      <span className="meter__label">{label}</span>
      <span className="meter__value">{Math.round(value)}%</span>
      <span className="meter__bar" />
      <small>{detail}</small>
    </div>
  );
}

function SystemBody() {
  const sys = useSystem();
  if (!sys) return null;
  return (
    <div className="widget-system">
      <Meter label="CPU" value={sys.cpu} detail="" />
      {sys.gpu && <Meter label="GPU" value={sys.gpu.load} detail={`${sys.gpu.temp}°C · ${gb(sys.gpu.used)} of ${gb(sys.gpu.total)}`} />}
      <Meter label="Memory" value={(sys.memory.used / sys.memory.total) * 100} detail={`${gb(sys.memory.used)} of ${gb(sys.memory.total)}`} />
    </div>
  );
}

/** A small line chart of the last 60 readings; missing ones leave a gap and a red tick. */
function Spark({ values, tone, floorMax }: { values: (number | null)[]; tone: Tone; floorMax: number }) {
  const { path, gaps } = sparkline(values, { floorMax });
  return (
    <svg className={`net-spark net-spark--${tone}`} viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      {gaps.map((x) => (
        <line key={x} className="net-spark__lost" x1={x} x2={x} y1={SPARK_H - 7} y2={SPARK_H} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  );
}

const ms = (n: number | null) => (n === null ? 'Lost' : `${Math.round(n)} ms`);

function NetworkBody({ s }: { s: WidgetSettings }) {
  const { stats, error } = useNetstats(s);
  if (error) return <p className="error">{error}</p>;
  if (!stats?.ping) return <p className="muted">Measuring…</p>;
  const { game, router } = stats;
  const net: PingStats = stats.ping;
  // In a game that reports its own ping, that is the one that matters; otherwise the network's.
  const gamePing = game?.ping ?? null;
  const ping = gamePing ?? net.last;
  const pingHistory = gamePing !== null ? game!.pingHistory : net.history;
  const tone = pingTone(ping);
  const fpsT = game ? fpsTone(game.fps) : 'good';
  return (
    <div className={`widget-net ${game ? 'has-game' : ''}`}>
      <p className="widget-net__compact">
        <span className={`tone--${tone}`}>{ping === null ? 'Lost' : `${Math.round(ping)} ms`}</span>
        {game && (
          <>
            {' · '}
            <span className={`tone--${fpsT}`}>{game.fps} fps</span>
          </>
        )}
      </p>
      <div className="widget-net__full">
        <section className="net-block">
          <span className="net-block__label">{gamePing !== null ? `${game!.name} ping` : `Ping to ${net.host.replace(/:443$/, '')}`}</span>
          <strong className={`net-block__big tone--${tone}`}>{ping === null ? 'Lost' : Math.round(ping)}{ping !== null && <small> ms</small>}</strong>
          <Spark values={pingHistory} tone={tone} floorMax={50} />
          <span className="net-block__detail">
            {gamePing !== null && `Network ${ms(net.last)} · `}Jitter {Math.round(net.jitter)} ms · Lost {net.loss}%
          </span>
          {s.showRouter && router && <span className="net-block__detail">Router {ms(router.last)} · lost {router.loss}%</span>}
        </section>
        {game && (
          <section className="net-block">
            <span className="net-block__label">{game.name} FPS</span>
            <strong className={`net-block__big tone--${fpsT}`}>{game.fps}</strong>
            <Spark values={game.fpsHistory} tone={fpsT} floorMax={60} />
            <span className="net-block__detail">
              {game.fpsLow !== null && `1% low ${game.fpsLow}`}
              {game.gpuMs !== null && ` · GPU ${game.gpuMs.toFixed(1)} ms`}
            </span>
          </section>
        )}
      </div>
    </div>
  );
}

// ---- settings, shown in the panel while editing ----

function zones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
}

/** A Date as the value of an <input type="datetime-local">, in this PC's time. */
function toLocalInput(ms: number) {
  if (!ms) return '';
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

function Settings({ widget, set, onDone }: { widget: Widget; set: SetSettings; onDone: () => void }) {
  const s = widget.settings;
  const [query, setQuery] = useState(s.place);
  const [finding, setFinding] = useState('');

  const find = async () => {
    if (!query.trim()) return;
    setFinding('Looking…');
    const place = await findPlace(query).catch(() => null);
    if (!place) return setFinding('Couldn’t find that place.');
    setFinding('');
    setQuery(place.name);
    set({ place: place.name, lat: place.lat, lon: place.lon });
  };

  return (
    <form
      className="widget-settings no-drag"
      onSubmit={(e) => {
        e.preventDefault();
        if (widget.type === 'weather' && query !== s.place) void find();
        else onDone();
      }}
    >
      {widget.type === 'clock' && (
        <>
          <label>
            Time zone
            <select data-setup="" value={s.timeZone} onChange={(e) => set({ timeZone: e.target.value })}>
              <option value="">This PC’s</option>
              {zones().map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </label>
          <label className="inline">
            <input type="checkbox" checked={s.hour12} onChange={(e) => set({ hour12: e.target.checked })} /> 12-hour
          </label>
          <label className="inline">
            <input type="checkbox" checked={s.seconds} onChange={(e) => set({ seconds: e.target.checked })} /> Seconds
          </label>
        </>
      )}
      {widget.type === 'weather' && (
        <>
          <label>
            Place
            <span className="row">
              <input data-setup="" value={query} placeholder="City or town" onChange={(e) => setQuery(e.target.value)} />
              <button className="btn btn--small" type="button" onClick={() => void find()}>
                Find
              </button>
            </span>
          </label>
          {finding && <p className="muted">{finding}</p>}
          <label className="inline">
            <input type="checkbox" checked={s.celsius} onChange={(e) => set({ celsius: e.target.checked })} /> Celsius
          </label>
        </>
      )}
      {widget.type === 'notifications' && (
        <>
          <label>
            Only from
            <input data-setup="" value={s.apps} placeholder="All apps (or e.g. Discord, Outlook)" onChange={(e) => set({ apps: e.target.value })} />
          </label>
          <label className="inline">
            <input type="checkbox" checked={s.showBody} onChange={(e) => set({ showBody: e.target.checked })} /> Show the message,
            not just the title
          </label>
          <p className="hint">It’s on stream, so keep private apps out. Shown on this PC only.</p>
        </>
      )}
      {widget.type === 'network' && (
        <>
          <label>
            Ping this host
            <input data-setup="" value={s.pingTarget} placeholder="1.1.1.1 (or example.com:443)" onChange={(e) => set({ pingTarget: e.target.value })} />
          </label>
          <label className="inline">
            <input type="checkbox" checked={s.showRouter} onChange={(e) => set({ showRouter: e.target.checked })} /> Show the ping to
            my router
          </label>
          <p className="hint">Slow to the router means trouble in your home Wi-Fi; fine to the router but slow past it means your internet.</p>
        </>
      )}
      {widget.type === 'countdown' && (
        <>
          <label>
            Until
            <input
              data-setup=""
              type="datetime-local"
              value={toLocalInput(s.target)}
              onChange={(e) => set({ target: e.target.value ? new Date(e.target.value).getTime() : 0 })}
            />
          </label>
          <label>
            What’s happening
            <input value={s.text} placeholder="Raid night" onChange={(e) => set({ text: e.target.value })} />
          </label>
        </>
      )}
      {widget.type === 'focus' && <FocusSettings s={s} set={set} />}
      {widget.type === 'text' && (
        <label>
          Text
          <textarea data-setup="" rows={3} value={s.text} placeholder="Anything you like" onChange={(e) => set({ text: e.target.value })} />
        </label>
      )}
      <button className="btn btn--small btn--accent" type="submit">
        Done
      </button>
    </form>
  );
}
