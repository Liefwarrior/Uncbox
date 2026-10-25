import { usePoll } from '../shared/usePoll';
import type { WeatherSettings } from './settings';

// The weather comes straight from Open-Meteo (free, no account; only the chosen place's
// coordinates are sent).

export interface Place {
  name: string;
  lat: number;
  lon: number;
}

/** "Austin" → the best match, as "Austin, Texas, United States". */
export async function findPlace(query: string): Promise<Place | null> {
  const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(query)}`);
  const d = await r.json();
  const p = d.results?.[0];
  if (!p) return null;
  return { name: [p.name, p.admin1, p.country].filter(Boolean).join(', '), lat: p.latitude, lon: p.longitude };
}

export interface Weather {
  temp: number;
  high: number;
  low: number;
  code: number;
  day: boolean;
}

export function useWeather(s: WeatherSettings): Weather | null {
  const url =
    s.lat || s.lon
      ? `https://api.open-meteo.com/v1/forecast?latitude=${s.lat}&longitude=${s.lon}&current=temperature_2m,weather_code,is_day` +
        `&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&timezone=auto&temperature_unit=${s.celsius ? 'celsius' : 'fahrenheit'}`
      : null;
  const d = usePoll<{
    current: { temperature_2m: number; weather_code: number; is_day: number };
    daily: { temperature_2m_max: number[]; temperature_2m_min: number[] };
  }>(url, 15 * 60_000);
  if (!d?.current) return null;
  return {
    temp: Math.round(d.current.temperature_2m),
    high: Math.round(d.daily.temperature_2m_max[0]),
    low: Math.round(d.daily.temperature_2m_min[0]),
    code: d.current.weather_code,
    day: d.current.is_day === 1,
  };
}

/** WMO weather codes, as Open-Meteo reports them, in words and a symbol. */
export function describeWeather(code: number, day: boolean): [string, string] {
  if (code === 0) return ['Clear', day ? '☀️' : '🌙'];
  if (code <= 2) return ['Partly cloudy', day ? '⛅' : '☁️'];
  if (code === 3) return ['Cloudy', '☁️'];
  if (code <= 48) return ['Fog', '🌫️'];
  if (code <= 57) return ['Drizzle', '🌦️'];
  if (code <= 67) return ['Rain', '🌧️'];
  if (code <= 77) return ['Snow', '❄️'];
  if (code <= 82) return ['Showers', '🌧️'];
  if (code <= 86) return ['Snow showers', '🌨️'];
  return ['Thunderstorms', '⛈️'];
}
