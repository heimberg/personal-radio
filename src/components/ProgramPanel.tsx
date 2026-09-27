import { useCallback, useEffect, useRef, useState } from 'react';
import type { Profile } from '../domain/program.ts';
import { defaultStationConfig } from '../domain/station.ts';
import type { StationConfig, TimelineItemView, TimelineState } from '../domain/station.ts';
import type { RadioPlayer, Track } from '../audio/player.ts';

interface Props { player: RadioPlayer; profile: Profile; onStartProgram(tracks: Track[]): void; embedded?: boolean }

const STATE_LABELS: Record<TimelineState, string> = {
  planned: 'Geplant', voicing: 'Wird vertont', ready: 'Bereit', played: 'Gehört', skipped: 'Übersprungen', failed: 'Fehlgeschlagen', expired: 'Abgelaufen',
};
const ERROR_LABELS: Record<string, string> = {
  NO_SOURCES: 'Keine neuen Artikel in den Feeds dieser Sendung.',
  REJECTED: 'Quellenprüfung nicht bestanden; es wurde kein Audio erstellt.',
  INVALID_INPUT: 'Der Entwurf passte nicht zu den Vorgaben.',
  DAILY_LIMIT: 'Tageslimit erreicht; die Produktion geht nach Mitternacht (UTC) weiter.',
  PODCAST_PROVIDER_NOT_CONFIGURED: 'Gemini ist für Dialog-Sendungen nicht konfiguriert.',
  SHOW_REMOVED: 'Die Sendung existiert nicht mehr.',
  GEMINI_NOT_CONFIGURED: 'Gemini ist nicht konfiguriert (GEMINI_API_KEY).',
  ASK_NOT_CONFIGURED: 'ASK ist nicht konfiguriert; stelle die Sendung auf textProvider: gemini.',
};
const EDITOR_HELP = [
  '# host: Moderations-Persona – name, tone, style, instructions; cohostName spricht in Dialog-Sendungen mit',
  '# shows: instructions = eigener Prompt · format brief (1–2 Min.) oder podcast (2–10 Min.) · verification strict | light | off',
  '#        textProvider gemini | ask · sourceMode feeds (feedIds) | web (Google-Suche, researchPrompt = Rechercheauftrag)',
  '# schedule: days 0 (So) bis 6 (Sa), from/to HH:MM in timezone · showIds werden abwechselnd gesendet',
].join('\n');
const VERIFICATION_LABELS = { strict: 'quellengeprüft', light: 'quellenbasiert', off: 'frei' } as const;

function api(path: string) { return new URL(path, window.location.href); }
async function readJson<T>(response: Response): Promise<T> {
  if (!response.headers.get('Content-Type')?.includes('application/json')) throw new Error('unavailable');
  return response.json() as Promise<T>;
}

export function trackFor(item: TimelineItemView): Track {
  return {
    id: item.id, timelineId: item.id, feedbackId: item.id, url: api(item.audioUrl!).href,
    title: item.title ?? item.showName, interests: item.interestTags ?? [],
    kind: `${item.showName} · ${item.verification ? VERIFICATION_LABELS[item.verification] : 'Programm'}`,
  };
}

function readDeviceFeeds(): Array<{ name: string; url: string }> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem('radio.feeds.v1') ?? '[]');
    return Array.isArray(value) ? value.filter((feed): feed is { name: string; url: string } =>
      !!feed && typeof feed.name === 'string' && typeof feed.url === 'string' && feed.url.startsWith('https://')) : [];
  } catch { return []; }
}

