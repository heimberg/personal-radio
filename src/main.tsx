import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RadioPlayer } from './audio/player.ts';
import { connectMediaSession } from './audio/media-session.ts';
import { NowPlaying } from './components/NowPlaying.tsx';
import { StationEditor } from './components/StationEditor.tsx';
import { Timeline } from './components/Timeline.tsx';
import { YamlEditor } from './components/YamlEditor.tsx';
import { defaultStationConfig } from './domain/station.ts';
import type { FailureSummary, StationConfig, TimelineItemView } from './domain/station.ts';
import type { FeedbackAction } from './domain/recommendation.ts';
import type { FeedbackReason } from './domain/listener-notes.ts';
import { api, playableInBrowser, post, readJson, trackFor } from './station-client.ts';
import './style.css';

// Inside the Android app the page is only the settings cockpit; the app itself plays the program.
const embeddedInApp = navigator.userAgent.includes('PersonalRadioAndroid');

// Cache only the static app shell; API calls and generated audio stay online-only.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { type: 'module' })
      .catch(error => console.warn('PWA offline shell registration failed', error));
  }, { once: true });
}

const audio = new Audio(); audio.preload = 'auto';
const player = new RadioPlayer(audio);
player.repeat(false);
connectMediaSession(player);

type View = 'program' | 'settings' | 'yaml';

// Back from connecting the Spotify listening profile: show the result once and clean the address.
const spotifyReturn = new URLSearchParams(window.location.search).get('spotify');
const spotifyStatus = new URLSearchParams(window.location.search).get('status');

function spotifyNotice(result: string, status: string | null): string {
  if (result === 'verbunden') return 'Spotify-Hörprofil verbunden. Die Songauswahl kennt jetzt deine Top-Künstler, Musikblöcke deine privaten Playlists.';
  if (result === 'verweigert') return 'Die Verbindung wurde bei Spotify nicht erlaubt. Du kannst es jederzeit nochmals versuchen.';
  if (result === 'abgelaufen') return 'Die Spotify-Anmeldung ist abgelaufen (nach 10 Minuten) oder wurde schon verwendet. Tippe nochmals auf «Mit Spotify verbinden».';
  return `Spotify hat die Anmeldung nicht bestätigt${status ? ` (Status ${status})` : ''}. Prüfe im Spotify-Dashboard, dass Client-ID und Secret zum Worker passen und die Redirect-URI genau ${window.location.origin}/api/spotify/callback lautet.`;
}
if (spotifyReturn) window.history.replaceState(null, '', window.location.pathname);

/** Sent ratings, so a reason given right after 👎 waits until the rating is stored. */
const sentRatings = new Map<string, Promise<unknown>>();

function sendFeedback(timelineId: string, action: FeedbackAction, listenedRatio: number) {
  // The server marks the item played and learns from the signal; playback never waits for it.
  const sent = fetch(api(`api/timeline/${timelineId}/feedback`), {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, listenedRatio: Math.max(0, Math.min(1, listenedRatio)) }),
  }).catch(() => { /* The item stays open on the server. */ });
  if (action === 'dislike') sentRatings.set(timelineId, sent);
}

async function sendReason(timelineId: string, reason: FeedbackReason) {
  await sentRatings.get(timelineId);
  await fetch(api(`api/timeline/${timelineId}/reason`), {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }),
  }).catch(() => { /* A lost reason costs nothing but the note. */ });
}

