import { useState } from 'react';
import type { FormEvent } from 'react';
import type { Profile, Source } from '../domain/program.ts';
import type { Track } from '../audio/player.ts';

interface Props { profile: Profile; onReady(track: Track): void }

export function SegmentGenerator({ profile, onReady }: Props) {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [publishedDate, setPublishedDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [excerpt, setExcerpt] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

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
    <p>Füge einen Artikel und einen kurzen Auszug ein. ASK entwirft und prüft den Beitrag; Mistral spricht ihn anschliessend.</p>
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
