import { useCallback, useEffect, useState } from 'react';
import { api } from '../station-client.ts';

export interface Insights {
  reasons: Array<{ reason: string; label: string; count: number; active: boolean }>;
  notes: string[];
  quality: Array<{ showId: string; showName: string; overall: number; createdAt: string }>;
  changes: Array<{ at: string; agents: string[] }>;
  usage: {
    days: Array<{ day: string; generations: number; ttsCharacters: number; models: Array<{ provider: string; model: string; calls: number; inputTokens: number; outputTokens: number }> }>;
    limits: { generations: number; ttsCharacters: number };
  };
  timezone: string;
}

/** Loads the station's insights (quality, reasons, usage) once; `reload` after a change. */
export function useInsights(): { insights: Insights | null; failed: boolean; reload(): void } {
  const [insights, setInsights] = useState<Insights | null>(null);
  const [failed, setFailed] = useState(false);
  const reload = useCallback(() => {
    fetch(api('api/insights'), { credentials: 'same-origin' })
      .then(response => response.ok ? response.json() as Promise<Insights> : Promise.reject(new Error(String(response.status))))
      .then(value => { setInsights(value); setFailed(false); })
      .catch(() => setFailed(true));
  }, []);
  useEffect(reload, [reload]);
  return { insights, failed, reload };
}

const dayOf = (iso: string, timezone: string) => {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso)); }
  catch { return iso.slice(0, 10); }
};
const shortDay = (day: string) => `${Number(day.slice(8, 10))}.${Number(day.slice(5, 7))}.`;

/**
 * The jury's average mark per day over the last 30 days, with a marker where the owner changed the
 * agents: shows whether a change made the programme better.
 */
