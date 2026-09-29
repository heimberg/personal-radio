import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Topic } from '../domain/program.ts';
import { ConfigError, DEFAULT_TRIGGERS, HOUR_FOCUS, MINUTES_LIMITS, bringsOwnMusic, parseStationConfig, playlistId } from '../domain/station.ts';
import type { BlockTriggers, FeedConfig, HourFocus, PlaylistGroup, ShowConfig, ShowFormat, ShowTool, StationConfig } from '../domain/station.ts';
import { FORMAT_LABELS, api } from '../station-client.ts';
import { ListeningProfile } from './ListeningProfile.tsx';
import { LocationPicker } from './LocationPicker.tsx';
import { DayPlan } from './DayPlan.tsx';
import { AgentDesk } from './AgentDesk.tsx';
import { ListenerNotes, QualityTrend, UsageOverview, useInsights } from './Insights.tsx';

interface Props { config: StationConfig; onSave(next: StationConfig): Promise<boolean> }
interface Voice { id: string; name: string }

const TOPICS: Topic[] = ['Technologie', 'Wissenschaft', 'Kultur'];
const SUBJECT: Record<HourFocus, { key: 'artist' | 'genre' | 'theme'; label: string; example: string }> = {
  artist: { key: 'artist', label: 'Künstler oder Band', example: 'z. B. Portishead' },
  genre: { key: 'genre', label: 'Genre oder Szene', example: 'z. B. Krautrock' },
  theme: { key: 'theme', label: 'Thema', example: 'z. B. Der Mond' },
};
/** Live information a spoken show can work in; the server fetches it when it produces the item. */
const TOOLS: Array<[ShowTool, string]> = [['clock', 'Datum und Uhrzeit'], ['weather', 'Wetter'], ['headlines', 'Schlagzeilen']];
const TIMEZONES = ['Europe/Zurich', 'Europe/Berlin', 'Europe/Vienna', 'Europe/London', 'America/New_York', 'UTC'];

function uniqueId(base: string, taken: string[]): string {
  const slug = base.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'eintrag';
  let id = /^[a-z0-9]/.test(slug) ? slug : `x-${slug}`, n = 2;
  while (taken.includes(id)) id = `${slug}-${n++}`;
  return id;
}

const BLOCK_DEFAULTS: Pick<ShowConfig, 'groups' | 'switchAfterTracks' | 'switchAfterMinutes' | 'triggers' | 'talkSeconds'> = {
  groups: [{ name: 'Mein Geschmack', playlists: [], taste: '' }], switchAfterTracks: 3, switchAfterMinutes: 0, triggers: { ...DEFAULT_TRIGGERS }, talkSeconds: 20,
};

/** A new show of the given format with sensible defaults, so it validates right away. */
function newShow(format: ShowFormat, taken: string[]): ShowConfig {
  const focus = HOUR_FOCUS[format];
  return {
    id: uniqueId(FORMAT_LABELS[format], taken), name: FORMAT_LABELS[format], enabled: true, format, instructions: '', feedIds: [],
    targetMinutes: focus ? 60 : format === 'music_block' ? 30 : format === 'podcast' ? 5 : 2, verification: focus ? 'light' : format === 'music_block' ? 'off' : 'strict', textProvider: 'gemini',
    sourceMode: 'web', researchPrompt: '', ...(focus ? { tracks: focus === 'theme' ? 8 : 10, talkSeconds: focus === 'theme' ? 120 : 60 } : {}),
    ...(format === 'music_block' ? structuredClone(BLOCK_DEFAULTS) : {}),
  };
}

