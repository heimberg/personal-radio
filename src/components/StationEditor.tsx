import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Topic } from '../domain/program.ts';
import { ConfigError, HOUR_FOCUS, MINUTES_LIMITS, isMusicHour, parseStationConfig } from '../domain/station.ts';
import type { FeedConfig, HourFocus, ScheduleSlot, ShowConfig, ShowFormat, StationConfig } from '../domain/station.ts';
import { FORMAT_LABELS, api } from '../station-client.ts';
import { ListeningProfile } from './ListeningProfile.tsx';

interface Props { config: StationConfig; onSave(next: StationConfig): Promise<boolean> }
interface Voice { id: string; name: string }

const TOPICS: Topic[] = ['Technologie', 'Wissenschaft', 'Kultur'];
const DAYS: Array<[number, string]> = [[1, 'Mo'], [2, 'Di'], [3, 'Mi'], [4, 'Do'], [5, 'Fr'], [6, 'Sa'], [0, 'So']];
const SUBJECT: Record<HourFocus, { key: 'artist' | 'genre' | 'theme'; label: string; example: string }> = {
  artist: { key: 'artist', label: 'Künstler oder Band', example: 'z. B. Portishead' },
  genre: { key: 'genre', label: 'Genre oder Szene', example: 'z. B. Krautrock' },
  theme: { key: 'theme', label: 'Thema', example: 'z. B. Der Mond' },
};
const TIMEZONES = ['Europe/Zurich', 'Europe/Berlin', 'Europe/Vienna', 'Europe/London', 'America/New_York', 'UTC'];

function uniqueId(base: string, taken: string[]): string {
  const slug = base.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'eintrag';
  let id = /^[a-z0-9]/.test(slug) ? slug : `x-${slug}`, n = 2;
  while (taken.includes(id)) id = `${slug}-${n++}`;
  return id;
}

/** A new show of the given format with sensible defaults, so it validates right away. */
function newShow(format: ShowFormat, taken: string[]): ShowConfig {
  const focus = HOUR_FOCUS[format];
  return {
    id: uniqueId(FORMAT_LABELS[format], taken), name: FORMAT_LABELS[format], enabled: true, format, instructions: '', feedIds: [],
    targetMinutes: focus ? 60 : format === 'podcast' ? 5 : 2, verification: focus ? 'light' : 'strict', textProvider: 'gemini',
    sourceMode: 'web', researchPrompt: '', ...(focus ? { tracks: focus === 'theme' ? 8 : 10, talkSeconds: focus === 'theme' ? 120 : 60 } : {}),
  };
}

/** Switching the format keeps what still fits and brings the rest within the new limits. */
function withFormat(show: ShowConfig, format: ShowFormat): ShowConfig {
  const [min, max] = MINUTES_LIMITS[format], focus = HOUR_FOCUS[format];
  const { artist: _a, genre: _g, theme: _t, tracks: _n, talkSeconds: _s, ...rest } = show;
  return {
    ...rest, format, targetMinutes: Math.min(max, Math.max(min, show.targetMinutes)),
    ...(format === 'podcast' || focus ? { textProvider: 'gemini' as const } : {}),
    ...(focus ? { sourceMode: 'web' as const, tracks: show.tracks ?? (focus === 'theme' ? 8 : 10), talkSeconds: show.talkSeconds ?? (focus === 'theme' ? 120 : 60) } : {}),
  };
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <section className="card editor-section" aria-label={title}>
    <h2>{title}</h2><p className="muted">{description}</p>{children}
  </section>;
}

/** Fields added after a configuration was stored get their defaults, as on the server. */
const complete = (config: StationConfig): StationConfig => structuredClone({ ...config, music: config.music ?? { between: 0, announce: true, taste: '' } });

