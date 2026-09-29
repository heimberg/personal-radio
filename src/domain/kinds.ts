// What kind of content an item or block is: news, discovery, weather, music or a surprise. Each kind
// has a colour and every block an icon, so the program reads at a glance. The Android app mirrors this
// table (core/Kinds.kt).
import { BLOCK_PREFIX, blockOf } from './blocks.ts';
import { MUSIC_SHOW_ID, bringsOwnMusic } from './station.ts';
import type { ShowConfig, ShowFormat, StationConfig } from './station.ts';

export type Kind = 'news' | 'discover' | 'weather' | 'music' | 'surprise';

/** Colours on the dark ground; always shown with an icon and a name, never as the only cue. */
export const KINDS: Record<Kind, { label: string; color: string }> = {
  news: { label: 'Aktuell', color: '#D08A2A' },
  discover: { label: 'Wissen', color: '#2BA57A' },
  weather: { label: 'Wetter', color: '#5B95F5' },
  music: { label: 'Musik', color: '#D06BD8' },
  surprise: { label: 'Überraschung', color: '#F0704F' },
};

const BLOCK_LOOK: Record<string, { kind: Kind; icon: string }> = {
  morgen: { kind: 'news', icon: '☕' }, schlagzeilen: { kind: 'news', icon: '📰' }, wetter: { kind: 'weather', icon: '☀️' },
  entdeckung: { kind: 'discover', icon: '🔭' }, hintergrund: { kind: 'discover', icon: '🎙️' }, vertiefung: { kind: 'discover', icon: '🔍' },
  kuenstler: { kind: 'music', icon: '🎸' }, genre: { kind: 'music', icon: '🎛️' }, themenstunde: { kind: 'music', icon: '🌙' },
  musik: { kind: 'music', icon: '🎵' }, neu: { kind: 'music', icon: '✨' }, song: { kind: 'music', icon: '🎶' },
  ueberraschung: { kind: 'surprise', icon: '🎲' }, zufallsfund: { kind: 'surprise', icon: '🧭' }, 'heute-vor': { kind: 'surprise', icon: '📜' },
  'um-die-ecke': { kind: 'surprise', icon: '📍' }, 'wort-des-tages': { kind: 'surprise', icon: '🔤' }, 'frage-des-tages': { kind: 'surprise', icon: '❓' },
  'musik-wildcard': { kind: 'surprise', icon: '🌍' }, ueberraschungsstunde: { kind: 'surprise', icon: '🎭' },
};

const FORMAT_ICON: Record<ShowFormat, string> = {
  brief: '🗞️', podcast: '🎙️', artist_hour: '🎸', genre_hour: '🎛️', theme_hour: '🌙', music_block: '🎵',
};

/** An owner's own show: music formats are music, feed or headline shows are news, the rest is knowledge. */
function showLook(show: Pick<ShowConfig, 'format' | 'sourceMode' | 'tools'>): { kind: Kind; icon: string } {
  if (bringsOwnMusic(show.format)) return { kind: 'music', icon: FORMAT_ICON[show.format] };
  if (show.tools?.includes('weather') && show.tools.length === 1) return { kind: 'weather', icon: '☀️' };
  if (show.sourceMode === 'feeds' || show.tools?.includes('headlines')) return { kind: 'news', icon: FORMAT_ICON[show.format] };
  return { kind: 'discover', icon: FORMAT_ICON[show.format] };
}

/** Kind and icon of a timeline item or day-plan entry by its show ID. */
export function lookOfShow(showId: string, config: StationConfig | null): { kind: Kind; icon: string } {
  if (showId === MUSIC_SHOW_ID) return BLOCK_LOOK.song;
  if (showId.startsWith(BLOCK_PREFIX)) return BLOCK_LOOK[showId.slice(BLOCK_PREFIX.length)] ?? (blockOf(showId) ? showLook(blockOf(showId)!.show) : { kind: 'discover', icon: '🗞️' });
  const own = config?.shows.find(show => show.id === showId);
  return own ? showLook(own) : { kind: 'discover', icon: '🗞️' };
}

/** Kind and icon of a palette block (`/api/blocks`): catalog IDs, «song», or «show:<id>». */
export function lookOfBlock(blockId: string, config: StationConfig | null, music = false): { kind: Kind; icon: string } {
  if (BLOCK_LOOK[blockId]) return BLOCK_LOOK[blockId];
  if (blockId.startsWith('show:')) return lookOfShow(blockId.slice(5), config);
  return music ? { kind: 'music', icon: '🎵' } : { kind: 'discover', icon: '🗞️' };
}
