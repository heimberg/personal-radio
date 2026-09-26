import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { RadioPlayer } from './audio/player.ts';
import type { Track } from './audio/player.ts';
import { demoTracks } from './audio/demo.ts';
import { connectMediaSession } from './audio/media-session.ts';
import { SegmentGenerator } from './components/SegmentGenerator.tsx';
import { PublicLearningDemo } from './components/PublicLearningDemo.tsx';
import { SpotifyPanel, type SpotifyControls } from './components/SpotifyPanel.tsx';
import { defaultProfile, parseProfile } from './domain/program.ts';
import type { Profile, Topic } from './domain/program.ts';
import { learnedWeights, parseFeedback } from './domain/recommendation.ts';
import type { FeedbackAction, FeedbackEvent } from './domain/recommendation.ts';
import './style.css';

const publicDemo = import.meta.env.VITE_PUBLIC_DEMO === 'true';
const spotifyClientId = import.meta.env.VITE_SPOTIFY_CLIENT_ID ?? '';

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
function loadFeedback(): FeedbackEvent[] {
  try { return parseFeedback(JSON.parse(localStorage.getItem('radio.feedback.v1') ?? '[]')); } catch { return []; }
}
function App() {
  const state = useSyncExternalStore(player.subscribe, player.snapshot);
  const [tab, setTab] = useState<'radio' | 'profile' | 'test'>('radio');
  const [profile, setProfile] = useState(loadProfile);
  const [feedback, setFeedback] = useState(loadFeedback);
  const [interestDraft, setInterestDraft] = useState('');
  const [notice, setNotice] = useState('');
  const [queueVersion, setQueueVersion] = useState(0);
  const spotifyControls = useRef<SpotifyControls | null>(null);
  player.beforeStart = () => spotifyControls.current?.pause();
  const track = player.tracks[state.index];
  const generationProfile = { ...profile, interestWeights: learnedWeights(feedback) };
  const active = ['playing', 'loading', 'buffering'].includes(state.status);
  function storeFeedback(next: FeedbackEvent[]) {
    const bounded = next.slice(-200); setFeedback(bounded);
    try { localStorage.setItem('radio.feedback.v1', JSON.stringify(bounded)); setNotice('Dein Programm lernt aus diesem Feedback auf diesem Gerät.'); }
    catch { setNotice('Feedback gilt nur bis zum Schliessen dieser Sitzung.'); }
  }
  function signal(action: FeedbackAction, item = track, listenedRatio = item?.id === track?.id && state.duration > 0 ? state.position / state.duration : 1) {
    if (!item) return;
    const interests = item.interests ?? [];
    if (!interests.length) return;
    storeFeedback([...feedback, { itemId: item.feedbackId ?? item.id, interests, action, listenedRatio: Math.max(0, Math.min(1, listenedRatio)), createdAt: new Date().toISOString() }]);
  }
  const signalRef = useRef(signal); signalRef.current = signal;
  useEffect(() => player.subscribeSignals(event => signalRef.current(event.action, event.track, event.listenedRatio)), []);
  useEffect(() => {
    if ((state.status === 'ended' || state.status === 'error') && (track?.kind.startsWith('ASK') || track?.kind.startsWith('Gemini'))) spotifyControls.current?.resume();
  }, [state.status, track]);
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
    spotifyControls.current?.pause();
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
    <header><a className="brand" href="#" aria-label="Personal Radio Start" onClick={() => setTab('radio')}><span className="brand-icon">◒</span> personal radio<span className="dot">.</span></a><span className="badge">{publicDemo ? 'Öffentliche Demo' : 'Privater Test'}</span></header>
    <main>
      <div className="intro"><p className="eyebrow">DEIN PROGRAMM. DEIN RHYTHMUS.</p><h1>{tab === 'radio' ? 'Platz für gute Gedanken.' : tab === 'profile' ? 'So klingt dein Tag.' : 'Hören. Sperren. Testen.'}</h1><p>{tab === 'radio' ? publicDemo ? 'Teste den Player und entdecke, wie Interessen und Feedback die Themenauswahl verändern.' : 'Dein Feedback hilft dem Radio, passende Beiträge und Themen für dich auszuwählen.' : tab === 'profile' ? publicDemo ? 'Deine Vorlieben und Bewertungen bleiben in diesem Browser und sortieren Beispielthemen.' : 'Deine Vorlieben bleiben auf diesem Gerät und werden beim Entwurf mitgeschickt.' : 'Finde heraus, wie zuverlässig dein Android-Gerät im Hintergrund weiterspielt.'}</p></div>
      {tab === 'radio' && <>
        <section className="player-card" aria-label="Audioplayer"><div className="card-top"><span className="live-dot" /> <span>{statuses[state.status]}</span><span className="card-number">{state.index + 1} / {player.tracks.length}</span></div>
          <div className={`record ${active ? 'record-active' : ''}`} aria-hidden="true"><div className="record-inner"><span>PR</span><small>LISTEN / EXPLORE</small></div></div>
          <p className="eyebrow">{track?.kind}</p><h2>{track?.title ?? 'Keine Audiodateien'}</h2>
          <label className="sr-only" htmlFor="seek">Wiedergabeposition</label><input id="seek" type="range" min="0" max={state.duration || 1} step="0.1" value={Math.min(state.position, state.duration || 1)} disabled={!state.duration} onChange={e => player.seek(Number(e.target.value))} />
          <div className="time"><span>{clock(state.position)}</span><span>{clock(state.duration)}</span></div>
          <div className="controls"><button aria-label="Vorheriger Titel" onClick={() => void player.previous()}>↤</button><button className="play" onClick={() => active ? player.pause() : void player.start()}>{active ? 'Ⅱ Pause' : '▶ Start'}</button><button aria-label="Nächster Titel" onClick={() => void player.next()}>↦</button></div>
          {track?.interests?.length ? <div className="feedback-controls" aria-label="Beitrag bewerten"><span>Mehr davon?</span><button aria-label="Gefällt mir" aria-pressed={feedback.some(item => item.itemId === (track.feedbackId ?? track.id) && item.action === 'like')} onClick={() => signal('like')}>👍</button><button aria-label="Weniger davon" aria-pressed={feedback.some(item => item.itemId === (track.feedbackId ?? track.id) && item.action === 'dislike')} onClick={() => signal('dislike')}>👎</button><small>{feedback.length} Lernsignale · lokal gespeichert</small></div> : null}
          {state.error && <p role="alert" className="error">{state.error}</p>}
        </section>
        {!publicDemo && spotifyClientId && <SpotifyPanel clientId={spotifyClientId} controlsRef={spotifyControls} onSpotifyPlay={() => player.pause()} />}
        {publicDemo ? <PublicLearningDemo profile={generationProfile} feedback={feedback} onFeedback={event => storeFeedback([...feedback, { ...event, createdAt: new Date().toISOString() }])} /> : <SegmentGenerator profile={generationProfile} onReady={playGenerated} />}
        <section className="panel"><div className="section-heading"><h2>Als Nächstes</h2><span>{player.tracks.some(item => item.kind.startsWith('ASK')) ? 'KI-Beitrag' : 'Lokaler Audiotest'}</span></div><ol className="queue" key={queueVersion}>{player.tracks.map((t, i) => <li key={t.id}><button onClick={() => void player.start(i)} aria-current={state.index === i ? 'true' : undefined}><span className="queue-num">{String(i + 1).padStart(2, '0')}</span><span><strong>{t.title}</strong><small>{t.kind}</small></span><span aria-hidden="true">{state.index === i ? '●' : '↗'}</span></button></li>)}</ol></section>
        <section className="note"><strong>{publicDemo ? 'Öffentliche Testversion' : 'Privater KI-Test'}</strong><p>{publicDemo ? 'Hier kannst du Interessen, lokales Feedback-Lernen und den Android-Audioplayer testen. Nachrichtenfeeds, KI-Beiträge und Spotify sind nicht verbunden.' : 'Die Beitragserstellung funktioniert nur auf der privaten Cloudflare-Version nach deren Einrichtung. Auf der öffentlichen Pages-Demo bleiben Testtöne und lokale Dateien verfügbar. Spotify ist nicht verbunden.'}</p></section>
      </>}
      {tab === 'profile' && <section className="panel settings"><h2>Was interessiert dich?</h2><p>Gib am Anfang die Richtung vor. Danach passen 👍, 👎, vollständiges Anhören und bewusste Skips die Themengewichtung an. Das Profil bleibt auf diesem Gerät.</p><div className="chips">{(['Technologie', 'Wissenschaft', 'Kultur'] as Topic[]).map(topic => <button key={topic} aria-pressed={profile.topics.includes(topic)} onClick={() => save({ ...profile, topics: profile.topics.includes(topic) ? profile.topics.filter(t => t !== topic) : [...profile.topics, topic] })}>{topic}</button>)}</div><form className="interest-form" onSubmit={event => { event.preventDefault(); const interest = interestDraft.trim(); if (!interest || profile.interests.some(value => value.toLocaleLowerCase() === interest.toLocaleLowerCase()) || profile.interests.length >= 30) return; save({ ...profile, interests: [...profile.interests, interest] }); setInterestDraft(''); }}><label htmlFor="interest">Eigene Interessen</label><div className="feed-load-row"><input id="interest" value={interestDraft} maxLength={48} onChange={event => setInterestDraft(event.target.value)} placeholder="z. B. Geschichte, Geologie" /><button className="secondary" type="submit" disabled={!interestDraft.trim()}>Hinzufügen</button></div></form><div className="chips">{profile.interests.map(interest => <button key={interest} aria-label={`${interest} entfernen`} onClick={() => save({ ...profile, interests: profile.interests.filter(value => value !== interest) })}>{interest} ×</button>)}</div><label htmlFor="minutes">Beitragslänge <strong>{profile.speechMinutes} Min.</strong></label><input id="minutes" type="range" min="1" max="10" value={profile.speechMinutes} onChange={e => save({ ...profile, speechMinutes: Number(e.target.value) })} /><label htmlFor="explore">Neues entdecken <strong>{profile.exploration} %</strong></label><input id="explore" type="range" min="0" max="50" step="5" value={profile.exploration} onChange={e => save({ ...profile, exploration: Number(e.target.value) })} /><p>Der Algorithmus gibt expliziten Interessen Vorrang. Ein sehr früher Skip wird als möglicher Abbruch gewertet und nicht als Dislike. Signale verlieren über Zeit an Einfluss; «Neues entdecken» hält bewusst Platz für unbekannte Themen.</p><button className="secondary" onClick={() => { save({ ...defaultProfile, topics: [...defaultProfile.topics] }); storeFeedback([]); }}>Vorlieben und Lernprofil zurücksetzen</button><p role="status">{notice}</p></section>}
      {tab === 'test' && <section className="panel settings"><span className="badge light">ANDROID · MACHBARKEIT</span><h2>Bildschirm aus. Radio an?</h2><ol className="instructions"><li>Testsequenz oder eigene Dateien laden. Lautstärke zunächst niedrig einstellen.</li><li>Start drücken und den Bildschirm für mindestens 10 Minuten sperren.</li><li>Auf Titelwechsel achten. Pause und Fortsetzen über Sperrbildschirm oder Kopfhörer testen.</li><li>Für den vollständigen Test 60 Minuten hören, inklusive Anruf und Netzwechsel.</li><li>Protokoll exportieren und notieren, wann etwas abgebrochen ist.</li></ol><label className="toggle"><input type="checkbox" checked={state.repeat} onChange={e => player.repeat(e.target.checked)} /> Warteschlange wiederholen</label><div className="stats"><div><strong>{state.completed}</strong><span>Beendete Segmente</span></div><div><strong>{'mediaSession' in navigator ? 'Ja' : 'Nein'}</strong><span>Media Session verfügbar</span></div></div><label className="file-label">Eigene Audiodateien auswählen<input type="file" accept="audio/*" multiple onChange={e => { const files = Array.from(e.target.files ?? []).filter(f => f.type.startsWith('audio/')); if (files.length) replace(files.map((f, i) => ({ id: `local-${i}`, title: f.name, kind: 'Lokale Datei · kein Upload', url: URL.createObjectURL(f) }))); e.target.value = ''; }} /></label><p>Dateien bleiben im Browser. Lokale Dateien testen keinen Streaming-Netzausfall. Das Protokoll enthält Zeitpunkte und Browserangaben, keine Dateinamen oder Profile.</p><button className="secondary" onClick={() => replace(demoTracks())}>Testsequenz laden</button><button className="primary" onClick={exportLog}>Testprotokoll herunterladen</button><p className="warning">Du hast bestätigt, dass Bildschirm-aus-Wiedergabe auf deinem Android-Gerät funktioniert. Weitere Headset-, Netz- und Langzeittests sind noch offen.</p></section>}
    </main>
    {tab !== 'radio' && <div className="mini"><span><strong>{track?.title}</strong><small>{statuses[state.status]}</small></span><button onClick={() => active ? player.pause() : void player.start()}>{active ? 'Pause' : 'Start'}</button></div>}
    <nav aria-label="Hauptnavigation">{([['radio', '◉', 'Radio'], ['profile', '☷', 'Mein Programm'], ['test', '⌁', 'Audiotest']] as const).map(([id, icon, label]) => <button key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}><span aria-hidden="true">{icon}</span>{label}</button>)}</nav>
  </div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