/** Switching the format keeps what still fits and brings the rest within the new limits. */
function withFormat(show: ShowConfig, format: ShowFormat): ShowConfig {
  const [min, max] = MINUTES_LIMITS[format], focus = HOUR_FOCUS[format];
  const { artist: _a, genre: _g, theme: _t, tracks: _n, talkSeconds: _s, groups: _gr, switchAfterTracks: _st, switchAfterMinutes: _sm, triggers: _tr, ...rest } = show;
  return {
    ...rest, format, targetMinutes: Math.min(max, Math.max(min, show.targetMinutes)),
    ...(format === 'podcast' || focus || format === 'music_block' ? { textProvider: 'gemini' as const } : {}),
    ...(format === 'music_block' ? { ...structuredClone(BLOCK_DEFAULTS), ...(show.format === 'music_block' ? { groups: show.groups, switchAfterTracks: show.switchAfterTracks, switchAfterMinutes: show.switchAfterMinutes, triggers: show.triggers, talkSeconds: show.talkSeconds } : {}) } : {}),
    ...(focus ? { sourceMode: 'web' as const, tracks: show.tracks ?? (focus === 'theme' ? 8 : 10), talkSeconds: show.talkSeconds ?? (focus === 'theme' ? 120 : 60) } : {}),
  };
}

const linesOf = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 5);
/** Stored playlists are bare IDs; the owner sees and pastes links. */
const asLink = (value: string) => /^[A-Za-z0-9]{22}$/.test(value) ? `https://open.spotify.com/playlist/${value}` : value;

/** Keeps the typed text (blank lines included) while the configuration gets the cleaned list. */
function PlaylistLinks({ value, onChange }: { value: string[]; onChange(playlists: string[]): void }) {
  const [text, setText] = useState(() => value.map(asLink).join('\n'));
  useEffect(() => {
    // Reset only when the list changed from outside (discard, save), not while typing.
    setText(current => JSON.stringify(linesOf(current)) === JSON.stringify(value) || JSON.stringify(linesOf(current).map(line => playlistId(line) ?? line)) === JSON.stringify(value) ? current : value.map(asLink).join('\n'));
  }, [value]);
  return <textarea rows={3} value={text} placeholder="https://open.spotify.com/playlist/…"
    onChange={event => { setText(event.target.value); onChange(linesOf(event.target.value)); }} />;
}