export function StationEditor({ config: stored, onSave }: Props) {
  const config = complete(stored);
  const [draft, setDraft] = useState<StationConfig>(() => complete(stored));
  const [voices, setVoices] = useState<Voice[]>([]);
  const [interest, setInterest] = useState('');
  const [newFormat, setNewFormat] = useState<ShowFormat>('theme_hour');
  const [problem, setProblem] = useState('');
  const [saving, setSaving] = useState(false);
  // Show cards are collapsed to one line; new ones open right away.
  const [expanded, setExpanded] = useState<string[]>([]);
  const toggle = (id: string) => setExpanded(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(config);

  useEffect(() => { setDraft(complete(stored)); }, [stored]);
  useEffect(() => {
    fetch(api('api/mistral-voices'), { credentials: 'same-origin' })
      .then(response => response.ok ? response.json() as Promise<{ voices?: Voice[] }> : { voices: [] })
      .then(result => setVoices(result.voices ?? []))
      .catch(() => setVoices([]));
  }, []);

  const change = (update: (next: StationConfig) => void) => setDraft(current => { const next = structuredClone(current); update(next); return next; });
  const changeShow = (index: number, update: (show: ShowConfig) => ShowConfig) => change(next => { next.shows[index] = update(next.shows[index]); });
  const changeSlot = (index: number, update: (slot: ScheduleSlot) => ScheduleSlot) => change(next => { next.schedule[index] = update(next.schedule[index]); });
  const changeFeed = (index: number, update: (feed: FeedConfig) => FeedConfig) => change(next => { next.feeds[index] = update(next.feeds[index]); });

  async function save() {
    setProblem('');
    let parsed: StationConfig;
    try { parsed = parseStationConfig(draft); }
    catch (error) { setProblem(error instanceof ConfigError ? `Bitte korrigieren – ${error.message}` : 'Die Einstellungen sind unvollständig.'); return; }
    setSaving(true);
    try { await onSave(parsed); } finally { setSaving(false); }
  }

  const voiceOptions = (current?: string) => {
    const known = voices.some(voice => voice.id === current);
    return <>{voices.map(voice => <option key={voice.id} value={voice.id}>{voice.name}</option>)}
      {current && !known && <option value={current}>{current}</option>}</>;
  };

  return <div className="editor">
    <Section title="Sender und Moderation" description="Wie dein Radio heisst und wer spricht. Die Persona prägt jeden Beitrag.">
      <div className="grid">
        <Field label="Name des Senders"><input value={draft.name} maxLength={60} onChange={event => change(next => { next.name = event.target.value; })} /></Field>
        <Field label="Moderation"><input value={draft.host.name} maxLength={40} onChange={event => change(next => { next.host.name = event.target.value; })} /></Field>
        <Field label="Tonfall" hint="z. B. ruhig, neugierig, präzise"><input value={draft.host.tone} maxLength={160} onChange={event => change(next => { next.host.tone = event.target.value; })} /></Field>
        <Field label="Stil" hint="z. B. persönliches Hintergrundradio"><input value={draft.host.style} maxLength={160} onChange={event => change(next => { next.host.style = event.target.value; })} /></Field>
        <Field label="Stimme">
          <select value={draft.host.voiceId ?? ''} onChange={event => change(next => { if (event.target.value) next.host.voiceId = event.target.value; else delete next.host.voiceId; })}>
            <option value="">Standard</option>{voiceOptions(draft.host.voiceId)}
          </select>
        </Field>
        <Field label="Co-Moderation in Dialogen"><input value={draft.host.cohostName ?? ''} maxLength={40} onChange={event => change(next => { next.host.cohostName = event.target.value; })} /></Field>
      </div>
      <Field label="Sprechstil" hint="Wie die Stimme spricht – Gemini-Stimmen folgen dieser Anweisung, z. B. «begeistert, warm, mit Tempowechseln und hörbarem Lächeln».">
        <input value={draft.host.voiceStyle ?? ''} maxLength={300} onChange={event => change(next => { next.host.voiceStyle = event.target.value; })} />
      </Field>
      <Field label="Anweisungen an die Moderation" hint="Gilt für alle Sendungen.">
        <textarea rows={3} maxLength={2000} value={draft.host.instructions} onChange={event => change(next => { next.host.instructions = event.target.value; })} />
      </Field>
    </Section>

    <Section title="Interessen" description="Worüber recherchiert wird, wenn eine Sendung selbst wählen darf. Dein Feedback gewichtet sie mit der Zeit.">
      <div className="chips">{TOPICS.map(topic => <button type="button" key={topic} aria-pressed={draft.profile.topics.includes(topic)}
        onClick={() => change(next => { next.profile.topics = next.profile.topics.includes(topic) ? next.profile.topics.filter(item => item !== topic) : [...next.profile.topics, topic]; })}>{topic}</button>)}</div>
      <form className="inline" onSubmit={event => {
        event.preventDefault();
        const value = interest.trim();
        if (!value || draft.profile.interests.some(item => item.toLowerCase() === value.toLowerCase()) || draft.profile.interests.length >= 30) return;
        change(next => { next.profile.interests.push(value); }); setInterest('');
      }}>
        <label className="sr-only" htmlFor="interest">Eigenes Interesse</label>
        <input id="interest" value={interest} maxLength={48} placeholder="Eigenes Interesse, z. B. Geologie" onChange={event => setInterest(event.target.value)} />
        <button className="button" type="submit" disabled={!interest.trim()}>Hinzufügen</button>
      </form>
      <div className="chips">{draft.profile.interests.map(item => <button type="button" key={item} className="removable" aria-label={`${item} entfernen`}
        onClick={() => change(next => { next.profile.interests = next.profile.interests.filter(value => value !== item); })}>{item} <span aria-hidden="true">×</span></button>)}</div>
      <Field label={`Neues entdecken: ${draft.profile.exploration} %`} hint="Platz für Themen ausserhalb deiner Interessen.">
        <input type="range" min={0} max={50} step={5} value={draft.profile.exploration} onChange={event => change(next => { next.profile.exploration = Number(event.target.value); })} />
      </Field>
    </Section>

    <Section title="Musik" description="Songs zwischen den Beiträgen. Die KI wählt nach deinem Geschmack, Spotify spielt sie in der App. Deine 👍/👎 auf Songs verfeinern die Auswahl.">
      <Field label={draft.music.between === 0 ? 'Songs zwischen Beiträgen: aus' : `Songs zwischen Beiträgen: ${draft.music.between}`} hint="Nach jedem Wortbeitrag. Musikstunden bringen ihre eigene Musik mit.">
        <input type="range" min={0} max={3} value={draft.music.between} onChange={event => change(next => { next.music.between = Number(event.target.value); })} />
      </Field>
      <Field label="Musikgeschmack" hint="Genres, Künstler, Stimmungen – so konkret wie möglich.">
        <textarea rows={2} maxLength={500} value={draft.music.taste} placeholder="z. B. Industrial, Indie, Rock – eher spezifisch, gern Nine Inch Nails, Einstürzende Neubauten, Protomartyr" onChange={event => change(next => { next.music.taste = event.target.value; })} />
      </Field>
      <ListeningProfile />
      <label className="check"><input type="checkbox" checked={draft.music.announce} onChange={event => change(next => { next.music.announce = event.target.checked; })} />Kurze Ansage vor jedem Song</label>
    </Section>

    <Section title="Sendungen" description="Jede Sendung ist ein Format mit eigenem Auftrag. Musikstunden wechseln Moderation und Songs über Spotify ab.">
      <div className="shows">{draft.shows.map((show, index) => {
        const focus = HOUR_FOCUS[show.format];
        const [min, max] = MINUTES_LIMITS[show.format];
        const subject = focus ? SUBJECT[focus] : null;
        const open = expanded.includes(show.id);
        return <article key={show.id} className={`show ${show.enabled ? '' : 'paused'}`} aria-label={`Sendung ${show.name}`}>
          <header className="show-head">
            <button type="button" className="show-toggle" aria-expanded={open} aria-label={`${show.name} ${open ? 'zuklappen' : 'bearbeiten'}`} onClick={() => toggle(show.id)}>
              <strong>{show.name || 'Ohne Namen'}</strong>
              <small>{FORMAT_LABELS[show.format]} · {show.targetMinutes} Min.{subject && show[subject.key] ? ` · ${show[subject.key]}` : ''}</small>
            </button>
            <label className="switch"><input type="checkbox" checked={show.enabled} onChange={event => changeShow(index, current => ({ ...current, enabled: event.target.checked }))} /><span>{show.enabled ? 'Aktiv' : 'Pausiert'}</span></label>
          </header>
          {open && <>
          <Field label="Name"><input value={show.name} maxLength={80} onChange={event => changeShow(index, current => ({ ...current, name: event.target.value }))} /></Field>
          <div className="grid">
            <Field label="Format">
              <select value={show.format} onChange={event => changeShow(index, current => withFormat(current, event.target.value as ShowFormat))}>
                {(Object.keys(FORMAT_LABELS) as ShowFormat[]).map(format => <option key={format} value={format}>{FORMAT_LABELS[format]}</option>)}
              </select>
            </Field>
            <Field label={`Länge: ${show.targetMinutes} Min.`} hint={`${min}–${max} Minuten`}>
              <input type="range" min={min} max={max} step={focus ? 5 : 1} value={show.targetMinutes} onChange={event => changeShow(index, current => ({ ...current, targetMinutes: Number(event.target.value) }))} />
            </Field>
            {subject && <Field label={subject.label} hint="Leer lassen: die KI wählt aus deinen Interessen.">
              <input value={show[subject.key] ?? ''} maxLength={200} placeholder={subject.example} onChange={event => changeShow(index, current => ({ ...current, [subject.key]: event.target.value }))} />
            </Field>}
            {focus && <Field label={`Songs: ${show.tracks ?? 10}`}>
              <input type="range" min={3} max={15} value={show.tracks ?? 10} onChange={event => changeShow(index, current => ({ ...current, tracks: Number(event.target.value) }))} />
            </Field>}
            {focus && <Field label={`Moderation vor jedem Song: ${show.talkSeconds ?? 60} s`}>
              <input type="range" min={20} max={180} step={10} value={show.talkSeconds ?? 60} onChange={event => changeShow(index, current => ({ ...current, talkSeconds: Number(event.target.value) }))} />
            </Field>}
            {!focus && <Field label="Quellen">
              <select value={show.sourceMode} onChange={event => changeShow(index, current => ({ ...current, sourceMode: event.target.value as ShowConfig['sourceMode'] }))}>
                <option value="web">Websuche (Google)</option><option value="feeds">Meine Feeds</option>
              </select>
            </Field>}
            {show.format === 'brief' && <Field label="Text schreibt">
              <select value={show.textProvider} onChange={event => changeShow(index, current => ({ ...current, textProvider: event.target.value as ShowConfig['textProvider'] }))}>
                <option value="gemini">Gemini</option><option value="ask">ASK</option>
              </select>
            </Field>}
            <Field label="Quellenprüfung">
              <select value={show.verification} onChange={event => changeShow(index, current => ({ ...current, verification: event.target.value as ShowConfig['verification'] }))}>
                <option value="strict">Streng – jede Aussage belegt</option><option value="light">Leicht – quellenbasiert</option><option value="off">Aus</option>
              </select>
            </Field>
            {show.format !== 'podcast' && <Field label="Stimme">
              <select value={show.voiceId ?? ''} onChange={event => changeShow(index, current => { const { voiceId: _v, ...rest } = current; return event.target.value ? { ...rest, voiceId: event.target.value } : rest; })}>
                <option value="">Wie die Moderation</option>{voiceOptions(show.voiceId)}
              </select>
            </Field>}
          </div>
          {!focus && show.sourceMode === 'feeds' && <fieldset className="feed-picks"><legend>Feeds dieser Sendung</legend>
            {draft.feeds.length === 0 ? <small className="muted">Noch keine Feeds – unten hinzufügen.</small> : draft.feeds.map(feed => <label key={feed.id} className="check">
              <input type="checkbox" checked={show.feedIds.includes(feed.id)} onChange={event => changeShow(index, current => ({ ...current,
                feedIds: event.target.checked ? [...current.feedIds, feed.id] : current.feedIds.filter(id => id !== feed.id) }))} />{feed.name}</label>)}
          </fieldset>}
          {(focus || show.sourceMode === 'web') && <Field label={focus ? 'Zusätzlicher Rechercheauftrag' : 'Rechercheauftrag'} hint="Wonach die Websuche suchen soll.">
            <textarea rows={2} maxLength={1000} value={show.researchPrompt} onChange={event => changeShow(index, current => ({ ...current, researchPrompt: event.target.value }))} />
          </Field>}
          <Field label="Redaktionelle Anweisungen" hint="Dein eigener Prompt für diese Sendung.">
            <textarea rows={2} maxLength={2000} value={show.instructions} onChange={event => changeShow(index, current => ({ ...current, instructions: event.target.value }))} />
          </Field>
          <div className="row-end"><button type="button" className="button ghost small danger" onClick={() => change(next => {
            next.shows.splice(index, 1);
            next.schedule = next.schedule.map(slot => ({ ...slot, showIds: slot.showIds.filter(id => id !== show.id) }));
          })}>Sendung entfernen</button></div>
          </>}
        </article>;
      })}</div>
      <div className="inline add">
        <label className="sr-only" htmlFor="new-format">Format der neuen Sendung</label>
        <select id="new-format" value={newFormat} onChange={event => setNewFormat(event.target.value as ShowFormat)}>
          {(Object.keys(FORMAT_LABELS) as ShowFormat[]).map(format => <option key={format} value={format}>{FORMAT_LABELS[format]}{isMusicHour(format) ? ' ♫' : ''}</option>)}
        </select>
        <button type="button" className="button" disabled={draft.shows.length >= 20} onClick={() => {
          const show = newShow(newFormat, draft.shows.map(item => item.id));
          change(next => { next.shows.push(show); });
          setExpanded(current => [...current, show.id]);
        }}>Sendung hinzufügen</button>
      </div>
    </Section>

    <Section title="Sendeuhr" description="Wann welche Sendungen laufen. Innerhalb eines Zeitfensters wechseln sie sich ab.">
      <div className="slots">{draft.schedule.map((slot, index) => <div key={slot.id} className="slot" aria-label={`Zeitfenster ${index + 1}`}>
        <div className="days" role="group" aria-label="Wochentage">{DAYS.map(([day, label]) => <button type="button" key={day} aria-pressed={slot.days.includes(day)}
          onClick={() => changeSlot(index, current => ({ ...current, days: current.days.includes(day) ? current.days.filter(value => value !== day) : [...current.days, day].sort() }))}>{label}</button>)}</div>
        <div className="inline times">
          <Field label="Von"><input value={slot.from} inputMode="numeric" pattern="\d\d:\d\d" maxLength={5} onChange={event => changeSlot(index, current => ({ ...current, from: event.target.value }))} /></Field>
          <Field label="Bis"><input value={slot.to} inputMode="numeric" pattern="\d\d:\d\d" maxLength={5} onChange={event => changeSlot(index, current => ({ ...current, to: event.target.value }))} /></Field>
        </div>
        <div className="chips">{draft.shows.map(show => <button type="button" key={show.id} aria-pressed={slot.showIds.includes(show.id)}
          onClick={() => changeSlot(index, current => ({ ...current, showIds: current.showIds.includes(show.id) ? current.showIds.filter(id => id !== show.id) : [...current.showIds, show.id] }))}>{show.name}</button>)}</div>
        <div className="row-end"><button type="button" className="button ghost small danger" onClick={() => change(next => { next.schedule.splice(index, 1); })}>Zeitfenster entfernen</button></div>
      </div>)}</div>
      <button type="button" className="button" disabled={draft.schedule.length >= 50} onClick={() => change(next => {
        next.schedule.push({ id: uniqueId('fenster', next.schedule.map(slot => slot.id)), days: [1, 2, 3, 4, 5], from: '07:00', to: '09:00', showIds: next.shows.filter(show => show.enabled).map(show => show.id).slice(0, 3) });
      })}>Zeitfenster hinzufügen</button>
      <div className="grid spaced">
        <Field label="Zeitzone"><input list="timezones" value={draft.timezone} maxLength={64} onChange={event => change(next => { next.timezone = event.target.value; })} /></Field>
        <datalist id="timezones">{TIMEZONES.map(zone => <option key={zone} value={zone} />)}</datalist>
        <Field label={`Im Voraus produzieren: ${draft.horizonMinutes} Min.`}>
          <input type="range" min={10} max={120} step={5} value={draft.horizonMinutes} onChange={event => change(next => { next.horizonMinutes = Number(event.target.value); })} />
        </Field>
      </div>
    </Section>

    <Section title="Feeds" description="RSS- oder Atom-Feeds für Sendungen mit der Quelle «Meine Feeds».">
      <div className="feeds">{draft.feeds.map((feed, index) => <div key={feed.id} className="inline feed">
        <input aria-label="Name des Feeds" value={feed.name} maxLength={80} onChange={event => changeFeed(index, current => ({ ...current, name: event.target.value }))} />
        <input aria-label="Adresse des Feeds" type="url" value={feed.url} placeholder="https://…" onChange={event => changeFeed(index, current => ({ ...current, url: event.target.value }))} />
        <button type="button" className="button ghost small danger" aria-label={`${feed.name} entfernen`} onClick={() => change(next => {
          next.feeds.splice(index, 1);
          next.shows = next.shows.map(show => ({ ...show, feedIds: show.feedIds.filter(id => id !== feed.id) }));
        })}>×</button>
      </div>)}</div>
      <button type="button" className="button" disabled={draft.feeds.length >= 30} onClick={() => change(next => {
        next.feeds.push({ id: uniqueId('feed', next.feeds.map(feed => feed.id)), name: 'Neuer Feed', url: 'https://' });
      })}>Feed hinzufügen</button>
    </Section>

    <div className={`savebar ${dirty ? 'visible' : ''}`} role="region" aria-label="Änderungen">
      <span>{problem || (dirty ? 'Ungespeicherte Änderungen' : 'Alles gespeichert')}</span>
      <button type="button" className="button ghost" disabled={!dirty || saving} onClick={() => { setDraft(structuredClone(config)); setProblem(''); }}>Verwerfen</button>
      <button type="button" className="button primary" disabled={!dirty || saving} onClick={() => void save()}>Speichern</button>
    </div>
  </div>;
}