export function ProgramPanel({ player, profile, onStartProgram, embedded = false }: Props) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [config, setConfig] = useState<StationConfig | null>(null);
  const [items, setItems] = useState<TimelineItemView[]>([]);
  const [editor, setEditor] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const programActive = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const [station, timeline] = await Promise.all([
        fetch(api('api/station'), { credentials: 'same-origin' }).then(readJson<{ config: StationConfig | null }>),
        fetch(api('api/timeline'), { credentials: 'same-origin' }).then(readJson<{ items: TimelineItemView[] }>),
      ]);
      setAvailable(true); setConfig(station.config); setItems(timeline.items);
      if (programActive.current) player.appendTracks(timeline.items.filter(item => item.state === 'ready' && item.audioUrl).map(trackFor));
    } catch { setAvailable(false); }
  }, [player]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function save(next: unknown): Promise<boolean> {
    setBusy(true);
    try {
      const response = await fetch(api('api/station'), { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) });
      const result = await response.json().catch(() => ({})) as { config?: StationConfig; detail?: string };
      if (!response.ok || !result.config) throw new Error(result.detail ? `Konfiguration ungültig – ${result.detail}` : 'Konfiguration konnte nicht gespeichert werden.');
      setConfig(result.config); setEditor(null); setMessage('Programm gespeichert.');
      await refresh();
      return true;
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Speichern fehlgeschlagen.'); return false; }
    finally { setBusy(false); }
  }

  async function plan() {
    setBusy(true); setMessage('Programm wird geplant …');
    try {
      const response = await fetch(api('api/timeline/plan'), { method: 'POST', credentials: 'same-origin' });
      const result = await readJson<{ planned?: number; queued?: number }>(response);
      if (!response.ok) throw new Error();
      setMessage(`${result.planned ?? 0} neue Beiträge geplant, ${result.queued ?? 0} in Produktion.`);
      await refresh();
    } catch { setMessage('Planung fehlgeschlagen. Prüfe Anmeldung und Server.'); }
    finally { setBusy(false); }
  }

  // The YAML library is only loaded when the editor opens.
  async function toggleEditor() {
    if (editor !== null) { setEditor(null); return; }
    const { stringify } = await import('yaml');
    setEditor(`${EDITOR_HELP}\n${stringify(config, { lineWidth: 0 })}`);
  }

  async function saveEditor() {
    const { parse } = await import('yaml');
    let parsed: unknown;
    try { parsed = parse(editor ?? ''); }
    catch (error) { setMessage(`Kein gültiges YAML – ${error instanceof Error ? error.message.split('\n')[0] : 'unbekannter Fehler'}`); return; }
    void save(parsed);
  }

  function listen() {
    const ready = items.filter(item => item.state === 'ready' && item.audioUrl);
    if (!ready.length) { setMessage('Noch nichts bereit. Das Programm wird produziert; tippe auf «Jetzt planen», falls nichts geplant ist.'); return; }
    programActive.current = true;
    onStartProgram(ready.map(trackFor));
    setMessage('Programm läuft. Neue Beiträge werden automatisch angehängt.');
  }

  if (available === null) return <section className="panel program-panel"><h2>Dein Programm</h2><p>Programm wird geladen …</p></section>;
  if (!available) return <section className="panel program-panel"><h2>Dein Programm</h2>
    <p>Das Server-Programm ist nur in der privaten Cloudflare-Version verfügbar. Einzelne Beiträge kannst du weiter unten erstellen.</p></section>;

  if (!config) return <section className="panel program-panel">
    <h2>Dein Programm</h2>
    <p>Der Server plant und produziert dein Programm im Voraus, auch wenn die App geschlossen ist. Übernimm dafür einmal Interessen, Feeds und Stimme von diesem Gerät.</p>
    <button className="primary" disabled={busy} onClick={() => {
      try {
        const initial = defaultStationConfig({
          profile, feeds: readDeviceFeeds(), voiceId: localStorage.getItem('radio.mistral.voice.v1') ?? undefined,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
        // The first program is planned right away instead of waiting for the next cron tick.
        void save(initial).then(saved => { if (saved) return plan(); });
      } catch (error) { setMessage(error instanceof Error ? `Geräteeinstellungen unvollständig – ${error.message}` : 'Übernahme fehlgeschlagen.'); }
    }}>Einstellungen dieses Geräts übernehmen</button>
    <p role="status">{message}</p>
  </section>;

  const open = items.filter(item => ['planned', 'voicing', 'ready'].includes(item.state));
  const readyCount = open.filter(item => item.state === 'ready').length;
  return <section className="panel program-panel">
    <div className="section-heading"><h2>Dein Programm</h2><span>{readyCount} bereit · {open.length} offen</span></div>
    <p>{config.shows.filter(show => show.enabled).map(show => show.name).join(' · ') || 'Keine Sendung aktiv'} – {config.horizonMinutes} Minuten im Voraus.</p>
    <div className="program-actions">
      {!embedded && <button className="primary" onClick={listen}>▶ Programm hören</button>}
      <button className="secondary" disabled={busy} onClick={() => void plan()}>Jetzt planen</button>
      <button className="secondary" onClick={() => void toggleEditor()}>{editor === null ? 'Konfiguration bearbeiten' : 'Editor schliessen'}</button>
    </div>
    {editor !== null && <div className="config-editor">
      <label htmlFor="station-config">Moderation, Sendungen, Feeds, Sendeuhr und Prompts (YAML)</label>
      <textarea id="station-config" rows={20} spellCheck={false} value={editor} onChange={event => setEditor(event.target.value)} />
      <button className="primary" disabled={busy} onClick={() => void saveEditor()}>Konfiguration speichern</button>
    </div>}
    <ol className="timeline" aria-label="Programmablauf">{items.slice().reverse().slice(0, 20).reverse().map(item => <li key={item.id} data-state={item.state}>
      <span className="timeline-time">{new Date(item.plannedAt).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })}</span>
      <span className="timeline-body">
        <strong>{item.title ?? item.showName}</strong>
        <small>{item.showName} · {STATE_LABELS[item.state]}{item.verification ? ` · ${VERIFICATION_LABELS[item.verification]}` : ''}</small>
        {item.error && item.state !== 'ready' && <small className="timeline-error">{ERROR_LABELS[item.error] ?? item.error}</small>}
        {item.sources?.map(source => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.title}</a>)}
        {item.searchQueries?.length ? <small className="timeline-search">Google-Suche: {item.searchQueries.map((query, index) => <span key={query}>{index ? ' · ' : ''}
          <a href={`https://www.google.com/search?q=${encodeURIComponent(query)}`} target="_blank" rel="noreferrer">{query}</a></span>)}</small> : null}
      </span>
    </li>)}</ol>
    <p role="status" aria-live="polite">{message}</p>
  </section>;
}
