import { useState } from 'react';
import { BlockPalette } from './BlockPalette.tsx';
import { MUSIC_SHOW_ID } from '../domain/station.ts';
import type { FailureSummary, StationConfig, TimelineItemView } from '../domain/station.ts';
import { STATE_LABELS, VERIFICATION_LABELS, api, clockTime, errorLabel, post } from '../station-client.ts';

interface Props {
  config: StationConfig;
  items: TimelineItemView[];
  failures: FailureSummary;
  refresh(): Promise<void>;
}

/** What the server has planned and produced, with the controls that change it. */
export function Timeline({ config, items, failures, refresh }: Props) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragged, setDragged] = useState<string | null>(null);
  // Local order while a change is on its way, so the list does not jump back.
  const [pending, setPending] = useState<string[] | null>(null);
  const open = items.filter(item => ['planned', 'voicing', 'ready'].includes(item.state));
  const readyCount = open.filter(item => item.state === 'ready').length;
  const hasProblems = failures.count > 0 || items.some(item => item.error && item.state !== 'ready');
  const openIds = open.map(item => item.id);
  const order = pending && pending.length === openIds.length && pending.every(id => openIds.includes(id)) ? pending : openIds;
  const shown = [...items.filter(item => !openIds.includes(item.id)), ...order.map(id => open.find(item => item.id === id)!)];

  /** Sends a new order of the open items; the server refuses stale orders and the list reloads. */
  async function arrange(next: string[]) {
    setPending(next); setBusy(true);
    try {
      const response = await fetch(api('api/timeline/arrange'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order: next }) });
      setMessage(response.ok ? 'Reihenfolge gespeichert. Die App übernimmt sie beim nächsten Abgleich.' : 'Das Programm hat sich inzwischen geändert – bitte nochmals.');
      await refresh();
    } catch { setMessage('Reihenfolge konnte nicht gespeichert werden.'); }
    finally { setPending(null); setBusy(false); }
  }
  const move = (id: string, offset: number) => {
    const next = [...order], from = next.indexOf(id), to = from + offset;
    if (from < 0 || to < 0 || to >= next.length) return;
    next.splice(to, 0, ...next.splice(from, 1));
    void arrange(next);
  };
  const dropOn = (target: string) => {
    if (!dragged || dragged === target) return;
    const next = order.filter(id => id !== dragged);
    next.splice(next.indexOf(target), 0, dragged);
    setDragged(null);
    void arrange(next);
  };
  const remove = (item: TimelineItemView) => run(async () => { await post(`api/timeline/${item.id}/remove`); return `«${item.title ?? item.showName}» entfernt.`; },
    'Entfernen fehlgeschlagen.');
  const shuffle = () => run(async () => {
    const result = await post<{ added?: number }>('api/timeline/shuffle');
    return `Programm gemischt${result.added ? `, ${result.added} Songs ergänzt` : ''}.`;
  }, 'Mischen fehlgeschlagen.');
  const addSong = () => run(async () => { await post(`api/shows/${MUSIC_SHOW_ID}/produce`); return 'Ein Song wird ausgewählt und hinten angehängt.'; },
    'Song konnte nicht hinzugefügt werden.');

  async function run(action: () => Promise<string>, failure: string) {
    setBusy(true);
    try { setMessage(await action()); await refresh(); }
    catch { setMessage(failure); }
    finally { setBusy(false); }
  }

  const plan = () => run(async () => {
    const result = await post<{ planned?: number; queued?: number }>('api/timeline/plan');
    return `${result.planned ?? 0} neue Beiträge geplant, ${result.queued ?? 0} in Produktion.`;
  }, 'Planung fehlgeschlagen. Prüfe Anmeldung und Server.');

  const cleanup = () => run(async () => `${(await post<{ removed?: number }>('api/timeline/cleanup')).removed ?? 0} Einträge entfernt.`,
    'Aufräumen fehlgeschlagen. Prüfe Anmeldung und Server.');

  /** Retires failed items and restarts waiting ones right away, e.g. after fixing a provider setting. */
  const retry = () => run(async () => {
    const result = await post<{ retired?: number; restarted?: number; planned?: number; queued?: number }>('api/timeline/retry');
    return `${result.retired ?? 0} Fehlschläge abgeräumt, ${result.restarted ?? 0} wartende Beiträge neu gestartet, ${result.planned ?? 0} neu geplant, ${result.queued ?? 0} in Produktion.`;
  }, 'Neuer Versuch fehlgeschlagen. Prüfe Anmeldung und Server.');

  return <section className="card" aria-labelledby="timeline-heading">
    <div className="card-head">
      <div><h2 id="timeline-heading">Programm</h2><p className="muted">{readyCount} bereit · {open.length} geplant · {config.horizonMinutes} Minuten im Voraus</p></div>
      <div className="actions">
        <button className="button ghost" disabled={busy || open.length < 2} onClick={() => void shuffle()}>🔀 Mischen</button>
        <button className="button ghost" disabled={busy} onClick={() => void addSong()}>+ Song</button>
        {hasProblems && <button className="button ghost" disabled={busy} onClick={() => void retry()}>Erneut versuchen</button>}
        <button className="button" disabled={busy} onClick={() => void plan()}>Jetzt planen</button>
      </div>
    </div>

    <BlockPalette busy={busy} onAdded={async message => { setMessage(message); await refresh(); }} onFailed={setMessage} />

    {failures.count > 0 && <div className="alert" role="status">
      <span>⚠ {failures.count} fehlgeschlagen{failures.latestError ? ` · zuletzt ${failures.latestAt ? `${clockTime(failures.latestAt)}: ` : ''}${errorLabel(failures.latestError)}` : ''}</span>
      <button className="button ghost small" disabled={busy} onClick={() => void cleanup()}>Aufräumen</button>
    </div>}

    {items.length === 0 ? <p className="empty">Noch nichts geplant. «Jetzt planen» startet die Produktion.</p> :
      <ol className="timeline" aria-label="Programmablauf">{shown.map(item => {
        const movable = openIds.includes(item.id), index = order.indexOf(item.id);
        return <li key={item.id} data-state={item.state} draggable={movable && !busy}
          className={dragged === item.id ? 'dragging' : undefined}
          onDragStart={() => setDragged(item.id)} onDragEnd={() => setDragged(null)}
          onDragOver={event => { if (movable && dragged) event.preventDefault(); }} onDrop={() => dropOn(item.id)}>
        <span className="timeline-time">{clockTime(item.plannedAt)}</span>
        <div className={`timeline-body ${item.showId === MUSIC_SHOW_ID ? 'song' : ''}`}>
          <strong>{item.showId === MUSIC_SHOW_ID ? '♫ ' : ''}{item.title ?? item.showName}</strong>
          <span className="meta"><span className={`state state-${item.state}`}>{STATE_LABELS[item.state]}</span>{item.showName}{item.verification ? ` · ${VERIFICATION_LABELS[item.verification]}` : ''}</span>
          {item.error && item.state !== 'ready' && <span className="timeline-error">
            {item.updatedAt ? `${clockTime(item.updatedAt)} · ` : ''}{errorLabel(item.error)}{item.state === 'planned' || item.state === 'voicing' ? ' – wird später erneut versucht.' : ''}</span>}
          {item.team && <span className="timeline-team">Redaktionsteam: {item.team.songs} Songs einzeln recherchiert{item.team.specialists ? ` · ${item.team.specialists} Fachrecherchen` : ''} · {item.team.corrections === 0 ? 'Faktencheck ohne Beanstandung' : `${item.team.corrections} Korrekturen im Faktencheck`}</span>}
          {item.parts && item.showId !== MUSIC_SHOW_ID && <span className="timeline-tracks">♫ {item.subject ? `${item.subject}: ` : ''}{item.parts.flatMap(part => part.kind === 'track' ? [part.title] : []).join(' · ')}
            <em> – Musik über Spotify in der App</em></span>}
          {(item.sources?.length || item.searchQueries?.length) ? <span className="timeline-sources">
            {item.sources?.map(source => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.title}</a>)}
            {item.searchQueries?.map(query => <a key={query} className="search" href={`https://www.google.com/search?q=${encodeURIComponent(query)}`} target="_blank" rel="noreferrer">{query}</a>)}
          </span> : null}
        </div>
        {movable && <div className="item-tools" role="group" aria-label={`${item.title ?? item.showName} verschieben`}>
          <button aria-label="Nach oben" disabled={busy || index === 0} onClick={() => move(item.id, -1)}>↑</button>
          <button aria-label="Nach unten" disabled={busy || index === order.length - 1} onClick={() => move(item.id, 1)}>↓</button>
          <button aria-label="Entfernen" disabled={busy} onClick={() => void remove(item)}>×</button>
        </div>}
      </li>; })}</ol>}
    <p className="status" role="status" aria-live="polite">{message}</p>
  </section>;
}
