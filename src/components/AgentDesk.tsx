import { useState } from 'react';
import { AGENTS } from '../domain/agents.ts';
import type { AgentConfig, AgentDefinition, AgentId, AgentSettings } from '../domain/agents.ts';
import type { QualityScore } from '../domain/program.ts';
import { api } from '../station-client.ts';

interface Props { value: AgentConfig | undefined; onChange(next: AgentConfig | undefined): void }
type Trial =
  | { state: 'running' }
  | { state: 'done'; itemTitle: string; before: { text: string; quality?: QualityScore }; after: { text: string; quality?: QualityScore } }
  | { state: 'failed'; message: string };

const GROUPS: Array<AgentDefinition['group']> = ['Beiträge', 'Musik', 'Redaktionsteam der Musikstunde'];
const TRIAL_ERRORS: Record<string, string> = {
  NO_ITEM: 'Noch kein fertiger Wortbeitrag im Programm, an dem sich das testen lässt.',
  NOT_CONFIGURED: 'Dafür ist auf dem Server kein Sprachmodell eingerichtet.',
  FAILED: 'Der Probelauf ist fehlgeschlagen.',
};

/** Keeps only what differs from the shipped default, so updates to the defaults still reach the owner. */
function withSettings(config: AgentConfig | undefined, agent: AgentDefinition, patch: AgentSettings): AgentConfig | undefined {
  const merged: AgentSettings = { ...config?.[agent.id], ...patch };
  const clean: AgentSettings = {};
  if (merged.instructions !== undefined && merged.instructions.trim() !== agent.instructions) clean.instructions = merged.instructions;
  if (merged.temperature !== undefined && Math.abs(merged.temperature - agent.temperature) > 1e-9) clean.temperature = merged.temperature;
  if (merged.enabled === false) clean.enabled = false;
  if (merged.threshold !== undefined && merged.threshold !== agent.threshold) clean.threshold = merged.threshold;
  const next: AgentConfig = { ...config };
  if (Object.keys(clean).length) next[agent.id] = clean; else delete next[agent.id];
  return Object.keys(next).length ? next : undefined;
}

function Marks({ quality }: { quality?: QualityScore }) {
  if (!quality) return null;
  return <p className="muted small">★ {quality.overall.toFixed(1)} · Einstieg {quality.hook} · Verständlich {quality.clarity} · Fakten {quality.facts} · Neu {quality.novelty} · Länge {quality.length}{quality.notes ? ` – ${quality.notes}` : ''}</p>;
}

/**
 * The station's editorial agents: what each one does, its editable instructions, how free it may
 * write and, where it makes sense, a switch and a trial run on the last item.
 */