/** Groups, rotation and moderation triggers of a music block. */
function BlockSettings({ show, onChange }: { show: ShowConfig; onChange(update: (show: ShowConfig) => ShowConfig): void }) {
  const groups = show.groups ?? [], triggers = show.triggers ?? DEFAULT_TRIGGERS;
  const setGroup = (index: number, patch: Partial<PlaylistGroup>) => onChange(current => ({ ...current, groups: (current.groups ?? []).map((group, i) => i === index ? { ...group, ...patch } : group) }));
  const setTrigger = (patch: Partial<BlockTriggers>) => onChange(current => ({ ...current, triggers: { ...(current.triggers ?? DEFAULT_TRIGGERS), ...patch } }));
  const every = (value: number, unit: string) => value === 0 ? 'aus' : value === 1 ? `jede${unit === 'Min.' ? ' Minute' : 'n Song'}` : `alle ${value} ${unit}`;
  return <>
    <fieldset className="block-groups"><legend>Gruppen</legend>
      <small className="muted">Mit Playlists spielt Spotify deine eigenen Songs gemischt – die KI erfährt nichts über sie und moderiert allgemein. Ohne Playlists wählt die KI nach dem Geschmack der Gruppe und nennt ihre Songs.</small>
      {groups.map((group, index) => <div key={index} className="block-group" aria-label={`Gruppe ${index + 1}`}>
        <div className="group-head">
          <input aria-label="Name der Gruppe" value={group.name} maxLength={60} onChange={event => setGroup(index, { name: event.target.value })} />
          <button type="button" className="button ghost small danger" aria-label={`${group.name} entfernen`} disabled={groups.length <= 1}
            onClick={() => onChange(current => ({ ...current, groups: (current.groups ?? []).filter((_, i) => i !== index) }))}>×</button>
        </div>
        <Field label="Spotify-Playlists" hint="Ein Link pro Zeile (Teilen → Link kopieren). Leer: die KI wählt.">
          <PlaylistLinks value={group.playlists} onChange={playlists => setGroup(index, { playlists })} />
        </Field>
        {!group.playlists.length && <Field label="Geschmack dieser Gruppe" hint="Leer: dein allgemeiner Musikgeschmack.">
          <input value={group.taste} maxLength={500} placeholder="z. B. Krautrock und frühe Elektronik" onChange={event => setGroup(index, { taste: event.target.value })} />
        </Field>}
      </div>)}
      <button type="button" className="button small" disabled={groups.length >= 6} onClick={() => onChange(current => ({ ...current, groups: [...(current.groups ?? []), { name: `Gruppe ${(current.groups ?? []).length + 1}`, playlists: [], taste: '' }] }))}>Gruppe hinzufügen</button>
    </fieldset>
    {groups.length > 1 && <div className="grid">
      <Field label={`Gruppe wechseln nach: ${show.switchAfterTracks ? `${show.switchAfterTracks} Songs` : 'aus'}`}>
        <input type="range" min={0} max={20} value={show.switchAfterTracks ?? 3} onChange={event => onChange(current => ({ ...current, switchAfterTracks: Number(event.target.value) }))} />
      </Field>
      <Field label={`oder nach: ${show.switchAfterMinutes ? `${show.switchAfterMinutes} Min.` : 'aus'}`}>
        <input type="range" min={0} max={60} step={5} value={show.switchAfterMinutes ?? 0} onChange={event => onChange(current => ({ ...current, switchAfterMinutes: Number(event.target.value) }))} />
      </Field>
    </div>}
    <fieldset className="block-triggers"><legend>Wann moderiert wird</legend>
      <label className="check"><input type="checkbox" checked={triggers.blockStart} onChange={event => setTrigger({ blockStart: event.target.checked })} />Zu Beginn des Blocks</label>
      <label className="check"><input type="checkbox" checked={triggers.blockEnd} onChange={event => setTrigger({ blockEnd: event.target.checked })} />Am Ende, mit Überleitung zur nächsten Sendung</label>
      <label className="check"><input type="checkbox" checked={triggers.groupTransition} onChange={event => setTrigger({ groupTransition: event.target.checked })} />Beim Wechsel der Gruppe</label>
      <div className="grid">
        <Field label={`Ansage vor KI-Songs: ${every(triggers.beforeTrack, 'Songs')}`}>
          <input type="range" min={0} max={10} value={triggers.beforeTrack} onChange={event => setTrigger({ beforeTrack: Number(event.target.value) })} />
        </Field>
        <Field label={`Absage nach KI-Songs: ${every(triggers.afterTrack, 'Songs')}`}>
          <input type="range" min={0} max={10} value={triggers.afterTrack} onChange={event => setTrigger({ afterTrack: Number(event.target.value) })} />
        </Field>
        <Field label={`Zwischendurch: ${every(triggers.everyMinutes, 'Min.')}`} hint="Nach so viel Musik ohne Moderation.">
          <input type="range" min={0} max={60} step={5} value={triggers.everyMinutes} onChange={event => setTrigger({ everyMinutes: Number(event.target.value) })} />
        </Field>
        <Field label={`Länge einer Moderation: ${show.talkSeconds ?? 20} s`}>
          <input type="range" min={10} max={120} step={5} value={show.talkSeconds ?? 20} onChange={event => onChange(current => ({ ...current, talkSeconds: Number(event.target.value) }))} />
        </Field>
      </div>
    </fieldset>
  </>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

interface SectionProps { id: string; title: string; description: string; summary: string; open: string | null; onOpen(id: string | null): void; children: ReactNode }

/**
 * Settings are an overview first: one row per area with what is set. A tap opens only that area, which
 * keeps the page short on a phone.
 */
function Section({ id, title, description, summary, open, onOpen, children }: SectionProps) {
  if (open === null) return <button type="button" className="card section-row" onClick={() => onOpen(id)} aria-label={`${title}: ${summary}`}>
    <span><strong>{title}</strong><small>{summary}</small></span><span aria-hidden="true">›</span>
  </button>;
  if (open !== id) return null;
  return <section className="card editor-section" aria-label={title}>
    <button type="button" className="back-link" onClick={() => onOpen(null)}>← Alle Einstellungen</button>
    <h2>{title}</h2><p className="muted">{description}</p>{children}
  </section>;
}

function agentSummary(config: StationConfig): string {
  const own = Object.values(config.agents ?? {});
  const off = own.filter(settings => settings?.enabled === false).length, changed = own.length;
  return changed ? `${changed} angepasst${off ? `, ${off} aus` : ''}` : 'Standard';
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
  const [open, setOpen] = useState<string | null>(null);
  const { insights, reload: reloadInsights } = useInsights();
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

  const nav = { open, onOpen: (id: string | null) => { setOpen(id); window.scrollTo({ top: 0 }); } };
  const activeShows = draft.shows.filter(show => show.enabled).length;
  const interests = [...draft.profile.topics, ...draft.profile.interests];
  return <div className="editor">
    <Section {...nav} id="sender" summary={`${draft.name} · ${draft.host.name}${draft.location ? ` · ${draft.location.name}` : ''}`} title="Sender und Moderation" description="Wie dein Radio heisst und wer spricht. Die Persona prägt jeden Beitrag.">
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
      <fieldset className="spaced"><legend>Wo du hörst</legend>
        <LocationPicker value={draft.location} onChange={location => change(next => { if (location) next.location = location; else delete next.location; })} />
      </fieldset>
    </Section>

    <Section {...nav} id="interessen" summary={interests.length ? interests.slice(0, 4).join(', ') + (interests.length > 4 ? ` und ${interests.length - 4} weitere` : '') : 'Noch keine'} title="Interessen" description="Worüber recherchiert wird, wenn eine Sendung selbst wählen darf. Dein Feedback gewichtet sie mit der Zeit.">
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

    <Section {...nav} id="musik" summary={`${draft.music.between === 0 ? 'Keine Songs zwischen Beiträgen' : `${draft.music.between} ${draft.music.between === 1 ? 'Song' : 'Songs'} zwischen Beiträgen`}${draft.music.taste ? ` · ${draft.music.taste.slice(0, 40)}${draft.music.taste.length > 40 ? '…' : ''}` : ''}`} title="Musik" description="Songs zwischen den Beiträgen. Die KI wählt nach deinem Geschmack, Spotify spielt sie in der App. Deine 👍/👎 auf Songs verfeinern die Auswahl.">
      <Field label={draft.music.between === 0 ? 'Songs zwischen Beiträgen: aus' : `Songs zwischen Beiträgen: ${draft.music.between}`} hint="Nach jedem Wortbeitrag. Musikstunden bringen ihre eigene Musik mit.">
        <input type="range" min={0} max={3} value={draft.music.between} onChange={event => change(next => { next.music.between = Number(event.target.value); })} />
      </Field>
      <Field label="Musikgeschmack" hint="Genres, Künstler, Stimmungen – so konkret wie möglich.">
        <textarea rows={2} maxLength={500} value={draft.music.taste} placeholder="z. B. Industrial, Indie, Rock – eher spezifisch, gern Nine Inch Nails, Einstürzende Neubauten, Protomartyr" onChange={event => change(next => { next.music.taste = event.target.value; })} />
      </Field>
      <ListeningProfile />
      <label className="check"><input type="checkbox" checked={draft.music.announce} onChange={event => change(next => { next.music.announce = event.target.checked; })} />Kurze Ansage vor jedem Song</label>
    </Section>

    <Section {...nav} id="sendungen" summary={`${activeShows} aktiv von ${draft.shows.length}`} title="Sendungen" description="Jede Sendung ist ein Format mit eigenem Auftrag. Musikstunden und Musikblöcke wechseln Moderation und Songs über Spotify ab.">
      <div className="shows">{draft.shows.map((show, index) => {
        const focus = HOUR_FOCUS[show.format], block = show.format === 'music_block';
        const [min, max] = MINUTES_LIMITS[show.format];
        const subject = focus ? SUBJECT[focus] : null;
        const open = expanded.includes(show.id);
        return <article key={show.id} className={`show ${show.enabled ? '' : 'paused'}`} aria-label={`Sendung ${show.name}`}>
          <header className="show-head">
            <button type="button" className="show-toggle" aria-expanded={open} aria-label={`${show.name} ${open ? 'zuklappen' : 'bearbeiten'}`} onClick={() => toggle(show.id)}>
              <strong>{show.name || 'Ohne Namen'}</strong>
              <small>{FORMAT_LABELS[show.format]} · {show.targetMinutes} Min.{subject && show[subject.key] ? ` · ${show[subject.key]}` : ''}{block && show.groups?.length ? ` · ${show.groups.map(group => group.name).join(', ')}` : ''}</small>
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
              <input type="range" min={min} max={max} step={focus || block ? 5 : 1} value={show.targetMinutes} onChange={event => changeShow(index, current => ({ ...current, targetMinutes: Number(event.target.value) }))} />
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
            {!focus && !block && <Field label="Quellen">
              <select value={show.sourceMode} onChange={event => changeShow(index, current => ({ ...current, sourceMode: event.target.value as ShowConfig['sourceMode'] }))}>
                <option value="web">Websuche (Google)</option><option value="feeds">Meine Feeds</option>
              </select>
            </Field>}
          </div>
          {block && <BlockSettings show={show} onChange={update => changeShow(index, update)} />}
          {!focus && !block && show.sourceMode === 'feeds' && <fieldset className="feed-picks"><legend>Feeds dieser Sendung</legend>
            {draft.feeds.length === 0 ? <small className="muted">Noch keine Feeds – unten hinzufügen.</small> : draft.feeds.map(feed => <label key={feed.id} className="check">
              <input type="checkbox" checked={show.feedIds.includes(feed.id)} onChange={event => changeShow(index, current => ({ ...current,
                feedIds: event.target.checked ? [...current.feedIds, feed.id] : current.feedIds.filter(id => id !== feed.id) }))} />{feed.name}</label>)}
          </fieldset>}
          {!block && (focus || show.sourceMode === 'web') && <Field label={focus ? 'Zusätzlicher Rechercheauftrag' : 'Rechercheauftrag'} hint="Wonach die Websuche suchen soll.">
            <textarea rows={2} maxLength={1000} value={show.researchPrompt} onChange={event => changeShow(index, current => ({ ...current, researchPrompt: event.target.value }))} />
          </Field>}
          <Field label="Redaktionelle Anweisungen" hint="Was diese Sendung tun soll, in deinen Worten.">
            <textarea rows={2} maxLength={2000} value={show.instructions} onChange={event => changeShow(index, current => ({ ...current, instructions: event.target.value }))} />
          </Field>
          {!focus && !block && <div className="chips tools" role="group" aria-label="Aktuelles einbauen">
            <small className="muted">Aktuelles einbauen:</small>
            {TOOLS.map(([tool, label]) => <button type="button" key={tool} aria-pressed={show.tools?.includes(tool) ?? false}
              onClick={() => changeShow(index, current => {
                const tools = current.tools?.includes(tool) ? current.tools.filter(item => item !== tool) : [...current.tools ?? [], tool];
                const { tools: _t, ...rest } = current;
                return tools.length ? { ...rest, tools } : rest;
              })}>{label}</button>)}
            {show.tools?.includes('weather') && !draft.location && <small className="muted">Für das Wetter unter «Sender und Moderation» den Ort wählen.</small>}
          </div>}
          <details className="more">
            <summary>Weitere Optionen</summary>
            <div className="grid">
            {focus && <Field label="Produktion" hint="Das Redaktionsteam recherchiert jeden Song einzeln, prüft Fakten und redigiert – gründlicher, braucht mehr Aufrufe.">
              <select value={show.production ?? 'standard'} onChange={event => changeShow(index, current => ({ ...current, production: event.target.value as 'standard' | 'agents' }))}>
                <option value="standard">Standard (eine Autorin)</option><option value="agents">Redaktionsteam (Beta)</option>
              </select>
            </Field>}
            {show.format === 'brief' && <Field label="Text schreibt">
              <select value={show.textProvider} onChange={event => changeShow(index, current => ({ ...current, textProvider: event.target.value as ShowConfig['textProvider'] }))}>
                <option value="gemini">Gemini</option><option value="ask">ASK</option>
              </select>
            </Field>}
            {!block && <Field label="Quellenprüfung">
              <select value={show.verification} onChange={event => changeShow(index, current => ({ ...current, verification: event.target.value as ShowConfig['verification'] }))}>
                <option value="strict">Streng – jede Aussage belegt</option><option value="light">Leicht – quellenbasiert</option><option value="off">Aus</option>
              </select>
            </Field>}
            {show.format !== 'podcast' && <Field label="Stimme">
              <select value={show.voiceId ?? ''} onChange={event => changeShow(index, current => { const { voiceId: _v, ...rest } = current; return event.target.value ? { ...rest, voiceId: event.target.value } : rest; })}>
                <option value="">Wie die Moderation</option>{voiceOptions(show.voiceId)}
              </select>
            </Field>}
            </div>
          </details>
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
          {(Object.keys(FORMAT_LABELS) as ShowFormat[]).map(format => <option key={format} value={format}>{FORMAT_LABELS[format]}{bringsOwnMusic(format) ? ' ♫' : ''}</option>)}
        </select>
        <button type="button" className="button" disabled={draft.shows.length >= 20} onClick={() => {
          const show = newShow(newFormat, draft.shows.map(item => item.id));
          change(next => { next.shows.push(show); });
          setExpanded(current => [...current, show.id]);
        }}>Sendung hinzufügen</button>
      </div>
    </Section>

    <Section {...nav} id="sendeuhr" summary={draft.schedule.length ? draft.schedule.map(slot => `${slot.from}–${slot.to}`).join(', ') : 'Noch leer'} title="Tagesplan" description="Wann was läuft: Zeitfenster mit Bausteinen, die sich abwechseln. Dazwischen kommen Songs, wenn Musik eingeschaltet ist.">
      <DayPlan schedule={draft.schedule} shows={draft.shows} onChange={schedule => change(next => { next.schedule = schedule; })} />
      <div className="grid spaced">
        <Field label="Zeitzone"><input list="timezones" value={draft.timezone} maxLength={64} onChange={event => change(next => { next.timezone = event.target.value; })} /></Field>
        <datalist id="timezones">{TIMEZONES.map(zone => <option key={zone} value={zone} />)}</datalist>
        <Field label={`Im Voraus produzieren: ${draft.horizonMinutes} Min.`}>
          <input type="range" min={10} max={120} step={5} value={draft.horizonMinutes} onChange={event => change(next => { next.horizonMinutes = Number(event.target.value); })} />
        </Field>
      </div>
    </Section>

    <Section {...nav} id="feeds" summary={draft.feeds.length ? `${draft.feeds.length} ${draft.feeds.length === 1 ? 'Feed' : 'Feeds'}` : 'Keine'} title="Feeds" description="RSS- oder Atom-Feeds für Sendungen mit der Quelle «Meine Feeds».">
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

    <Section {...nav} id="redaktion" summary={agentSummary(draft)} title="Redaktion" description="Die KI-Agenten hinter deinem Radio: was sie tun, ihre Anweisungen und wie frei sie schreiben. Quellenregeln und Antwortformat bleiben fest, damit nichts Unbelegtes gesendet wird.">
      {insights && <>
        <h3 className="subhead">Qualität der letzten 30 Tage</h3>
        <QualityTrend insights={insights} />
        <h3 className="subhead">Was du bemängelt hast</h3>
        <ListenerNotes insights={insights} onCleared={reloadInsights} />
      </>}
      <h3 className="subhead">Agenten</h3>
      <AgentDesk value={draft.agents} onChange={agents => change(next => { if (agents) next.agents = agents; else delete next.agents; })} />
    </Section>

    <Section {...nav} id="verbrauch" summary={insights?.usage.days[0] ? `Heute ${insights.usage.days[0].generations} von ${insights.usage.limits.generations} Produktionen` : 'Aufrufe, Tokens und Limiten'} title="Verbrauch" description="Was dein Radio pro Tag bei den KI-Diensten braucht: Produktionen und Sprachzeichen (mit den Tageslimiten), Aufrufe und Tokens pro Modell.">
      {insights ? <UsageOverview insights={insights} /> : <p className="muted">Der Verbrauch ist gerade nicht abrufbar.</p>}
    </Section>

    <div className={`savebar ${dirty ? 'visible' : ''}`} role="region" aria-label="Änderungen">
      <span>{problem || (dirty ? 'Ungespeicherte Änderungen' : 'Alles gespeichert')}</span>
      <button type="button" className="button ghost" disabled={!dirty || saving} onClick={() => { setDraft(structuredClone(config)); setProblem(''); }}>Verwerfen</button>
      <button type="button" className="button primary" disabled={!dirty || saving} onClick={() => void save()}>Speichern</button>
    </div>
  </div>;
}
