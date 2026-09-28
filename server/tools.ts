// Tools for shows: live values the owner can put into a show's instructions and research brief as
// placeholders. The weather comes from Open-Meteo (no key); it also becomes a source, so the writer can
// cite it and the verifier accepts it like any other evidence.
import type { Source } from '../src/domain/program.ts';
import type { ShowConfig, StationLocation } from '../src/domain/station.ts';
import { ProviderError } from './providers.ts';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface WeatherReport { text: string; source: Source }
export interface Place { name: string; region: string; country: string; latitude: number; longitude: number }
export interface Weather {
  report(location: StationLocation, timezone: string, now: Date): Promise<WeatherReport>;
}

const PLACEHOLDER = /\{(datum|wochentag|uhrzeit|ort|wetter|schlagzeilen)\}/gi;
export type PlaceholderValues = Partial<Record<'datum' | 'wochentag' | 'uhrzeit' | 'ort' | 'wetter' | 'schlagzeilen', string>>;

/** True when the show asks for the weather in its instructions or research brief. */
export function usesWeather(show: Pick<ShowConfig, 'instructions' | 'researchPrompt'>): boolean {
  return /\{wetter\}/i.test(`${show.instructions} ${show.researchPrompt}`);
}

/** True when the show asks for the headlines in its instructions or research brief. */
export function usesHeadlines(show: Pick<ShowConfig, 'instructions' | 'researchPrompt'>): boolean {
  return /\{schlagzeilen\}/i.test(`${show.instructions} ${show.researchPrompt}`);
}

/** Replaces known placeholders; a value that is missing leaves the placeholder's name, never the braces. */
export function expandPlaceholders(text: string, values: PlaceholderValues): string {
  return text.replace(PLACEHOLDER, (_match, name: string) => values[name.toLowerCase() as keyof PlaceholderValues] ?? name.toLowerCase());
}

/** Date, weekday and time in the station's time zone, in German. */
export function clockValues(now: Date, timezone: string, location?: StationLocation): PlaceholderValues {
  const format = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('de-CH', { timeZone: timezone, ...options }).format(now);
  return {
    datum: format({ day: 'numeric', month: 'long', year: 'numeric' }),
    wochentag: format({ weekday: 'long' }),
    uhrzeit: format({ hour: '2-digit', minute: '2-digit' }),
    ...(location ? { ort: location.name } : {}),
  };
}

/** WMO weather codes as Open-Meteo reports them. */
const WEATHER_CODES: Record<number, string> = {
  0: 'klar', 1: 'überwiegend klar', 2: 'teils bewölkt', 3: 'bedeckt', 45: 'Nebel', 48: 'Nebel mit Reif',
  51: 'leichter Nieselregen', 53: 'Nieselregen', 55: 'starker Nieselregen', 56: 'gefrierender Nieselregen', 57: 'starker gefrierender Nieselregen',
  61: 'leichter Regen', 63: 'Regen', 65: 'starker Regen', 66: 'gefrierender Regen', 67: 'starker gefrierender Regen',
  71: 'leichter Schneefall', 73: 'Schneefall', 75: 'starker Schneefall', 77: 'Schneegriesel',
  80: 'leichte Regenschauer', 81: 'Regenschauer', 82: 'heftige Regenschauer', 85: 'leichte Schneeschauer', 86: 'starke Schneeschauer',
  95: 'Gewitter', 96: 'Gewitter mit Hagel', 99: 'Gewitter mit starkem Hagel',
};
export const describeWeather = (code: unknown) => WEATHER_CODES[Number(code)] ?? 'wechselhaft';

const round = (value: unknown) => Math.round(Number(value));
const finite = (...values: unknown[]) => values.every(value => Number.isFinite(Number(value)) && value !== null);

export class OpenMeteo implements Weather {
  private fetcher: Fetch;
  constructor(fetcher: Fetch = fetch) {
    // Workers reject fetch called as a method ("Illegal invocation"), so keep a plain function.
    this.fetcher = (input, init) => fetcher(input, init);
  }

  async report(location: StationLocation, timezone: string, now: Date): Promise<WeatherReport> {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.search = new URLSearchParams({
      latitude: location.latitude.toFixed(4), longitude: location.longitude.toFixed(4), timezone, forecast_days: '2',
      current: 'temperature_2m,weather_code,wind_speed_10m',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    }).toString();
    const body = await this.json(url.toString(), 'Open-Meteo weather') as {
      current?: { temperature_2m?: number; weather_code?: number; wind_speed_10m?: number };
      daily?: { weather_code?: number[]; temperature_2m_max?: number[]; temperature_2m_min?: number[]; precipitation_probability_max?: Array<number | null> };
    };
    const day = (index: number, label: string) => {
      const d = body.daily;
      if (!d || !finite(d.temperature_2m_min?.[index], d.temperature_2m_max?.[index])) return '';
      const rain = d.precipitation_probability_max?.[index];
      return `${label}: ${describeWeather(d.weather_code?.[index])}, ${round(d.temperature_2m_min![index])} bis ${round(d.temperature_2m_max![index])} °C` +
        (finite(rain) ? `, Regenwahrscheinlichkeit ${round(rain)} %` : '') + '.';
    };
    const current = body.current && finite(body.current.temperature_2m)
      ? `Jetzt ${round(body.current.temperature_2m)} °C, ${describeWeather(body.current.weather_code)}` +
        (finite(body.current.wind_speed_10m) ? `, Wind ${round(body.current.wind_speed_10m)} km/h` : '') + '.'
      : '';
    const text = [current, day(0, 'Heute'), day(1, 'Morgen')].filter(Boolean).join(' ');
    if (!text) throw new Error('Open-Meteo weather returned no forecast');
    const at = now.toISOString();
    return {
      text: `Wetter in ${location.name}: ${text}`,
      source: { id: 'wetter', url: `https://open-meteo.com/en/docs#latitude=${location.latitude.toFixed(2)}&longitude=${location.longitude.toFixed(2)}`,
        title: `Wetter ${location.name} (Open-Meteo)`, excerpt: `Wetterbericht von Open-Meteo für ${location.name}, abgerufen ${at}. ${text}`, publishedAt: at, retrievedAt: at },
    };
  }

  /** Places for the cockpit's location search. */
  async places(name: string): Promise<Place[]> {
    const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
    url.search = new URLSearchParams({ name, count: '5', language: 'de', format: 'json' }).toString();
    const body = await this.json(url.toString(), 'Open-Meteo geocoding') as { results?: Array<Record<string, unknown>> };
    return (body.results ?? []).flatMap(item => finite(item.latitude, item.longitude) && typeof item.name === 'string'
      ? [{ name: item.name.slice(0, 80), region: String(item.admin1 ?? '').slice(0, 80), country: String(item.country ?? '').slice(0, 80),
        latitude: Number(item.latitude), longitude: Number(item.longitude) }]
      : []);
  }

  private async json(url: string, label: string): Promise<unknown> {
    const response = await this.fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new ProviderError(label, response.status);
    return response.json();
  }
}
