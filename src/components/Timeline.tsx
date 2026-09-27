import { useState } from 'react';
import type { FailureSummary, StationConfig, TimelineItemView } from '../domain/station.ts';
import { FORMAT_LABELS, STATE_LABELS, VERIFICATION_LABELS, clockTime, errorLabel, post } from '../station-client.ts';

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
  const [produceShow, setProduceShow] = useState('');
  const open = items.filter(item => ['planned', 'voicing', 'ready'].includes(item.state));
  const readyCount = open.filter(item => item.state === 'ready').length;
  const hasProblems = failures.count > 0 || items.some(item => item.error && item.state !== 'ready');
  const chosenShow = produceShow || config.shows[0]?.id;

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

  const produceNow = (showId: string) => run(async () => {
    await post<{ itemId?: string }>(`api/shows/${encodeURIComponent(showId)}/produce`);
    return `«${config.shows.find(show => show.id === showId)?.name ?? showId}» wird produziert.`;
  }, 'Produktion konnte nicht gestartet werden. Prüfe Anmeldung und Server.');

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
        {hasProblems && <button className="button ghost" disabled={busy} onClick={() => void retry()}>Erneut versuchen</button>}
        <button className="button" disabled={busy} onClick={() => void plan()}>Jetzt planen</button>
      </div>
    </div>

    <div className="produce-now">
      <label htmlFor="produce-show">Sendung sofort produzieren</label>
      <div className="inline">
        <select id="produce-show" value={chosenShow} onChange={event => setProduceShow(event.target.value)}>
          {config.shows.map(show => <option key={show.id} value={show.id}>{show.name} · {FORMAT_LABELS[show.format]}{show.enabled ? '' : ' (pausiert)'}</option>)}
        </select>
        <button className="button" disabled={busy || !chosenShow} onClick={() => void produceNow(chosenShow)}>Jetzt produzieren</button>
      </div>
    </div>

    {failures.count > 0 && <div className="alert" role="status">
      <span>⚠ {failures.count} fehlgeschlagen{failures.latestError ? ` · zuletzt ${failures.latestAt ? `${clockTime(failures.latestAt)}: ` : ''}${errorLabel(failures.latestError)}` : ''}</span>
      <button className="button ghost small" disabled={busy} onClick={() => void cleanup()}>Aufräumen</button>
    </div>}

    {items.length === 0 ? <p className="empty">Noch nichts geplant. «Jetzt planen» startet die Produktion.</p> :
      <ol className="timeline" aria-label="Programmablauf">{items.map(item => <li key={item.id} data-state={item.state}>
        <span className="timeline-time">{clockTime(item.plannedAt)}</span>
        <div className="timeline-body">
          <strong>{item.title ?? item.showName}</strong>
          <span className="meta"><span className={`state state-${item.state}`}>{STATE_LABELS[item.state]}</span>{item.showName}{item.verification ? ` · ${VERIFICATION_LABELS[item.verification]}` : ''}</span>
          {item.error && item.state !== 'ready' && <span className="timeline-error">
            {item.updatedAt ? `${clockTime(item.updatedAt)} · ` : ''}{errorLabel(item.error)}{item.state === 'planned' || item.state === 'voicing' ? ' – wird später erneut versucht.' : ''}</span>}
          {item.parts && <span className="timeline-tracks">♫ {item.subject ? `${item.subject}: ` : ''}{item.parts.flatMap(part => part.kind === 'track' ? [part.title] : []).join(' · ')}
            <em> – Musik über Spotify in der App</em></span>}
          {(item.sources?.length || item.searchQueries?.length) ? <span className="timeline-sources">
            {item.sources?.map(source => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.title}</a>)}
            {item.searchQueries?.map(query => <a key={query} className="search" href={`https://www.google.com/search?q=${encodeURIComponent(query)}`} target="_blank" rel="noreferrer">{query}</a>)}
          </span> : null}
        </div>
      </li>)}</ol>}
    <p className="status" role="status" aria-live="polite">{message}</p>
  </section>;
}
