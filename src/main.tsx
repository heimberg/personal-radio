import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { StationEditor } from './components/StationEditor.tsx';
import { YamlEditor } from './components/YamlEditor.tsx';
import { defaultStationConfig } from './domain/station.ts';
import type { StationConfig } from './domain/station.ts';
import { api, post, readJson } from './station-client.ts';
import './style.css';

// The page is the station's studio: settings, day plan and editorial team. Listening, the program and
// the archive live in the Android app, which shows this page in its «Studio» tab.
const embeddedInApp = navigator.userAgent.includes('PersonalRadioAndroid');
// Cache only the static app shell; API calls and generated audio stay online-only.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { type: 'module' })
      .catch(error => console.warn('PWA offline shell registration failed', error));
  }, { once: true });
}

type View = 'settings' | 'yaml';

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

function App() {
  const [view, setView] = useState<View>('settings');
  const [available, setAvailable] = useState<boolean | null>(null);
  const [config, setConfig] = useState<StationConfig | null>(null);
  const [notice, setNotice] = useState(() => spotifyReturn ? spotifyNotice(spotifyReturn, spotifyStatus) : '');

  const refresh = useCallback(async () => {
    try {
      const station = await fetch(api('api/station'), { credentials: 'same-origin' }).then(readJson<{ config: StationConfig | null }>);
      setAvailable(true); setConfig(station.config);
    } catch { setAvailable(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function save(next: unknown): Promise<boolean> {
    try {
      const response = await fetch(api('api/station'), { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) });
      const result = await response.json().catch(() => ({})) as { config?: StationConfig; detail?: string };
      if (!response.ok || !result.config) throw new Error(result.detail ? `Konfiguration ungültig – ${result.detail}` : 'Konfiguration konnte nicht gespeichert werden.');
      setConfig(result.config); setNotice('Gespeichert. Neue Einstellungen gelten ab dem nächsten geplanten Beitrag.');
      return true;
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Speichern fehlgeschlagen.'); return false; }
  }

  async function setUp() {
    const initial = defaultStationConfig({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    // The first program is planned right away instead of waiting for the next cron tick.
    if (await save(initial)) {
      try { await post('api/timeline/plan'); } catch { /* The cron plans it shortly. */ }
      setNotice('Dein Radio ist eingerichtet. Das erste Programm wird produziert – hören kannst du es in der App.');
    }
  }

  let content: React.ReactNode;
  if (available === null) content = <p className="empty">Wird geladen …</p>;
  else if (!available) content = <section className="card"><h2>Nicht verbunden</h2>
    <p className="muted">Das Programm läuft auf deinem privaten Cloudflare-Worker. Melde dich dort an, dann erscheint es hier.</p></section>;
  else if (!config) content = <section className="card setup"><h2>Dein Radio einrichten</h2>
    <p className="muted">Der Server plant und produziert dein Programm im Voraus – mit Moderation, Recherche und Musikstunden. Gehört wird in der App; hier passt du alles an.</p>
    <button className="button primary" onClick={() => void setUp()}>Programm einrichten</button></section>;
  else if (view === 'yaml') content = <>
    <p className="advanced-link"><button className="button ghost small" onClick={() => setView('settings')}>← Zurück zu den Einstellungen</button></p>
    <YamlEditor config={config} onSave={save} />
  </>;
  else content = <>
    <StationEditor config={config} onSave={save} />
    <p className="advanced-link"><button className="button ghost small" onClick={() => setView('yaml')}>Als Text (YAML) bearbeiten – für Fortgeschrittene</button></p>
  </>;

  return <div className={`shell ${embeddedInApp ? 'embedded' : ''}`}>
    <header className="top">
      <span className="brand"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>{config?.name ?? 'personal radio'}<span className="dot">.</span></span>
      {config && <span className="host">mit {config.host.name}</span>}
    </header>
    <main>
      {notice && <p className="notice" role="status" onClick={() => setNotice('')}>{notice}</p>}
      {content}
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
