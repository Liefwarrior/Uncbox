import { type KeyboardEvent, type ReactNode, useId, useMemo, useRef, useState } from 'react';
import { formatMoney } from '../../money';
import { Icon } from '../../components/Icon';
import {
  type Chart,
  type ChartSeries,
  chartX,
  CHART_H,
  CHART_W,
  goldText,
  itemLabel,
  type ItemRow,
  lineChart,
  MASK,
  nearestTime,
  qualityColor,
  qualityName,
  shortDate,
  shortDateTime,
  shortMoney,
  type Sort,
  type SortKey,
} from './ah';
import { useAhContext } from './api';
import { AH_TABS, type AhTab } from './settings';

// The small parts the tabs are built from.

/** A price that is always shown ("12g 34s 56c"). */
export function Price({ copper }: { copper: number | null | undefined }) {
  return <span className="ah-money">{copper === null || copper === undefined ? '-' : formatMoney(copper)}</span>;
}

/** Gold of yours: shown as "•••" in stream mode unless the widget is set to show it. */
export function Gold({ copper }: { copper: number | null | undefined }) {
  const { hideGold } = useAhContext();
  if (copper === null || copper === undefined) return <span className="ah-money">-</span>;
  return hideGold ? (
    <span className="ah-money ah-money--hidden" role="img" aria-label="Hidden while streaming">
      {MASK}
    </span>
  ) : (
    <span className="ah-money">{goldText(copper, false)}</span>
  );
}

/** An item's name, in its quality's color, that opens the item in the Search tab. */
export function ItemLink({ item, name, quality }: { item: string; name?: string | null; quality?: number | null }) {
  const { openItem } = useAhContext();
  return (
    <button type="button" className="ah-link" style={{ color: quality === undefined ? undefined : qualityColor(quality) }} title={quality === undefined ? 'Open this item' : `${qualityName(quality)}. Open this item`} onClick={() => openItem(item)}>
      {itemLabel(name, item)}
    </button>
  );
}

/** A friendly note where there is nothing to show. */
export function Note({ children, tone }: { children: ReactNode; tone?: 'error' }) {
  return <p className={`ah-note ${tone === 'error' ? 'error' : 'muted'}`}>{children}</p>;
}

/** A table that scrolls on its own when the widget is narrow. */
export function Table({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ah-scroll" role="region" aria-label={label} tabIndex={0}>
      <table className="ah-table">{children}</table>
    </div>
  );
}

