// Browser side of the station API: requests and labels for the studio.
import type { ShowFormat } from './domain/station.ts';

export function api(path: string) { return new URL(path, window.location.href); }

export async function readJson<T>(response: Response): Promise<T> {
  if (!response.headers.get('Content-Type')?.includes('application/json')) throw new Error('unavailable');
  return response.json() as Promise<T>;
}

/** POST to the station API; omit the body for actions that need no parameters. */
export async function post<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(api(path), { method: 'POST', credentials: 'same-origin', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const result = await readJson<T>(response);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return result;
}

export const FORMAT_LABELS: Record<ShowFormat, string> = {
  brief: 'Kurzbeitrag', podcast: 'Dialog', artist_hour: 'Künstler-Stunde', genre_hour: 'Genre-Stunde', theme_hour: 'Themen-Stunde', music_block: 'Musikblock',
};