export function QualityTrend({ insights }: { insights: Insights }) {
  const [show, setShow] = useState('');
  const [hover, setHover] = useState<number | null>(null);
  const shows = [...new Map(insights.quality.map(entry => [entry.showId, entry.showName])).entries()];
  const entries = insights.quality.filter(entry => !show || entry.showId === show);
  const days = [...entries.reduce((map, entry) => {
    const key = dayOf(entry.createdAt, insights.timezone), day = map.get(key) ?? { sum: 0, count: 0 };
    map.set(key, { sum: day.sum + entry.overall, count: day.count + 1 });
    return map;
  }, new Map<string, { sum: number; count: number }>()).entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([day, value]) => ({ day, average: Math.round(value.sum / value.count * 10) / 10, count: value.count }));
  if (!insights.quality.length) return <p className="muted">Noch keine Noten. Sobald die Jury Beiträge bewertet, erscheint hier der Verlauf der letzten 30 Tage.</p>;

  const width = 340, height = 150, left = 26, right = 8, top = 12, bottom = 22;
  const first = days.length ? Date.parse(days[0].day) : 0, last = days.length ? Date.parse(days[days.length - 1].day) : 0;
  const span = Math.max(1, last - first);
  const x = (day: string) => days.length === 1 ? left + (width - left - right) / 2 : left + (Date.parse(day) - first) / span * (width - left - right);
  const y = (mark: number) => top + (5 - mark) / 4 * (height - top - bottom);
  const changes = insights.changes.map(change => ({ ...change, day: dayOf(change.at, insights.timezone) })).filter(change => days.length > 1 && change.day >= days[0].day && change.day <= days[days.length - 1].day);
  const average = entries.length ? Math.round(entries.reduce((sum, entry) => sum + entry.overall, 0) / entries.length * 10) / 10 : 0;
  const point = hover !== null ? days[hover] : undefined;

  return <div className="trend">
    <div className="trend-head">
      <p className="trend-number"><strong>★ {average.toFixed(1)}</strong><small>Schnitt, {entries.length} {entries.length === 1 ? 'Beitrag' : 'Beiträge'}</small></p>
      {shows.length > 1 && <select aria-label="Sendung für den Verlauf" value={show} onChange={event => setShow(event.target.value)}>
        <option value="">Alle Sendungen</option>
        {shows.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select>}
    </div>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Qualitätsverlauf: ${days.map(day => `${shortDay(day.day)} ${day.average.toFixed(1)}`).join(', ')}`} onMouseLeave={() => setHover(null)}>
      {[1, 2, 3, 4, 5].map(mark => <g key={mark}>
        <line x1={left} x2={width - right} y1={y(mark)} y2={y(mark)} className="trend-grid" />
        <text x={left - 6} y={y(mark) + 3} className="trend-axis" textAnchor="end">{mark}</text>
      </g>)}
      {changes.map((change, index) => <g key={`${change.at}-${index}`}>
        <line x1={x(change.day)} x2={x(change.day)} y1={top} y2={height - bottom} className="trend-change"><title>{`Geändert: ${change.agents.join(', ')}`}</title></line>
        <text x={x(change.day) + 3} y={top + 8} className="trend-axis">✎</text>
      </g>)}
      {days.length > 1 && <polyline className="trend-line" points={days.map(day => `${x(day.day)},${y(day.average)}`).join(' ')} />}
      {days.map((day, index) => <g key={day.day}>
        <circle cx={x(day.day)} cy={y(day.average)} r={hover === index ? 5 : 4} className="trend-dot" />
        <rect x={x(day.day) - 10} y={top} width={20} height={height - top - bottom} fill="transparent" onMouseEnter={() => setHover(index)} onClick={() => setHover(index)} />
      </g>)}
      {days.length > 0 && <>
        <text x={x(days[0].day)} y={height - 6} className="trend-axis" textAnchor={days.length > 1 ? 'start' : 'middle'}>{shortDay(days[0].day)}</text>
        {days.length > 1 && <text x={x(days[days.length - 1].day)} y={height - 6} className="trend-axis" textAnchor="end">{shortDay(days[days.length - 1].day)}</text>}
      </>}
    </svg>
    <p className="muted small trend-caption" aria-live="polite">{point
      ? `${shortDay(point.day)}: ★ ${point.average.toFixed(1)} aus ${point.count} ${point.count === 1 ? 'Beitrag' : 'Beiträgen'}${changes.filter(change => change.day === point.day).map(change => ` · geändert: ${change.agents.join(', ')}`).join('')}`
      : changes.length ? '✎ markiert Tage, an denen du Agenten geändert hast. Tippe auf einen Punkt für Details.' : 'Tippe auf einen Punkt für Details.'}</p>
  </div>;
}

/** What the owner criticised with 👎 and which notes the writer, editor and jury get from it. */
export function ListenerNotes({ insights, onCleared }: { insights: Insights; onCleared(): void }) {
  const [busy, setBusy] = useState(false);
  async function clear() {
    setBusy(true);
    try { await fetch(api('api/insights/reasons'), { method: 'DELETE', credentials: 'same-origin' }); onCleared(); }
    finally { setBusy(false); }
  }
  if (!insights.reasons.length) return <p className="muted">Noch keine Gründe. Wenn du einen Beitrag mit 👎 bewertest, kannst du kurz sagen warum – wiederholte Gründe fliessen hier automatisch in die Redaktion ein.</p>;
  return <div className="listener-notes">
    <ul className="reason-list">{insights.reasons.sort((a, b) => b.count - a.count).map(item => <li key={item.reason} className={item.active ? 'active' : ''}>
      <span>{item.label}</span><strong>{item.count}×</strong>{item.active ? <small>wirkt</small> : <small>ab 2×</small>}
    </li>)}</ul>
    {insights.notes.length > 0 && <p className="muted small">Autorin, Schlussredaktion und Jury achten zurzeit darauf: {insights.notes.join(' ')}</p>}
    <button type="button" className="button small ghost" disabled={busy} onClick={() => void clear()}>Gründe zurücksetzen</button>
  </div>;
}

const number = (value: number) => value.toLocaleString('de-CH');

/** Calls, tokens, productions and speech characters per day (UTC), against the daily limits. */
export function UsageOverview({ insights }: { insights: Insights }) {
  const { days, limits } = insights.usage;
  if (!days.length) return <p className="muted">Noch keine Nutzung in den letzten 14 Tagen.</p>;
  const today = days[0];
  const calls = (day: typeof today) => day.models.reduce((sum, model) => sum + model.calls, 0);
  const tokens = (day: typeof today) => day.models.reduce((sum, model) => sum + model.inputTokens + model.outputTokens, 0);
  return <div className="usage">
    <div className="usage-tiles">
      <div><strong>{today.generations}<small> / {limits.generations}</small></strong><span>Produktionen</span></div>
      <div><strong>{number(today.ttsCharacters)}<small> / {number(limits.ttsCharacters)}</small></strong><span>Sprachzeichen</span></div>
      <div><strong>{calls(today)}</strong><span>KI-Aufrufe</span></div>
      <div><strong>{number(tokens(today))}</strong><span>Tokens</span></div>
    </div>
    <p className="muted small">{today.day === new Date().toISOString().slice(0, 10) ? 'Heute' : shortDay(today.day)} (UTC). Bei Erreichen der Tageslimite pausiert die Produktion bis Mitternacht UTC.</p>
    <details className="more"><summary>Nach Modell</summary>
      <table className="usage-table"><thead><tr><th>Modell</th><th>Aufrufe</th><th>Tokens ein</th><th>Tokens aus</th></tr></thead>
        <tbody>{today.models.map(model => <tr key={`${model.provider}/${model.model}`}><td>{model.provider} · {model.model}</td><td>{model.calls}</td><td>{number(model.inputTokens)}</td><td>{number(model.outputTokens)}</td></tr>)}</tbody>
      </table>
    </details>
    <details className="more"><summary>Letzte 14 Tage</summary>
      <table className="usage-table"><thead><tr><th>Tag</th><th>Produktionen</th><th>Sprachzeichen</th><th>Aufrufe</th><th>Tokens</th></tr></thead>
        <tbody>{days.map(day => <tr key={day.day}><td>{shortDay(day.day)}</td><td>{day.generations}</td><td>{number(day.ttsCharacters)}</td><td>{calls(day)}</td><td>{number(tokens(day))}</td></tr>)}</tbody>
      </table>
    </details>
  </div>;
}