/** A column heading that sorts the table when clicked. */
export function SortHeader({ label, column, sort, onSort, wide }: { label: string; column: SortKey; sort: Sort; onSort: (key: SortKey) => void; wide?: boolean }) {
  const on = sort.key === column;
  return (
    <th scope="col" className={wide ? 'ah-wide' : undefined} aria-sort={on ? (sort.order === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="ah-sort" onClick={() => onSort(column)}>
        {label}
        <span aria-hidden="true">{on ? (sort.order === 'asc' ? ' ▲' : ' ▼') : ''}</span>
      </button>
    </th>
  );
}

/** A choice of one among a few, drawn as buttons. */
export function Choice<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: readonly { id: T; label: string }[]; onChange: (id: T) => void }) {
  return (
    <div className="ah-choice" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" className={`btn btn--small ${o.id === value ? 'btn--on' : ''}`} aria-pressed={o.id === value} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The widget's tabs. Arrow keys, Home and End move between them. */
export function Tabs({ tab, onTab, panelId }: { tab: AhTab; onTab: (tab: AhTab) => void; panelId: string }) {
  const list = useRef<HTMLDivElement>(null);
  const idFor = (id: string) => `${panelId}-tab-${id}`;
  const onKey = (e: KeyboardEvent) => {
    const at = AH_TABS.findIndex((t) => t.id === tab);
    let next = at;
    if (e.key === 'ArrowRight') next = (at + 1) % AH_TABS.length;
    else if (e.key === 'ArrowLeft') next = (at + AH_TABS.length - 1) % AH_TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = AH_TABS.length - 1;
    else return;
    e.preventDefault();
    onTab(AH_TABS[next].id);
    document.getElementById(idFor(AH_TABS[next].id))?.focus();
  };
  return (
    <div ref={list} className="ah-tabs" role="tablist" aria-label="Auction house sections" onKeyDown={onKey}>
      {AH_TABS.map((t) => (
        <button key={t.id} id={idFor(t.id)} type="button" role="tab" aria-selected={tab === t.id} aria-controls={panelId} tabIndex={tab === t.id ? 0 : -1} className={`ah-tab ${tab === t.id ? 'is-on' : ''}`} onClick={() => onTab(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ---- charts ----

/** A small line with no axes, for "how has this moved". */
export function Sparkline({ series, label }: { series: ChartSeries[]; label: string }) {
  const chart = useMemo(() => lineChart(series, { width: 120, height: 32, margin: { left: 2, right: 2, top: 3, bottom: 3 } }), [series]);
  if (chart.empty) return null;
  const id = series[0].id;
  const dots = chart.dots[id] ?? [];
  return (
    <svg className="ah-spark" viewBox="0 0 120 32" preserveAspectRatio="none" role="img" aria-label={label}>
      <path d={chart.paths[id]} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      {dots.length === 1 && <circle cx={dots[0].x} cy={dots[0].y} r="2" fill="currentColor" />}
    </svg>
  );
}

export interface LineStyle {
  id: string;
  label: string;
  /** A class from the stylesheet that colors the line (`ah-line--market`). */
  className: string;
  dashed?: boolean;
}

/**
 * A line chart with a value axis, a few dates, and a readout under it. Hover (or the arrow keys,
 * once it has focus) reads the values at one moment; nothing is drawn from outside data.
 */
export function LineChart({ series, lines, label, format = shortMoney, readoutFormat = formatMoney }: { series: ChartSeries[]; lines: LineStyle[]; label: string; format?: (v: number) => string; readoutFormat?: (v: number) => string }) {
  const chart: Chart = useMemo(() => lineChart(series), [series]);
  const [at, setAt] = useState<number | null>(null);
  const readout = useId();
  if (chart.empty) return <Note>No prices have been recorded for this yet.</Note>;

  const index = at === null ? null : Math.min(at, chart.times.length - 1);
  const time = index === null ? null : chart.times[index];
  const valueAt = (id: string) => (time ? chart.dots[id]?.find((d) => d.t === time.t)?.v : undefined);

  const onMove = (clientX: number, box: DOMRect) => {
    if (!(box.width > 0)) return;
    const i = nearestTime(chart, chartX(clientX, box));
    if (i >= 0) setAt(i);
  };
  const onKey = (e: KeyboardEvent) => {
    const last = chart.times.length - 1;
    const now = index ?? last;
    if (e.key === 'ArrowLeft') setAt(Math.max(0, now - 1));
    else if (e.key === 'ArrowRight') setAt(Math.min(last, now + 1));
    else if (e.key === 'Home') setAt(0);
    else if (e.key === 'End') setAt(last);
    else if (e.key === 'Escape') setAt(null);
    else return;
    e.preventDefault();
  };

  return (
    <figure className="ah-chart">
      <div className="ah-chart__plot" tabIndex={0} aria-label={`${label}. Use the left and right arrow keys to read each point.`} aria-describedby={readout} onKeyDown={onKey} onBlur={() => setAt(null)}>
        <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} aria-hidden="true" onMouseMove={(e) => onMove(e.clientX, e.currentTarget.getBoundingClientRect())} onMouseLeave={() => setAt(null)}>
          {chart.yTicks.map((t) => (
            <g key={t.y}>
              <line className="ah-chart__grid" x1={chart.plot.left} x2={chart.plot.right} y1={t.y} y2={t.y} />
              <text className="ah-chart__label" x={chart.plot.left - 5} y={t.y + 3.5} textAnchor="end">
                {format(t.v)}
              </text>
            </g>
          ))}
          {chart.xTicks.map((t, i) => (
            <text key={t.x} className="ah-chart__label" x={t.x} y={CHART_H - 6} textAnchor={chart.xTicks.length === 1 ? 'middle' : i === 0 ? 'start' : i === chart.xTicks.length - 1 ? 'end' : 'middle'}>
              {shortDate(t.t)}
            </text>
          ))}
          {lines.map((l) => (
            <g key={l.id} className={`ah-line ${l.className}`}>
              <path d={chart.paths[l.id]} fill="none" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" strokeDasharray={l.dashed ? '5 4' : undefined} />
              {(chart.dots[l.id] ?? []).length <= 40 && (chart.dots[l.id] ?? []).map((d) => <circle key={d.t} cx={d.x} cy={d.y} r="2.4" />)}
            </g>
          ))}
          {time && <line className="ah-chart__cursor" x1={time.x} x2={time.x} y1={chart.plot.top} y2={chart.plot.bottom} />}
          {time &&
            lines.map((l) => {
              const d = chart.dots[l.id]?.find((p) => p.t === time.t);
              return d ? <circle key={l.id} className={`ah-chart__focus ${l.className}`} cx={d.x} cy={d.y} r="4.5" /> : null;
            })}
        </svg>
      </div>
      <figcaption>
        <ul className="ah-chart__legend">
          {lines.map((l) => (
            <li key={l.id}>
              <svg width="22" height="8" viewBox="0 0 22 8" aria-hidden="true" className={`ah-line ${l.className}`}>
                <path d="M1 4h20" strokeWidth="2.5" strokeLinecap="round" strokeDasharray={l.dashed ? '5 4' : undefined} fill="none" />
              </svg>
              {l.label}
            </li>
          ))}
        </ul>
        <p id={readout} className="ah-chart__readout" aria-live="polite">
          {time ? (
            <>
              <strong>{shortDateTime(time.t)}</strong>
              {lines.map((l) => {
                const v = valueAt(l.id);
                return v === undefined ? null : (
                  <span key={l.id}>
                    {l.label} {readoutFormat(v)}
                  </span>
                );
              })}
            </>
          ) : (
            <span className="muted">Hover the chart, or focus it and use the arrow keys, to read a point.</span>
          )}
        </p>
      </figcaption>
    </figure>
  );
}

/** A name with its quality color and a plain-words quality for people who can't see the color. */
export function ItemTitle({ item, name, quality }: Pick<ItemRow, 'item' | 'name' | 'quality'>) {
  return (
    <span className="ah-itemtitle" style={{ color: qualityColor(quality) }}>
      {itemLabel(name, item)}
      <span className="ah-sr"> ({qualityName(quality)})</span>
    </span>
  );
}

export function RefreshButton({ onClick, busy }: { onClick: () => void; busy?: boolean }) {
  return (
    <button type="button" className={`icon-btn ${busy ? 'is-spinning' : ''}`} title="Refresh" aria-label="Refresh" onClick={onClick}>
      <Icon name="refresh" size={14} />
    </button>
  );
}
