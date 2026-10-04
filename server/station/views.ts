/** How items look to the app: the program view and the transcript. */
import { MUSIC_SHOW_ID } from '../../src/domain/station.ts';
import type { StationConfig, TimelineItemView, VerificationPolicy } from '../../src/domain/station.ts';
import type { QualityScore, Script, Source } from '../../src/domain/program.ts';
import { withoutVoiceTags } from '../providers.ts';
import { OUTLINE_SOURCE_ID, SERIES_PREFIX, episodeRefOf } from '../../src/domain/series.ts';
import { parseChoice, parseQuiz } from '../../src/domain/play.ts';
import { blockOf, isSurprise } from '../../src/domain/blocks.ts';
import type { TimelineRow } from '../station-store.ts';
import { packageFocus, packageSubject } from './music.ts';
import type { HourPackage } from './music.ts';

export const showNameOf = (showId: string, config: StationConfig | null) =>
  showId === MUSIC_SHOW_ID ? 'Musik' : config?.shows.find(show => show.id === showId)?.name ?? blockOf(showId)?.name ?? showId;

export function toView(row: TimelineRow, config: StationConfig | null): TimelineItemView {
  let script: Partial<Script> = {}, sources: Source[] = [];
  try { script = JSON.parse(row.script_json ?? '{}'); } catch { /* Keep the item visible without details. */ }
  try { sources = JSON.parse(row.sources_json ?? '[]'); } catch { /* Keep the item visible without sources. */ }
  let queries: string[] = [];
  let team: TimelineItemView['team'];
  let sharedBy: string | undefined, sharedShow: string | undefined, followTopic: string | undefined;
  try { ({ queries = [], team, sharedBy, sharedShow, followTopic } = JSON.parse(row.research_json ?? '{}') as { queries?: string[]; team?: TimelineItemView['team']; sharedBy?: string; sharedShow?: string; followTopic?: string }); } catch { /* Research details are optional. */ }
  const episode = row.show_id.startsWith(SERIES_PREFIX) ? episodeRefOf(row.research_json) : null;
  const { choice, quiz } = (() => {
    try { const research = JSON.parse(row.research_json ?? '{}') as { choice?: unknown; quiz?: unknown }; return { choice: parseChoice(research.choice), quiz: parseQuiz(research.quiz) }; }
    catch { return { choice: null, quiz: null }; }
  })();
  // The plan of a story is how it is written, not a source to list.
  sources = sources.filter(source => source.id !== OUTLINE_SOURCE_ID);
  return {
    id: row.id, seq: row.seq, showId: row.show_id,
    showName: episode ? `${episode.seriesTitle} · Folge ${episode.episode + 1}/${episode.total}` : sharedShow ?? (followTopic ? `Dranbleiben: ${followTopic}` : showNameOf(row.show_id, config)),
    ...(typeof sharedBy === 'string' ? { sharedBy } : {}),
    ...(episode ? { series: { id: episode.series, episode: episode.episode + 1, total: episode.total, kind: episode.kind } } : {}),
    ...(isSurprise(row.show_id) ? { surprise: true } : {}),
    ...(choice ? { choice: { question: choice.question, options: choice.options, ...(choice.picked !== undefined ? { picked: choice.picked } : {}) } } : {}),
    // The right answer stays on the server until the listener answered.
    ...(quiz ? { quiz: { question: quiz.question, options: quiz.options, ...(quiz.answered !== undefined ? { answered: quiz.answered, correct: quiz.correct } : {}) } } : {}),
    plannedAt: row.planned_at, state: row.state, estimatedMinutes: row.estimated_minutes, updatedAt: row.updated_at,
    ...(script.title ? { title: script.title } : {}),
    ...(sources.length ? { sources: sources.map(source => ({ title: source.title, url: source.url })) } : {}),
    ...(script.interestTags?.length ? { interestTags: script.interestTags } : {}),
    ...(row.verification ? { verification: row.verification as VerificationPolicy } : {}),
    ...(script.quality ? { quality: script.quality.overall } : {}),
    ...(queries.length ? { searchQueries: queries } : {}),
    ...(team ? { team } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(hourView(row, script as Partial<HourPackage>) ?? (row.audio_key && row.state !== 'expired' ? { audioUrl: `api/timeline/${row.id}/audio` } : {})),
  };
}

/** What was said in an item, for reading along: spoken text (dialogs by speaker, hours with their songs) and sources. */
export interface TranscriptView {
  title: string;
  /** The jury's marks after the final edit, when there was one. */
  quality?: QualityScore;
  lines: Array<{ speaker?: string; text: string; song?: boolean }>;
  sources: Array<{ title: string; url: string }>;
}

export function transcriptView(row: TimelineRow, config: StationConfig | null): TranscriptView {
  let script: Partial<Script> & Partial<HourPackage> = {}, sources: Source[] = [];
  try { script = JSON.parse(row.script_json ?? '{}'); } catch { /* No text yet. */ }
  try { sources = JSON.parse(row.sources_json ?? '[]'); } catch { /* No sources. */ }
  const host = config?.host.name ?? 'Moderation', cohost = config?.host.cohostName ?? 'Co-Moderation';
  let lines: TranscriptView['lines'];
  if (Array.isArray(script.parts)) {
    lines = script.parts.map(part => part.kind === 'track'
      ? { text: `${part.title} – ${part.artist}`, song: true }
      : { text: withoutVoiceTags(part.text) });
  } else if (Array.isArray(script.turns)) {
    lines = script.turns.map(turn => ({ speaker: turn.speaker === 'host-b' ? cohost : host, text: withoutVoiceTags(turn.text) }));
  } else lines = script.text ? [{ text: withoutVoiceTags(script.text) }] : [];
  return {
    ...(script.quality ? { quality: script.quality } : {}),
    title: script.title ?? config?.shows.find(show => show.id === row.show_id)?.name ?? blockOf(row.show_id)?.name ?? row.show_id,
    lines: lines.filter(line => line.text?.trim()),
    sources: sources.filter(source => source.id !== OUTLINE_SOURCE_ID).map(source => ({ title: source.title, url: source.url })),
  };
}

export function hourView(row: TimelineRow, pkg: Partial<HourPackage>): Pick<TimelineItemView, 'parts' | 'focus' | 'subject' | 'artist'> | null {
  if ((pkg.kind !== 'music_hour' && pkg.kind !== 'artist_hour' && pkg.kind !== 'song' && pkg.kind !== 'music_block') || !Array.isArray(pkg.parts)) return null;
  // Released audio (after the retention period) leaves the parts without URLs.
  const playable = row.state !== 'expired' && !!row.audio_key, focus = packageFocus(pkg), subject = packageSubject(pkg);
  return {
    ...(pkg.kind === 'song' || pkg.kind === 'music_block' ? { subject } : { focus, subject, ...(focus === 'artist' ? { artist: subject } : {}) }),
    parts: pkg.parts.map((part, index) => part.kind === 'track'
      ? { kind: 'track' as const, spotifyUri: part.uri, title: part.title, artist: part.artist, durationMs: part.durationMs, ...(part.imageUrl ? { imageUrl: part.imageUrl } : {}) }
      : { kind: 'speech' as const, ...(playable && part.audioKey ? { audioUrl: `api/timeline/${row.id}/audio?part=${index}` } : {}) }),
  };
}