export function AgentDesk({ value, onChange }: Props) {
  const [open, setOpen] = useState<AgentId | null>(null);
  const [trials, setTrials] = useState<Partial<Record<AgentId, Trial>>>({});

  async function trial(agent: AgentDefinition) {
    setTrials(current => ({ ...current, [agent.id]: { state: 'running' } }));
    let result: Trial;
    try {
      const response = await fetch(api('api/agents/trial'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: agent.id, agents: value ?? {} }) });
      const body = await response.json().catch(() => ({})) as { ok?: boolean; error?: string; detail?: string; itemTitle?: string; before?: { text: string; quality?: QualityScore }; after?: { text: string; quality?: QualityScore } };
      result = body.ok && body.before && body.after
        ? { state: 'done', itemTitle: body.itemTitle ?? '', before: body.before, after: body.after }
        : { state: 'failed', message: `${TRIAL_ERRORS[body.error ?? ''] ?? 'Der Probelauf ist fehlgeschlagen.'}${body.detail ? ` (${body.detail})` : ''}` };
    } catch { result = { state: 'failed', message: 'Keine Verbindung zum Server.' }; }
    setTrials(current => ({ ...current, [agent.id]: result }));
  }

  return <div className="agents">{GROUPS.map(group => <div key={group} className="agent-group">
    <h3>{group}</h3>
    {AGENTS.filter(agent => agent.group === group).map(agent => {
      const own = value?.[agent.id] ?? {};
      const enabled = own.enabled !== false, changed = !!value?.[agent.id], expanded = open === agent.id;
      const temperature = own.temperature ?? agent.temperature, instructions = own.instructions ?? agent.instructions;
      const set = (patch: AgentSettings) => onChange(withSettings(value, agent, patch));
      const run = trials[agent.id];
      return <article key={agent.id} className={`show ${enabled ? '' : 'paused'}`} aria-label={`Agent ${agent.name}`}>
        <header className="show-head">
          <button type="button" className="show-toggle" aria-expanded={expanded} aria-label={`${agent.name} ${expanded ? 'zuklappen' : 'bearbeiten'}`} onClick={() => setOpen(expanded ? null : agent.id)}>
            <strong>{agent.name}{changed && <span className="tag">angepasst</span>}</strong>
            <small>{agent.description}</small>
          </button>
          {agent.optional && <label className="switch"><input type="checkbox" checked={enabled} onChange={event => set({ enabled: event.target.checked })} /><span>{enabled ? 'An' : 'Aus'}</span></label>}
        </header>
        {expanded && <>
          <label className="field"><span>Anweisungen</span>
            <textarea rows={agent.id === 'editor' ? 8 : 4} maxLength={3000} value={instructions} placeholder={agent.id === 'verifier' ? 'z. B. Zahlen besonders streng prüfen' : undefined}
              onChange={event => set({ instructions: event.target.value })} />
            <small>{agent.id === 'verifier' ? 'Zusätzliche Hinweise. Sie können die Prüfung verschärfen, aber nicht lockern.' : 'Stil, Schwerpunkte, Kriterien – in eigenen Worten.'}</small>
          </label>
          <label className="field"><span>Schreibweise: {temperature <= 0.2 ? 'genau' : temperature >= 0.7 ? 'frei' : 'ausgewogen'} ({Math.round(temperature * 100)} %)</span>
            <input type="range" min={0} max={1} step={0.05} value={temperature} aria-label={`${agent.name}: genau bis frei`} onChange={event => set({ temperature: Number(event.target.value) })} />
            <small className="range-ends"><span>genau</span><span>frei</span></small>
          </label>
          {agent.threshold !== undefined && <label className="field"><span>Zurück an die Schlussredaktion unter ★ {(own.threshold ?? agent.threshold).toFixed(1)}</span>
            <input type="range" min={1} max={5} step={0.5} value={own.threshold ?? agent.threshold} aria-label="Qualitätsschwelle" onChange={event => set({ threshold: Number(event.target.value) })} />
          </label>}
          <details className="more"><summary>Was fest bleibt</summary><p className="muted small">{agent.contract}</p></details>
          <div className="inline">
            <button type="button" className="button small ghost" disabled={!changed} onClick={() => { const next = { ...value }; delete next[agent.id]; onChange(Object.keys(next).length ? next : undefined); }}>Standard wiederherstellen</button>
            {agent.trial && <button type="button" className="button small" disabled={run?.state === 'running' || (agent.optional && !enabled)} onClick={() => void trial(agent)}>
              {run?.state === 'running' ? 'Probelauf läuft …' : 'Probelauf am letzten Beitrag'}</button>}
          </div>
          {run?.state === 'failed' && <p className="notice error" role="status">{run.message}</p>}
          {run?.state === 'done' && <div className="trial" role="status">
            <p className="muted small">Am Beitrag «{run.itemTitle}» · nichts wurde gespeichert</p>
            <div className="trial-grid">
              <div><h4>Bisher</h4><p className="trial-text">{run.before.text}</p><Marks quality={run.before.quality} /></div>
              <div><h4>{agent.id === 'jury' ? 'Neue Bewertung' : 'Mit diesen Einstellungen'}</h4>{agent.id !== 'jury' && <p className="trial-text">{run.after.text}</p>}<Marks quality={run.after.quality} /></div>
            </div>
          </div>}
        </>}
      </article>;
    })}
  </div>)}</div>;
}
