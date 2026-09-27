import { useEffect, useState } from 'react';
import type { StationConfig } from '../domain/station.ts';

interface Props { config: StationConfig; onSave(next: unknown): Promise<boolean> }

const HELP = [
  '# host: Moderations-Persona – name, tone, style, instructions, voiceId (gemini_Laomedeia, gemini_Puck … oder Mistral de_kerstin_cc0),',
  '#       voiceStyle = wie gesprochen wird (Gemini-Stimmen); cohostName spricht in Dialog-Sendungen mit',
  '# shows: instructions = eigener Prompt · format brief (1–2 Min.) oder podcast (2–10 Min.) · verification strict | light | off',
  '#        textProvider gemini | ask · sourceMode feeds (feedIds) | web (Google-Suche, researchPrompt = Rechercheauftrag)',
  '#        format artist_hour | genre_hour | theme_hour (20–90 Min.): artist | genre | theme (leer = KI wählt),',
  '#          tracks 3–15, talkSeconds 20–180 – Musik über Spotify zwischen den Moderationen',
  '# music: between 0–3 Songs nach jedem Wortbeitrag · announce true/false (kurze Ansage) · taste = dein Musikgeschmack',
  '# schedule: days 0 (So) bis 6 (Sa), from/to HH:MM in timezone · showIds werden abwechselnd gesendet',
].join('\n');

/** The whole configuration as YAML, for bulk edits and copying between stations. */
export function YamlEditor({ config, onSave }: Props) {
  const [text, setText] = useState<string | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

  // The YAML library is only loaded when this view opens.
  useEffect(() => {
    let active = true;
    void import('yaml').then(({ stringify }) => { if (active) setText(`${HELP}\n${stringify(config, { lineWidth: 0 })}`); });
    return () => { active = false; };
  }, [config]);

  async function save() {
    const { parse } = await import('yaml');
    let parsed: unknown;
    try { parsed = parse(text ?? ''); }
    catch (error) { setProblem(`Kein gültiges YAML – ${error instanceof Error ? error.message.split('\n')[0] : 'unbekannter Fehler'}`); return; }
    setProblem(''); setBusy(true);
    try { await onSave(parsed); } finally { setBusy(false); }
  }

  return <section className="card" aria-labelledby="yaml-heading">
    <h2 id="yaml-heading">YAML</h2>
    <p className="muted">Die ganze Konfiguration als Text. Gespeichert wird nur, was gültig ist.</p>
    <label className="sr-only" htmlFor="station-config">Konfiguration als YAML</label>
    <textarea id="station-config" className="code" rows={24} spellCheck={false} value={text ?? 'Wird geladen …'} disabled={text === null} onChange={event => setText(event.target.value)} />
    <div className="row-end">
      {problem && <span className="problem" role="alert">{problem}</span>}
      <button className="button primary" disabled={busy || text === null} onClick={() => void save()}>YAML speichern</button>
    </div>
  </section>;
}
