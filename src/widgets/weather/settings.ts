export type WeatherSettings = {
  /** The place as found, and where it is. */
  place: string;
  lat: number;
  lon: number;
  celsius: boolean;
};

export const defaultWeatherSettings = (): WeatherSettings => ({ place: '', lat: 0, lon: 0, celsius: false });

/** A weather place is likely home, so a shared preset leaves it out and the widget asks again. */
export const weatherForSharing = (s: WeatherSettings): WeatherSettings => ({ ...s, place: '', lat: 0, lon: 0 });
