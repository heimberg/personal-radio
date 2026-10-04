/** Trial runs of the editorial agents on the last item; nothing is stored. */
import type { ShowConfig, StationConfig } from '../../src/domain/station.ts';
import type { QualityScore, Script, Source } from '../../src/domain/program.ts';
import { finishScript } from '../editing.ts';
import { blockOf, blockShow } from '../../src/domain/blocks.ts';
import { resolveAgents } from '../../src/domain/agents.ts';
import type { AgentConfig } from '../../src/domain/agents.ts';
import { fitSources } from '../segment-pipeline.ts';
import type { TimelineRow } from '../station-store.ts';
import type { StationDeps } from './core.ts';
import { stationContext, notesFor } from './produce.ts';
import { packageFocus, packageSubject, songHistory } from './music.ts';
import type { TrackPart, HourPackage } from './music.ts';

/** The music desk proposes the next songs with the unsaved settings; nothing is searched or planned. */
export async function trialSongs(deps: StationDeps, owner: string, config: StationConfig, agents: ReturnType<typeof resolveAgents>): Promise<TrialOutcome> {
  const history = await songHistory(deps, owner);
  const listens = deps.listening ? await deps.listening.topArtists(owner, deps.now()) : [];
  await deps.reserveGeneration(owner);
  const picks = await deps.musicWriter!.pickSongs({
    taste: config.music.taste, interests: [...config.profile.topics, ...config.profile.interests], avoid: history.recent,
    liked: history.liked, disliked: history.disliked, announce: true, listens, count: 5,
    direction: { stationName: config.name, persona: config.host, agents },
  });
  const recent = history.recent.slice(-5);
  return { ok: true, itemTitle: 'die nächsten Songs',
    before: { text: recent.length ? recent.map(song => `– ${song}`).join('\n') : 'Noch keine Songs gespielt.' },
    after: { text: picks.map(pick => `– ${pick.artist} – ${pick.title}${pick.announcement ? `\n  «${pick.announcement}»` : ''}`).join('\n') } };
}

/** The last music hour, moderated anew with the unsaved settings, from the same songs and sources. */
export async function trialHour(deps: StationDeps, owner: string, config: StationConfig, agents: ReturnType<typeof resolveAgents>): Promise<TrialOutcome> {
  let found: { pkg: HourPackage; sources: Source[]; show: ShowConfig } | undefined;
  for (const row of (await deps.store.recentItems(owner, 60)).reverse()) {
    if (!row.script_json || !['voicing', 'ready', 'played', 'skipped', 'archived'].includes(row.state)) continue;
    try {
      const pkg = JSON.parse(row.script_json) as HourPackage;
      if (pkg.kind !== 'music_hour' && pkg.kind !== 'artist_hour') continue;
      const show = config.shows.find(item => item.id === row.show_id) ?? (blockOf(row.show_id) ? blockShow(blockOf(row.show_id)!, config) : undefined);
      found = { pkg, sources: JSON.parse(row.sources_json ?? '[]') as Source[], show: show ?? { talkSeconds: 60, instructions: '' } as ShowConfig };
      break;
    } catch { /* Skip corrupt rows. */ }
  }
  if (!found) return { ok: false, error: 'NO_ITEM' };
  const { pkg, sources, show } = found;
  const tracks = pkg.parts.filter((part): part is TrackPart => part.kind === 'track');
  if (!tracks.length) return { ok: false, error: 'NO_ITEM' };
  await deps.reserveGeneration(owner);
  const hour = await deps.musicWriter!.writeHour({ focus: packageFocus(pkg), subject: packageSubject(pkg), sources, talkSeconds: show.talkSeconds ?? 60,
    picks: tracks.map(track => ({ title: track.title, artist: track.artist, reason: track.reason ?? '' })),
    direction: { instructions: show.instructions, stationName: config.name, persona: config.host, agents, listenerNotes: await notesFor(deps, owner, deps.now()) } });
  const before: string[] = [];
  for (const part of pkg.parts) {
    if (part.kind === 'track') before.push(`♪ ${part.artist} – ${part.title}`);
    else if (before.length && !before[before.length - 1].startsWith('♪')) before[before.length - 1] += ` ${part.text}`;
    else before.push(part.text);
  }
  const after = [hour.intro.text, ...tracks.flatMap((track, index) => [hour.tracks.find(item => item.index === index)?.text ?? '', `♪ ${track.artist} – ${track.title}`]), hour.outro.text].filter(Boolean);
  return { ok: true, itemTitle: pkg.title, before: { text: before.join('\n\n') }, after: { text: after.join('\n\n') } };
}

