import React, { useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { RadioPlayer } from './audio/player.ts';
import type { Track } from './audio/player.ts';
import { demoTracks } from './audio/demo.ts';
import { connectMediaSession } from './audio/media-session.ts';
import { SegmentGenerator } from './components/SegmentGenerator.tsx';
import { defaultProfile, parseProfile } from './domain/program.ts';
import type { Profile, Topic } from './domain/program.ts';
import './style.css';

// Cache only the static app shell; API calls and generated audio stay online-only.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { type: 'module' })
      .catch(error => console.warn('PWA offline shell registration failed', error));
  }, { once: true });
}

const audio = new Audio(); audio.preload = 'auto';
const player = new RadioPlayer(audio);
player.setTracks(demoTracks());
connectMediaSession(player);
document.addEventListener('visibilitychange', () => player.log('visibility', document.visibilityState));
window.addEventListener('online', () => player.log('network', 'online'));
window.addEventListener('offline', () => player.log('network', 'offline'));
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const statuses = { idle: 'Bereit zum Testen', loading: 'Wird gestartet', playing: 'Wiedergabe läuft', paused: 'Pausiert', buffering: 'Audio wird gepuffert', ended: 'Test beendet', error: 'Wiedergabe unterbrochen' };

function loadProfile(): Profile {
  try { return parseProfile(JSON.parse(localStorage.getItem('radio.profile.v1') ?? 'null')); }
  catch { return { ...defaultProfile, topics: [...defaultProfile.topics] }; }
}
function App() {
  const state = useSyncExternalStore(player.subscribe, player.snapshot);
  const [tab, setTab] = useState<'radio' | 'profile' | 'test'>('radio');
  const [profile, setProfile] = useState(loadProfile);
  const [notice, setNotice] = useState('');
  const [queueVersion, setQueueVersion] = useState(0);
  const track = player.tracks[state.index];
  const active = ['playing', 'loading', 'buffering'].includes(state.status);
  function save(next: Profile) {
    setProfile(next);
    try { localStorage.setItem('radio.profile.v1', JSON.stringify(next)); setNotice('Auf diesem Gerät gespeichert.'); }
    catch { setNotice('Speicherung blockiert. Einstellungen gelten für diese Sitzung.'); }
  }
  function replace(tracks: Track[]) {
    const old = player.tracks; player.setTracks(tracks);
    old.forEach(t => URL.revokeObjectURL(t.url)); setQueueVersion(v => v + 1);
  }
  function playGenerated(track: Track) {
    player.repeat(false); replace([track]); void player.start(0);
  }
  function exportLog() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({
      version: 1, exportedAt: new Date().toISOString(), userAgent: navigator.userAgent,
      mediaSession: 'mediaSession' in navigator, state: player.state, events: player.logs,
    }, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'radio-audiotest.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="shell">
    <header><a className="brand" href="#" aria-label="Personal Radio Start" onClick={() => setTab('radio')}><span className="brand-icon">◒</span> personal radio<span className="dot">.</span></a><span className="badge">Audiolabor 0.1</span></header>
    <main>
      <div className="intro"><p className="eyebrow">DEIN PROGRAMM. DEIN RHYTHMUS.</p><h1>{tab === 'radio' ? 'Platz für gute Gedanken.' : tab === 'profile' ? 'So klingt dein Tag.' : 'Hören. Sperren. Testen.'}</h1><p>{tab === 'radio' ? 'Erstelle aus einer Quelle einen gesprochenen Beitrag und höre ihn direkt im Player.' : tab === 'profile' ? 'Deine Vorlieben bleiben auf diesem Gerät und werden beim Entwurf mitgeschickt.' : 'Finde heraus, wie zuverlässig dein Android-Gerät im Hintergrund weiterspielt.'}</p></div>
      {tab === 'radio' && <>
        <section className="player-card" aria-label="Audioplayer"><div className="card-top"><span className="live-dot" /> <span>{statuses[state.status]}</span><span className="card-number">{state.index + 1} / {player.tracks.length}</span></div>
          <div className={`record ${active ? 'record-active' : ''}`} aria-hidden="true"><div className="record-inner"><span>PR</span><small>LISTEN / EXPLORE</small></div></div>
          <p className="eyebrow">{track?.kind}</p><h2>{track?.title ?? 'Keine Audiodateien'}</h2>
          <label className="sr-only" htmlFor="seek">Wiedergabeposition</label><input id="seek" type="range" min="0" max={state.duration || 1} step="0.1" value={Math.min(state.position, state.duration || 1)} disabled={!state.duration} onChange={e => player.seek(Number(e.target.value))} />
          <div className="time"><span>{clock(state.position)}</span><span>{clock(state.duration)}</span></div>
          <div className="controls"><button aria-label="Vorheriger Titel" onClick={() => void player.previous()}>↤</button><button className="play" onClick={() => active ? player.pause() : void player.start()}>{active ? 'Ⅱ Pause' : '▶ Start'}</button><button aria-label="Nächster Titel" onClick={() => void player.next()}>↦</button></div>
          {state.error && <p role="alert" className="error">{state.error}</p>}
        </section>
        <SegmentGenerator profile={profile} onReady={playGenerated} />
        <section className="panel"><div className="section-heading"><h2>Als Nächstes</h2><span>{player.tracks.some(item => item.kind.startsWith('ASK')) ? 'KI-Beitrag' : 'Lokaler Audiotest'}</span></div><ol className="queue" key={queueVersion}>{player.tracks.map((t, i) => <li key={t.id}><button onClick={() => void player.start(i)} aria-current={state.index === i ? 'true' : undefined}><span className="queue-num">{String(i + 1).padStart(2, '0')}</span><span><strong>{t.title}</strong><small>{t.kind}</small></span><span aria-hidden="true">{state.index === i ? '●' : '↗'}</span></button></li>)}</ol></section>
        <section className="note"><strong>Privater KI-Test</strong><p>Die Beitragserstellung funktioniert nur auf der privaten Cloudflare-Version nach deren Einrichtung. Auf der öffentlichen Pages-Demo bleiben Testtöne und lokale Dateien verfügbar. Spotify ist nicht verbunden.</p></section>
      </>}
      {tab === 'profile' && <section className="panel settings"><h2>Was interessiert dich?</h2><p>Wähle deine Themen. Alles lässt sich später ändern.</p><div className="chips">{(['Technologie', 'Wissenschaft', 'Kultur'] as Topic[]).map(topic => <button key={topic} aria-pressed={profile.topics.includes(topic)} onClick={() => save({ ...profile, topics: profile.topics.includes(topic) ? profile.topics.filter(t => t !== topic) : [...profile.topics, topic] })}>{topic}</button>)}</div><label htmlFor="minutes">Beitragslänge <strong>{profile.speechMinutes} Min.</strong></label><input id="minutes" type="range" min="1" max="10" value={profile.speechMinutes} onChange={e => save({ ...profile, speechMinutes: Number(e.target.value) })} /><label htmlFor="explore">Neues entdecken <strong>{profile.exploration} %</strong></label><input id="explore" type="range" min="0" max="50" step="5" value={profile.exploration} onChange={e => save({ ...profile, exploration: Number(e.target.value) })} /><p>Später bewertet die Redaktion Themen nach deinen Vorgaben. Automatisches Lernen ist in diesem Test noch nicht aktiv.</p><button className="secondary" onClick={() => save({ ...defaultProfile, topics: [...defaultProfile.topics] })}>Vorlieben zurücksetzen</button><p role="status">{notice}</p></section>}
      {tab === 'test' && <section className="panel settings"><span className="badge light">ANDROID · MACHBARKEIT</span><h2>Bildschirm aus. Radio an?</h2><ol className="instructions"><li>Testsequenz oder eigene Dateien laden. Lautstärke zunächst niedrig einstellen.</li><li>Start drücken und den Bildschirm für mindestens 10 Minuten sperren.</li><li>Auf Titelwechsel achten. Pause und Fortsetzen über Sperrbildschirm oder Kopfhörer testen.</li><li>Für den vollständigen Test 60 Minuten hören, inklusive Anruf und Netzwechsel.</li><li>Protokoll exportieren und notieren, wann etwas abgebrochen ist.</li></ol><label className="toggle"><input type="checkbox" checked={state.repeat} onChange={e => player.repeat(e.target.checked)} /> Warteschlange wiederholen</label><div className="stats"><div><strong>{state.completed}</strong><span>Beendete Segmente</span></div><div><strong>{'mediaSession' in navigator ? 'Ja' : 'Nein'}</strong><span>Media Session verfügbar</span></div></div><label className="file-label">Eigene Audiodateien auswählen<input type="file" accept="audio/*" multiple onChange={e => { const files = Array.from(e.target.files ?? []).filter(f => f.type.startsWith('audio/')); if (files.length) replace(files.map((f, i) => ({ id: `local-${i}`, title: f.name, kind: 'Lokale Datei · kein Upload', url: URL.createObjectURL(f) }))); e.target.value = ''; }} /></label><p>Dateien bleiben im Browser. Lokale Dateien testen keinen Streaming-Netzausfall. Das Protokoll enthält Zeitpunkte und Browserangaben, keine Dateinamen oder Profile.</p><button className="secondary" onClick={() => replace(demoTracks())}>Testsequenz laden</button><button className="primary" onClick={exportLog}>Testprotokoll herunterladen</button><p className="warning">Du hast bestätigt, dass Bildschirm-aus-Wiedergabe auf deinem Android-Gerät funktioniert. Weitere Headset-, Netz- und Langzeittests sind noch offen.</p></section>}
    </main>
    {tab !== 'radio' && <div className="mini"><span><strong>{track?.title}</strong><small>{statuses[state.status]}</small></span><button onClick={() => active ? player.pause() : void player.start()}>{active ? 'Pause' : 'Start'}</button></div>}
    <nav aria-label="Hauptnavigation">{([['radio', '◉', 'Radio'], ['profile', '☷', 'Mein Programm'], ['test', '⌁', 'Audiotest']] as const).map(([id, icon, label]) => <button key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}><span aria-hidden="true">{icon}</span>{label}</button>)}</nav>
  </div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
