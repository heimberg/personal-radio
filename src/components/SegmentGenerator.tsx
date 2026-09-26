import { useState } from 'react';
import type { FormEvent } from 'react';
import type { Profile, Source } from '../domain/program.ts';
import type { Track } from '../audio/player.ts';
import type { FeedItem } from '../../server/feed.ts';

interface Props { profile: Profile; onReady(track: Track): void }

export function SegmentGenerator({ profile, onReady }: Props) {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [publishedDate, setPublishedDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [excerpt, setExcerpt] = useState('');
  const [feedUrl, setFeedUrl] = useState('');
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
        : result.error === 'invalid_feed_url' ? 'Bitte eine öffentliche HTTPS-Feed-URL ohne Weiterleitung verwenden.'
        : result.error === 'feed_too_large' ? 'Der Feed überschreitet die erlaubte Grösse von 500 KB.'
        : 'Feed nicht lesbar. Prüfe URL, XML-Format und Erreichbarkeit.');
      setFeedItems(result.items ?? []);
      setMessage(result.items?.length ? `${result.items.length} Beiträge gefunden. Wähle einen aus.` : 'Im Feed wurden keine passenden Beiträge gefunden.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Feed konnte nicht geladen werden.');
    } finally { setLoadingFeed(false); }
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
        body: JSON.stringify({ profile, sources: [source] }),
      });
      if (!response.ok) {
        const details = await response.json().catch(() => ({})) as { error?: string };
        const message = response.status === 404 ? 'Die private KI-API ist auf dieser Demo noch nicht eingerichtet.'
          : response.status === 401 ? 'Bitte zuerst bei deiner privaten Radio-App anmelden.'
          : response.status === 403 ? 'Die Anfrage wurde aus Sicherheitsgründen abgewiesen.'
          : response.status === 422 ? 'ASK konnte die Aussagen nicht ausreichend belegen. Es wurde kein Audio erstellt.'
          : response.status === 429 ? 'Dein Tageslimit ist erreicht. Morgen kannst du es wieder versuchen.'
          : response.status === 503 ? 'Das dauerhafte Kontingent ist gerade nicht erreichbar. Bitte später erneut versuchen.'
          : details.error === 'not_found' ? 'Die private KI-API ist auf dieser Demo noch nicht eingerichtet.'
          : 'Der Beitrag konnte gerade nicht erstellt werden.';
        throw new Error(message);
      }
      if (!response.headers.get('Content-Type')?.startsWith('audio/mpeg')) {
        throw new Error('Die private KI-API ist auf dieser Demo noch nicht eingerichtet.');
      }
      const encodedTitle = response.headers.get('X-Script-Title') ?? 'Dein Beitrag';
      let audioTitle = encodedTitle;
      try { audioTitle = decodeURIComponent(encodedTitle); } catch { /* Keep the safe encoded title. */ }
      const sourceIds = response.headers.get('X-Script-Source-Ids') ?? source.id;
      const audio = await response.blob();
      onReady({ id: crypto.randomUUID(), title: audioTitle, kind: `ASK · Mistral · Quelle ${sourceIds}`, url: URL.createObjectURL(audio) });
      setMessage('Geprüfter Beitrag bereit und im Player gestartet.');
    } catch (error) {
      setMessage(error instanceof Error && error.message.includes('Failed to fetch')
        ? 'Der private KI-Server ist nicht erreichbar. Prüfe Anmeldung und Verbindung.'
        : error instanceof Error ? error.message : 'Unbekannter Fehler beim Erstellen.');
    } finally { setBusy(false); }
  }

  return <section className="panel settings">
    <h2>Beitrag aus einer Quelle</h2>
    <p>Trage einen RSS/Atom-Feed ein oder füge einen Artikel manuell ein. Wähle einen Beitrag; erst beim Erstellen geht der Auszug an ASK.</p>
    <div className="feed-picker">
      <label htmlFor="feed-url">RSS/Atom-Feed URL</label>
      <div className="feed-load-row"><input id="feed-url" type="url" inputMode="url" required={false} value={feedUrl} onChange={event => setFeedUrl(event.target.value)} placeholder="https://…/feed.xml" />
        <button className="secondary" type="button" disabled={loadingFeed || !feedUrl.trim()} onClick={() => void loadFeed()}>{loadingFeed ? 'Lädt …' : 'Feed laden'}</button></div>
      {feedItems.length > 0 && <ul className="feed-results">{feedItems.map(item => <li key={`${item.id}:${item.url}`}><button type="button" onClick={() => selectFeedItem(item)}><strong>{item.title}</strong><small>{new Date(item.publishedAt).toLocaleDateString('de-CH')} · Auszug übernehmen</small></button></li>)}</ul>}
      <p className="privacy-note">Der Feed wird serverseitig abgerufen. Nur HTTPS-URLs, keine Weiterleitungen; höchstens 500 KB und 20 Einträge. Prüfe die Nutzungsbedingungen der jeweiligen Quelle.</p>
    </div>
    <form className="source-form" onSubmit={generate}>
      <label htmlFor="source-title">Titel</label>
      <input id="source-title" required maxLength={300} value={title} onChange={event => setTitle(event.target.value)} placeholder="Titel des Artikels" />
      <label htmlFor="source-url">HTTPS-Link zur Quelle</label>
      <input id="source-url" type="url" required pattern="https://.*" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://…" />
      <label htmlFor="source-date">Veröffentlicht am</label>
      <input id="source-date" type="date" required value={publishedDate} onChange={event => setPublishedDate(event.target.value)} />
      <label htmlFor="source-excerpt">Kurzer Textauszug <span>{excerpt.length}/12’000</span></label>
      <textarea id="source-excerpt" required minLength={1} maxLength={12_000} rows={5} value={excerpt} onChange={event => setExcerpt(event.target.value)} placeholder="Relevanten Auszug hier einfügen …" />
      <p className="privacy-note">Dein Auszug und deine lokal gespeicherten Themen werden zur Erstellung an ASK gesendet. Mistral erhält erst den geprüften Beitragstext.</p>
      <button className="primary" type="submit" disabled={busy}>{busy ? 'Wird erstellt …' : 'Beitrag erstellen und abspielen'}</button>
    </form>
    <p role="status" aria-live="polite">{message}</p>
  </section>;
}
