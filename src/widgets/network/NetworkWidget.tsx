import type { BodyProps, SettingsProps } from '../types';
import { type PingStats, useNetstats } from './network';
import { fpsTone, pingTone, SPARK_H, SPARK_W, sparkline, type Tone } from './netstats';
import type { NetworkSettings } from './settings';

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

export function NetworkBody({ settings: s }: BodyProps<NetworkSettings>) {
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

export function NetworkSettingsForm({ settings: s, set }: SettingsProps<NetworkSettings>) {
  return (
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
  );
}