function App() {
  // Inside the Android app the program and the player are native: the page is the settings.
  const [view, setView] = useState<View>(spotifyReturn || embeddedInApp ? 'settings' : 'program');
  const [available, setAvailable] = useState<boolean | null>(null);
  const [config, setConfig] = useState<StationConfig | null>(null);
  const [items, setItems] = useState<TimelineItemView[]>([]);
  const [failures, setFailures] = useState<FailureSummary>({ count: 0 });
  const [notice, setNotice] = useState(() => {
    return spotifyReturn ? spotifyNotice(spotifyReturn, spotifyStatus) : '';
  });
  const [ratings, setRatings] = useState<Record<string, FeedbackAction>>({});
  const [reasons, setReasons] = useState<Record<string, FeedbackReason>>({});
  const listening = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const [station, timeline] = await Promise.all([
        fetch(api('api/station'), { credentials: 'same-origin' }).then(readJson<{ config: StationConfig | null }>),
        fetch(api('api/timeline'), { credentials: 'same-origin' }).then(readJson<{ items: TimelineItemView[]; failures?: FailureSummary }>),
      ]);
      setAvailable(true); setConfig(station.config); setItems(timeline.items); setFailures(timeline.failures ?? { count: 0 });
      // While listening, newly produced segments are appended to the running program.
      if (listening.current) player.appendTracks(timeline.items.filter(playableInBrowser).map(trackFor));
    } catch { setAvailable(false); }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => player.subscribeSignals(signal => { if (signal.track.timelineId) sendFeedback(signal.track.timelineId, signal.action, signal.listenedRatio); }), []);

  async function save(next: unknown): Promise<boolean> {
    try {
      const response = await fetch(api('api/station'), { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) });
      const result = await response.json().catch(() => ({})) as { config?: StationConfig; detail?: string };
      if (!response.ok || !result.config) throw new Error(result.detail ? `Konfiguration ungültig – ${result.detail}` : 'Konfiguration konnte nicht gespeichert werden.');
      setConfig(result.config); setNotice('Gespeichert. Neue Einstellungen gelten ab dem nächsten geplanten Beitrag.');
      await refresh();
      return true;
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Speichern fehlgeschlagen.'); return false; }
  }

  async function setUp() {
    const initial = defaultStationConfig({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    // The first program is planned right away instead of waiting for the next cron tick.
    if (await save(initial)) {
      try { await post('api/timeline/plan'); await refresh(); } catch { /* The cron plans it shortly. */ }
    }
  }

  function listen() {
    const ready = items.filter(playableInBrowser);
    if (!ready.length) { setNotice('Noch nichts bereit. Das Programm wird produziert – «Jetzt planen» startet es sofort.'); return; }
    listening.current = true;
    player.setTracks(ready.map(trackFor));
    void player.start(0);
  }

  function rate(action: FeedbackAction) {
    const track = player.tracks[player.state.index];
    if (!track?.timelineId) return;
    sendFeedback(track.timelineId, action, 1);
    setRatings(current => ({ ...current, [track.timelineId!]: action }));
  }

  function giveReason(reason: FeedbackReason) {
    const track = player.tracks[player.state.index];
    if (!track?.timelineId) return;
    void sendReason(track.timelineId, reason);
    setReasons(current => ({ ...current, [track.timelineId!]: reason }));
  }

  const ready = items.filter(playableInBrowser).length;
  const currentId = player.tracks[player.state.index]?.timelineId;
  // YAML is for bulk edits; it opens from the settings instead of taking a place in the navigation.
  const views: Array<[View, string]> = [['program', 'Programm'], ['settings', 'Einstellungen']];

  let content: React.ReactNode;
  if (available === null) content = <p className="empty">Programm wird geladen …</p>;
  else if (!available) content = <section className="card"><h2>Nicht verbunden</h2>
    <p className="muted">Das Programm läuft auf deinem privaten Cloudflare-Worker. Melde dich dort an, dann erscheint es hier.</p></section>;
  else if (!config) content = <section className="card setup"><h2>Dein Radio einrichten</h2>
    <p className="muted">Der Server plant und produziert dein Programm im Voraus – mit Moderation, Recherche und Musikstunden. Danach passt du alles unter «Einstellungen» an.</p>
    <button className="button primary" onClick={() => void setUp()}>Programm einrichten</button></section>;
  else content = <>
    {view === 'program' && <>
      {!embeddedInApp && <NowPlaying player={player} readyCount={ready} onListen={listen} onRate={rate} rated={currentId ? ratings[currentId] ?? null : null} onReason={giveReason} reason={currentId ? reasons[currentId] ?? null : null} />}
      <Timeline config={config} items={items} failures={failures} refresh={refresh} />
    </>}
    {view === 'settings' && <>
      <StationEditor config={config} onSave={save} />
      <p className="advanced-link"><button className="button ghost small" onClick={() => setView('yaml')}>Als Text (YAML) bearbeiten – für Fortgeschrittene</button></p>
    </>}
    {view === 'yaml' && <>
      <p className="advanced-link"><button className="button ghost small" onClick={() => setView('settings')}>← Zurück zu den Einstellungen</button></p>
      <YamlEditor config={config} onSave={save} />
    </>}
  </>;

  return <div className={`shell ${embeddedInApp ? 'embedded' : ''}`}>
    <header className="top">
      <span className="brand"><span className="brand-mark" aria-hidden="true">◒</span>{config?.name ?? 'personal radio'}<span className="dot">.</span></span>
      {config && <span className="host">mit {config.host.name}</span>}
    </header>
    {config && !embeddedInApp && <nav className="tabs" aria-label="Bereiche">{views.map(([id, label]) =>
      <button key={id} aria-current={view === id || (id === 'settings' && view === 'yaml') ? 'page' : undefined} onClick={() => setView(id)}>{label}</button>)}</nav>}
    <main>
      {notice && <p className="notice" role="status" onClick={() => setNotice('')}>{notice}</p>}
      {content}
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
