/** The program runtime's shared pieces: what production needs (StationDeps), limits and small helpers. */
import type { ShowConfig, TextProvider } from '../../src/domain/station.ts';
import type { TextGenerator } from '../../src/domain/program.ts';
import type { FeedItem } from '../feed.ts';
import type { WeekExtras } from '../review.ts';
import type { FollowStore } from '../follow.ts';
import type { ScriptEditor } from '../editing.ts';
import type { Weather } from '../tools.ts';
import type { Researcher } from '../providers.ts';
import type { SegmentPipeline } from '../segment-pipeline.ts';
import type { StationStore } from '../station-store.ts';
import type { MusicCatalog, MusicWriter, PlaylistSource } from '../music.ts';
import type { JsonModel } from '../agentic/music-hour.ts';
import type { DurableStepRunner } from '../agentic/runtime.ts';

export interface AudioBucket {
  put(key: string, value: Uint8Array, options: { httpMetadata: { contentType: string } }): Promise<unknown>;
  delete(key: string): Promise<void>;
}
export interface StationDeps {
  store: StationStore;
  pipeline: Pick<SegmentPipeline, 'draft' | 'review' | 'voice'>;
  audio: AudioBucket;
  fetchFeed(url: string): Promise<FeedItem[]>;
  reserveFeed(owner: string): Promise<void>;
  reserveGeneration(owner: string): Promise<void>;
  podcastAvailable: boolean;
  /** Store speech as MP3 (`SPEECH_MP3=on`): about a second of CPU per minute of speech, so Workers Paid only. */
  compressSpeech?: boolean;
  /** Script writer for a show's provider and format; undefined when that provider is not configured. */
  generator?(provider: TextProvider, format: ShowConfig['format']): TextGenerator | undefined;
  /** Google-Search-grounded research for `web` shows; undefined without Gemini. */
  researcher?: Researcher;
  /** Artist hours: Gemini picks and writes, Spotify resolves picks to tracks. */
  musicWriter?: MusicWriter;
  catalog?: MusicCatalog;
  /** Music blocks: the owner's Spotify playlists. */
  playlists?: PlaylistSource;
  /** Final edit and quality jury for spoken items. */
  editor?: ScriptEditor;
  /** Tool: the weather for `{wetter}` (Open-Meteo). */
  weather?: Weather;
  /** The owner's Spotify top artists, when the owner connected the listening profile. */
  listening?: { topArtists(owner: string, now: Date): Promise<string[]> };
  /** The editorial team's model and durable step storage (music hours with `production: agents`). */
  agentModel?: JsonModel;
  agentSteps?(owner: string, runId: string): DurableStepRunner & { clear(): Promise<void> };
  /** Wochenrückblick: questions to the radio and stickers since a date. */
  week?(owner: string, since: Date): Promise<WeekExtras>;
  /** Dranbleiben: the topics the listener follows. */
  follows?: Pick<FollowStore, 'due' | 'get' | 'checked' | 'reported'>;
  now(): Date;
  random?(): number;
  newId?(): string;
}

export const LEASE_MINUTES = 10;
export const MAX_ATTEMPTS = 3;
/** Speech parts voiced in one invocation; a longer hour continues in the next queue message. */
export const PARTS_PER_RUN = 8;
export const MAX_NEW_ITEMS = 12;
export const STALE_HOURS = 12;
/** Time-bound items leave the program when their planned air time is this far in the past. */
export const TIMELY_HOURS = 2;
/** Without listening for this long, the cron plans nothing new (a paused player does not count). */
export const ACTIVE_LISTENER_HOURS = 2;
/** How long the day's headlines are reused by the next block. */
export const HEADLINES_CACHE_MINUTES = 90;
export const AUDIO_RETENTION_DAYS = 7;
export const PURGE_AFTER_HOURS = 24;
export const MAX_SOURCE_AGE_DAYS = 30;
export const minutes = (date: Date, amount: number) => new Date(date.getTime() + amount * 60_000);
export const nextUtcMidnight = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));

export interface PlannedItem { id: string; seq: number; showId: string; plannedAt: string; estimatedMinutes: number }
