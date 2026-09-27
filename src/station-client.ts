// Browser side of the station API: requests, labels and the mapping of timeline items to player tracks.
import type { ShowFormat, TimelineItemView, TimelineState, VerificationPolicy } from './domain/station.ts';
import type { Track } from './audio/player.ts';

export function api(path: string) { return new URL(path, window.location.href); }

export async function readJson<T>(response: Response): Promise<T> {
  if (!response.headers.get('Content-Type')?.includes('application/json')) throw new Error('unavailable');
  return response.json() as Promise<T>;
}

/** POST without a body; the Worker accepts it because the browser sends its own Origin. */
export async function post<T>(path: string): Promise<T> {
  const response = await fetch(api(path), { method: 'POST', credentials: 'same-origin' });
  const result = await readJson<T>(response);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return result;
}

export const STATE_LABELS: Record<TimelineState, string> = {
  planned: 'Geplant', voicing: 'Wird vertont', ready: 'Bereit', played: 'Gehört', skipped: 'Übersprungen', failed: 'Fehlgeschlagen', expired: 'Abgelaufen',
};

export const VERIFICATION_LABELS: Record<VerificationPolicy, string> = { strict: 'quellengeprüft', light: 'quellenbasiert', off: 'frei' };

export const FORMAT_LABELS: Record<ShowFormat, string> = {
  brief: 'Kurzbeitrag', podcast: 'Dialog', artist_hour: 'Künstler-Stunde', genre_hour: 'Genre-Stunde', theme_hour: 'Themen-Stunde',
};

const ERROR_LABELS: Record<string, string> = {
  NO_SOURCES: 'Keine neuen Quellen für diese Sendung gefunden.',
  REJECTED: 'Quellenprüfung nicht bestanden; es wurde kein Audio erstellt.',
  INVALID_INPUT: 'Der Entwurf passte nicht zu den Vorgaben.',
  DAILY_LIMIT: 'Tageslimit erreicht; die Produktion geht nach Mitternacht (UTC) weiter.',
  PODCAST_PROVIDER_NOT_CONFIGURED: 'Gemini ist für Dialog-Sendungen nicht konfiguriert.',
  SHOW_REMOVED: 'Die Sendung existiert nicht mehr.',
  GEMINI_NOT_CONFIGURED: 'Gemini ist nicht konfiguriert (GEMINI_API_KEY).',
  ASK_NOT_CONFIGURED: 'ASK ist nicht konfiguriert; stelle die Sendung auf Gemini.',
  SPOTIFY_NOT_CONFIGURED: 'Spotify-Suche ist nicht konfiguriert (SPOTIFY_CLIENT_ID und SPOTIFY_CLIENT_SECRET im Worker).',
};

export function errorLabel(error: string): string {
  if (error.startsWith('REJECTED: ')) return `Quellenprüfung nicht bestanden – ${error.slice('REJECTED: '.length)}`;
  if (error.startsWith('TOO_FEW_TRACKS: ')) return `Zu wenige Songs gefunden – ${error.slice('TOO_FEW_TRACKS: '.length)}`;
  return ERROR_LABELS[error] ?? error;
}

export const clockTime = (iso: string) => new Date(iso).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });

/** Spoken segments play in the browser; music hours need the Spotify app and play only in the Android app. */
export const playableInBrowser = (item: TimelineItemView) => item.state === 'ready' && !!item.audioUrl;

export function trackFor(item: TimelineItemView): Track {
  return {
    id: item.id, timelineId: item.id, feedbackId: item.id, url: api(item.audioUrl!).href,
    title: item.title ?? item.showName, interests: item.interestTags ?? [],
    kind: `${item.showName}${item.verification ? ` · ${VERIFICATION_LABELS[item.verification]}` : ''}`,
  };
}