export type TrialOutcome =
  | { ok: true; itemTitle: string; before: { text: string; quality?: QualityScore }; after: { text: string; quality?: QualityScore } }
  | { ok: false; error: 'NO_ITEM' | 'NOT_CONFIGURED' | 'FAILED'; detail?: string };

export const scriptText = (script: Script) => script.turns ? script.turns.map(turn => `${turn.speaker === 'host-b' ? 'B' : 'A'}: ${turn.text}`).join('\n') : script.text;

/**
 * Tries an agent with unsaved settings on the last produced spoken item and returns before and after;
 * nothing is stored. The writer drafts anew from the same sources, the editor rewrites (and the jury
 * scores) the final text, the jury only scores it.
 */
export type TrialAgent = 'writer' | 'editor' | 'jury' | 'music' | 'hour';

export async function trialAgent(deps: StationDeps, owner: string, agent: TrialAgent, draft: AgentConfig | undefined): Promise<TrialOutcome> {
  const config = await deps.store.getConfig(owner);
  if (!config) return { ok: false, error: 'NO_ITEM' };
  const agents = resolveAgents(draft);
  if (agent === 'music' || agent === 'hour') {
    if (!deps.musicWriter) return { ok: false, error: 'NOT_CONFIGURED' };
    try { return agent === 'music' ? await trialSongs(deps, owner, config, agents) : await trialHour(deps, owner, config, agents); }
    catch (error) { return { ok: false, error: 'FAILED', detail: (error instanceof Error ? error.message : 'unbekannt').slice(0, 200) }; }
  }
  let found: { row: TimelineRow; script: Script; sources: Source[]; show: ShowConfig } | undefined;
  for (const row of (await deps.store.recentItems(owner, 40)).reverse()) {
    if (!row.script_json || !row.sources_json || !['voicing', 'ready', 'played', 'skipped', 'archived'].includes(row.state)) continue;
    const show = config.shows.find(item => item.id === row.show_id) ?? (blockOf(row.show_id) ? blockShow(blockOf(row.show_id)!, config) : undefined);
    if (!show || (show.format !== 'brief' && show.format !== 'podcast')) continue;
    try {
      const script = JSON.parse(row.script_json) as Script, sources = JSON.parse(row.sources_json) as Source[];
      if (typeof script.text === 'string' && script.text.trim() && Array.isArray(script.sourceIds) && sources.length) { found = { row, script, sources, show }; break; }
    } catch { /* Skip corrupt rows. */ }
  }
  if (!found) return { ok: false, error: 'NO_ITEM' };
  const { row, script, sources, show } = found;
  const direction = { instructions: show.instructions, targetMinutes: show.targetMinutes, stationName: config.name, persona: config.host, agents, listenerNotes: await notesFor(deps, owner, deps.now()) };
  const before = { text: scriptText(script), ...(script.quality ? { quality: script.quality } : {}) };
  try {
    if (agent === 'writer') {
      const generator = deps.generator ? deps.generator(show.textProvider, show.format) : undefined;
      if (deps.generator && !generator) return { ok: false, error: 'NOT_CONFIGURED' };
      await deps.reserveGeneration(owner);
      const fresh = await deps.pipeline.draft(config.profile, fitSources(sources), show.format === 'podcast' ? 'podcast' : 'brief', direction, generator);
      return { ok: true, itemTitle: script.title, before, after: { text: scriptText(fresh) } };
    }
    if (!deps.editor) return { ok: false, error: 'NOT_CONFIGURED' };
    await deps.reserveGeneration(owner);
    if (agent === 'jury') {
      const { interestTags: _tags, quality: _quality, ...plain } = script;
      const scored = await finishScript(deps.editor, plain, sources, { ...direction, agents: { ...agents, editor: { ...agents.editor, enabled: false }, jury: { ...agents.jury, enabled: true } } }, await stationContext(deps, owner, config, row, deps.now()));
      return { ok: true, itemTitle: script.title, before, after: { text: before.text, ...(scored.quality ? { quality: scored.quality } : {}) } };
    }
    const { quality: _quality, ...plain } = script;
    const edited = await finishScript(deps.editor, plain, sources, { ...direction, agents: { ...agents, editor: { ...agents.editor, enabled: true } } }, await stationContext(deps, owner, config, row, deps.now()));
    return { ok: true, itemTitle: script.title, before, after: { text: scriptText(edited), ...(edited.quality ? { quality: edited.quality } : {}) } };
  } catch (error) {
    return { ok: false, error: 'FAILED', detail: (error instanceof Error ? error.message : 'unbekannt').slice(0, 200) };
  }
}
