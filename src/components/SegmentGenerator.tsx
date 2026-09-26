import { useState } from 'react';
import type { FormEvent } from 'react';
import type { Profile, Source } from '../domain/program.ts';
import type { Track } from '../audio/player.ts';
import type { FeedItem } from '../../server/feed.ts';
import { rankCandidates } from '../domain/recommendation.ts';

interface Props { profile: Profile; onReady(track: Track): void }
interface SavedFeed { id: string; name: string; url: string }

function readSavedFeeds(): SavedFeed[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem('radio.feeds.v1') ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((feed): feed is SavedFeed => {
      if (!feed || typeof feed.id !== 'string' || typeof feed.name !== 'string' || typeof feed.url !== 'string' || feed.name.length > 80) return false;
      try { return new URL(feed.url).protocol === 'https:' && Boolean(new URL(feed.url).hostname); } catch { return false; }
    }).slice(0, 20);
  } catch { return []; }
}

export function SegmentGenerator({ profile, onReady }: Props) {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [publishedDate, setPublishedDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [excerpt, setExcerpt] = useState('');
  const [feedUrl, setFeedUrl] = useState('');
  const [feedName, setFeedName] = useState('');
  const [mode, setMode] = useState<'brief' | 'podcast'>('brief');
  const [savedFeeds, setSavedFeeds] = useState(readSavedFeeds);
  const [feedItems, setFeedItems] = useState<FeedItem[]>([]);
  const [loadingFeed, setLoadingFeed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function loadFeed() {
    setLoadingFeed(true); setMessage('Feed wird abgerufen …'); setFeedItems([]);
    try {
      const response = await fetch(new URL('api/feed-items', window.location.href), {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: feedUrl.trim() }),
      });
      const result = await response.json().catch(() => ({})) as { items?: FeedItem[]; error?: string };
      if (!response.ok) throw new Error(response.status === 401 ? 'Bitte bei deiner privaten Radio-App anmelden.'
        : response.status === 429 ? 'Das Tageslimit für Feed-Abrufe ist erreicht. Morgen kannst du es erneut versuchen.'
        : response.status === 503 ? 'Das dauerhafte Feed-Kontingent ist gerade nicht erreichbar.'
        : result.error === 'invalid_feed_url' ? 'Bitte eine öffentliche HTTPS-Feed-URL ohne Weiterleitung verwenden.'
        : result.error === 'feed_too_large' ? 'Der Feed überschreitet die erlaubte Grösse von 500 KB.'
        : 'Feed nicht lesbar. Prüfe URL, XML-Format und Erreichbarkeit.');
      const interests = [...profile.topics, ...profile.interests];
      const candidates = (result.items ?? []).map(item => ({ ...item, interests: interests.filter(interest => `${item.title} ${item.excerpt}`.toLocaleLowerCase().includes(interest.toLocaleLowerCase())) }));
      const ranked = rankCandidates(candidates, interests, profile.interestWeights, profile.exploration, Math.random(), profile.interests);
      setFeedItems(ranked);
      if (ranked[0]) {
        selectFeedItem(ranked[0]);
        setMessage(`${ranked.length} Beiträge gefunden. Der passendste wurde vorausgewählt; du kannst die Auswahl ändern.`);
      } else setMessage('Im Feed wurden keine passenden Beiträge gefunden.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Feed konnte nicht geladen werden.');
    } finally { setLoadingFeed(false); }
  }

  async function discoverFromSavedFeeds() {
    if (!savedFeeds.length) { setMessage('Speichere zuerst deine bevorzugten Feeds.'); return; }
    setLoadingFeed(true); setMessage(`Suche passende Beiträge in ${savedFeeds.length} gespeicherten Feeds …`); setFeedItems([]);
    try {
      const collected: Array<FeedItem & { feedName: string; feedUrl: string }> = [];
      for (let start = 0; start < savedFeeds.length; start += 4) {
        const batch = savedFeeds.slice(start, start + 4);
        const results = await Promise.all(batch.map(async feed => {
          const response = await fetch(new URL('api/feed-items', window.location.href), {
            method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: feed.url }),
          });
          if (!response.ok) return [];
          const result = await response.json() as { items?: FeedItem[] };
          return (result.items ?? []).map(item => ({ ...item, feedName: feed.name, feedUrl: feed.url }));
        }));
        collected.push(...results.flat());
      }
      const unique = [...new Map(collected.map(item => [item.url, item])).values()];
      const interests = [...profile.topics, ...profile.interests];
      const candidates = unique.map(item => ({ ...item, interests: interests.filter(interest => `${item.title} ${item.excerpt}`.toLocaleLowerCase().includes(interest.toLocaleLowerCase())) }));
      const ranked = rankCandidates(candidates, interests, profile.interestWeights, profile.exploration, Math.random(), profile.interests);
      setFeedItems(ranked);
      if (ranked[0]) {
        const selected = ranked[0] as typeof ranked[number] & { feedName: string; feedUrl: string };
        setFeedName(selected.feedName); setFeedUrl(selected.feedUrl); selectFeedItem(selected);
        setMessage(`${unique.length} Beiträge aus deinen Feeds verglichen. «${selected.title}» wurde passend zu deinem Profil vorausgewählt.`);
      } else setMessage('In den gespeicherten Feeds wurden keine Beiträge gefunden.');
    } catch { setMessage('Deine Feeds konnten gerade nicht vollständig durchsucht werden.'); }
    finally { setLoadingFeed(false); }
  }

  function saveFeed() {
    const name = feedName.trim();
    let valid = false;
    try { valid = new URL(feedUrl).protocol === 'https:'; } catch { /* invalid URL */ }
    if (!name || name.length > 80 || !valid) { setMessage('Gib einen Namen und eine gültige HTTPS-Feed-URL ein.'); return; }
    const existing = savedFeeds.find(feed => feed.url === feedUrl.trim());
    if (!existing && savedFeeds.length >= 20) { setMessage('Du kannst höchstens 20 Feeds speichern.'); return; }
    const next = existing
      ? savedFeeds.map(feed => feed.id === existing.id ? { ...feed, name } : feed)
      : [...savedFeeds, { id: crypto.randomUUID(), name, url: feedUrl.trim() }];
    try {
      localStorage.setItem('radio.feeds.v1', JSON.stringify(next));
      setSavedFeeds(next); setMessage('Feed wurde auf diesem Gerät gespeichert.');
    } catch { setMessage('Speicherung blockiert. Prüfe den verfügbaren Gerätespeicher.'); }
  }

  function removeFeed(id: string) {
    const next = savedFeeds.filter(feed => feed.id !== id);
    try {
      localStorage.setItem('radio.feeds.v1', JSON.stringify(next));
      setSavedFeeds(next); setMessage('Feed wurde von diesem Gerät entfernt.');
    } catch { setMessage('Feed konnte nicht entfernt werden.'); }
  }

  function selectFeedItem(item: FeedItem) {
    setTitle(item.title); setUrl(item.url); setPublishedDate(item.publishedAt.slice(0, 10)); setExcerpt(item.excerpt);
    setMessage('Beitrag übernommen. Prüfe den Text und starte danach die Erstellung.');
  }

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage('Beitrag wird erstellt und geprüft …');
    const now = new Date().toISOString();
    const source: Source = {
      id: 'user-source-1', url: url.trim(), title: title.trim(), excerpt: excerpt.trim(),
      publishedAt: new Date(`${publishedDate}T12:00:00.000Z`).toISOString(), retrievedAt: now,
    };
    try {
      const response = await fetch(new URL('api/segments', window.location.href), {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ profile, sources: [source], mode }),
      });
      if (!response.ok) {
        const details = await response.json().catch(() => ({})) as { error?: string };
        const message = response.status === 404 ? 'Die private KI-API ist auf dieser Demo noch nicht eingerichtet.'
          : response.status === 401 ? 'Bitte zuerst bei deiner privaten Radio-App anmelden.'
          : response.status === 403 ? 'Die Anfrage wurde aus Sicherheitsgründen abgewiesen.'
          : response.status === 422 ? 'ASK konnte die Aussagen nicht ausreichend belegen. Es wurde kein Audio erstellt.'
          : response.status === 429 ? 'Dein Tageslimit ist erreicht. Morgen kannst du es wieder versuchen.'
          : response.status === 503 && details.error === 'podcast_provider_not_configured' ? 'Gemini ist für Podcasts noch nicht in der privaten App konfiguriert.'
          : response.status === 503 ? 'Das dauerhafte Kontingent ist gerade nicht erreichbar. Bitte später erneut versuchen.'
          : details.error === 'not_found' ? 'Die private KI-API ist auf dieser Demo noch nicht eingerichtet.'
          : 'Der Beitrag konnte gerade nicht erstellt werden.';
        throw new Error(message);
      }
      const audioType = response.headers.get('Content-Type')?.split(';')[0];
      if (audioType !== 'audio/mpeg' && audioType !== 'audio/wav') {
        throw new Error('Die private KI-API ist auf dieser Demo noch nicht eingerichtet.');
      }
      const encodedTitle = response.headers.get('X-Script-Title') ?? 'Dein Beitrag';
      let audioTitle = encodedTitle;
      try { audioTitle = decodeURIComponent(encodedTitle); } catch { /* Keep the safe encoded title. */ }
      const sourceIds = response.headers.get('X-Script-Source-Ids') ?? source.id;
      const allowedTags: string[] = [...profile.topics, ...profile.interests];
      const interestTags = (response.headers.get('X-Script-Interest-Tags') ?? '').split(',').filter(tag => allowedTags.includes(tag));
      const audio = await response.blob();
      onReady({ id: crypto.randomUUID(), title: audioTitle, kind: mode === 'podcast' ? `Gemini · Zwei Hosts · Quelle ${sourceIds}` : `ASK · Mistral · Quelle ${sourceIds}`, url: URL.createObjectURL(audio), interests: interestTags, feedbackId: crypto.randomUUID() });
      setMessage('Geprüfter Beitrag bereit und im Player gestartet.');
    } catch (error) {
      setMessage(error instanceof Error && error.message.includes('Failed to fetch')
        ? 'Der private KI-Server ist nicht erreichbar. Prüfe Anmeldung und Verbindung.'
        : error instanceof Error ? error.message : 'Unbekannter Fehler beim Erstellen.');
    } finally { setBusy(false); }
  }

  return <section className="panel settings">
    <h2>Beitrag aus einer Quelle</h2>
    <p>Trage einen RSS/Atom-Feed ein oder füge einen Artikel manuell ein. Der ausgewählte Auszug wird erst beim Erstellen an den gewählten KI-Anbieter gesendet.</p>
    <div className="feed-picker">
      <label htmlFor="feed-url">RSS/Atom-Feed URL</label>
      <div className="feed-load-row"><input id="feed-url" type="url" inputMode="url" required={false} value={feedUrl} onChange={event => setFeedUrl(event.target.value)} placeholder="https://…/feed.xml" />
        <button className="secondary" type="button" disabled={loadingFeed || !feedUrl.trim()} onClick={() => void loadFeed()}>{loadingFeed ? 'Lädt …' : 'Feed laden'}</button></div>
      <div className="feed-save-row"><input aria-label="Name des Feeds" maxLength={80} value={feedName} onChange={event => setFeedName(event.target.value)} placeholder="Name, z. B. Lokal Bern" />
        <button className="secondary" type="button" disabled={!feedUrl.trim() || !feedName.trim()} onClick={saveFeed}>Speichern</button></div>
      {savedFeeds.length > 0 && <ul className="saved-feeds" aria-label="Gespeicherte Feeds">{savedFeeds.map(feed => <li key={feed.id}>
        <button type="button" onClick={() => { setFeedName(feed.name); setFeedUrl(feed.url); setFeedItems([]); setMessage(`${feed.name} ausgewählt.`); }}><strong>{feed.name}</strong><small>{new URL(feed.url).hostname}</small></button>
        <button type="button" aria-label={`${feed.name} löschen`} onClick={() => removeFeed(feed.id)}>×</button>
      </li>)}</ul>}
      {savedFeeds.length > 0 && <button className="secondary" type="button" disabled={loadingFeed} onClick={() => void discoverFromSavedFeeds()}>{loadingFeed ? 'Sucht passende Beiträge …' : 'Passenden Beitrag in allen Feeds finden'}</button>}
      {feedItems.length > 0 && <ul className="feed-results">{feedItems.map(item => <li key={`${item.id}:${item.url}`}><button type="button" onClick={() => selectFeedItem(item)}><strong>{item.title}</strong><small>{new Date(item.publishedAt).toLocaleDateString('de-CH')} · Auszug übernehmen</small></button></li>)}</ul>}
      <p className="privacy-note">Der Feed wird serverseitig abgerufen. Nur HTTPS-URLs, keine Weiterleitungen; höchstens 500 KB und 20 Einträge. Prüfe die Nutzungsbedingungen der jeweiligen Quelle.</p>
    </div>
    <form className="source-form" onSubmit={generate}>
      <label htmlFor="generation-mode">Beitragsstil</label>
      <select id="generation-mode" value={mode} onChange={event => setMode(event.target.value as 'brief' | 'podcast')}>
        <option value="brief">Kurzer Radiobeitrag · ASK / Mistral</option>
        <option value="podcast">Podcastdialog mit zwei Hosts · Gemini</option>
      </select>
      <label htmlFor="source-title">Titel</label>
      <input id="source-title" required maxLength={300} value={title} onChange={event => setTitle(event.target.value)} placeholder="Titel des Artikels" />
      <label htmlFor="source-url">HTTPS-Link zur Quelle</label>
      <input id="source-url" type="url" required pattern="https://.*" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://…" />
      <label htmlFor="source-date">Veröffentlicht am</label>
      <input id="source-date" type="date" required value={publishedDate} onChange={event => setPublishedDate(event.target.value)} />
      <label htmlFor="source-excerpt">Kurzer Textauszug <span>{excerpt.length}/12’000</span></label>
      <textarea id="source-excerpt" required minLength={1} maxLength={12_000} rows={5} value={excerpt} onChange={event => setExcerpt(event.target.value)} placeholder="Relevanten Auszug hier einfügen …" />
      <p className="privacy-note">Dein Auszug, deine Interessen und die aus deinem Feedback abgeleiteten Themengewichte gehen an den ausgewählten Textanbieter. Bei kurzen Beiträgen erhält Mistral erst den geprüften Text; beim Podcast vertont Gemini den Dialog mit zwei Stimmen.</p>
      <button className="primary" type="submit" disabled={busy}>{busy ? 'Wird erstellt …' : 'Beitrag erstellen und abspielen'}</button>
    </form>
    <p role="status" aria-live="polite">{message}</p>
  </section>;
}
