import { useState } from 'react';
import type { BodyProps, SettingsProps } from '../types';
import type { WeatherSettings } from './settings';
import { describeWeather, findPlace, useWeather } from './weather';

export function WeatherBody({ settings: s }: BodyProps<WeatherSettings>) {
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

export function WeatherSettingsForm({ settings: s, set }: SettingsProps<WeatherSettings>) {
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
    <>
      <label>
        Place
        <span className="row">
          <input
            data-setup=""
            value={query}
            placeholder="City or town"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Enter looks the place up when it changed; otherwise it's the form's Done.
              if (e.key === 'Enter' && query !== s.place) {
                e.preventDefault();
                void find();
              }
            }}
          />
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
  );
}
