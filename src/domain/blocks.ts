// Ready-made building blocks for the program: the owner taps one and it is produced, at most with one
// short word (a topic, an artist). Each block is a show template; nothing needs writing or configuring.
import { DEFAULT_TRIGGERS, HOUR_FOCUS, SONG_MINUTES, bringsOwnMusic } from './station.ts';
import type { ShowConfig, ShowFormat, StationConfig } from './station.ts';

export type BlockInput = 'topic' | 'artist' | 'genre' | 'theme';

export interface Block {
  id: string;
  name: string;
  /** One line under the name. */
  description: string;
  /** The one optional word the block asks for; empty means the AI picks. */
  input?: { kind: BlockInput; label: string; example: string };
  /** Songs come from Spotify: needs the Spotify app on the phone. */
  music?: boolean;
  /** Not offered in the palette: added by another action (e.g. «Mehr dazu»). */
  hidden?: boolean;
  show: Omit<ShowConfig, 'id' | 'name' | 'enabled'>;
}

const spoken = { feedIds: [], textProvider: 'gemini' as const, researchPrompt: '' };

export const BLOCKS: readonly Block[] = [
  { id: 'morgen', name: 'Morgenbriefing', description: 'Datum, Wetter und die wichtigsten Schlagzeilen',
    show: { ...spoken, format: 'brief', targetMinutes: 2, verification: 'light', sourceMode: 'feeds', tools: ['clock', 'weather', 'headlines'],
      instructions: 'Begrüsse passend zur Tageszeit, nenne Wochentag und Datum, dann kurz das Wetter und die wichtigsten Schlagzeilen.' } },
  { id: 'wetter', name: 'Wetter', description: 'Das Wetter für heute und morgen',
    show: { ...spoken, format: 'brief', targetMinutes: 1, verification: 'light', sourceMode: 'feeds', tools: ['clock', 'weather'],
      instructions: 'Ein kurzer, lebendiger Wetterbericht für heute und morgen, mit einem praktischen Tipp.' } },
  { id: 'schlagzeilen', name: 'Schlagzeilen', description: 'Was heute wichtig ist, in zwei Minuten',
    show: { ...spoken, format: 'brief', targetMinutes: 2, verification: 'light', sourceMode: 'feeds', tools: ['headlines'],
      instructions: 'Die wichtigsten Meldungen in wenigen klaren Sätzen, sachlich und ohne Wertung.' } },
  { id: 'entdeckung', name: 'Entdeckung', description: 'Etwas Neues zu deinen Interessen', input: { kind: 'topic', label: 'Thema', example: 'z. B. Tiefsee' },
    show: { ...spoken, format: 'brief', targetMinutes: 2, verification: 'strict', sourceMode: 'web',
      instructions: 'Erzähle eine konkrete, überraschende Entdeckung, nicht eine Übersicht.' } },
  { id: 'hintergrund', name: 'Hintergrund', description: 'Zwei Stimmen ordnen ein Thema ein', input: { kind: 'topic', label: 'Thema', example: 'z. B. Kernfusion' },
    show: { ...spoken, format: 'podcast', targetMinutes: 5, verification: 'strict', sourceMode: 'web',
      instructions: 'Ordne ein, erkläre Begriffe und zeige Zusammenhänge.' } },
  { id: 'kuenstler', name: 'Künstler-Stunde', description: 'Eine Stunde mit einer Band', input: { kind: 'artist', label: 'Künstler oder Band', example: 'z. B. Portishead' }, music: true,
    show: { ...spoken, format: 'artist_hour', targetMinutes: 60, tracks: 10, talkSeconds: 60, verification: 'light', sourceMode: 'web',
      instructions: 'Frühwerk und Einflüsse betonen, keine Chart-Statistiken.', production: 'standard' } },
  { id: 'genre', name: 'Genre-Stunde', description: 'Ein Genre von den Anfängen bis heute', input: { kind: 'genre', label: 'Genre', example: 'z. B. Krautrock' }, music: true,
    show: { ...spoken, format: 'genre_hour', targetMinutes: 60, tracks: 10, talkSeconds: 60, verification: 'light', sourceMode: 'web',
      instructions: 'Vom Ursprung bis heute, Wegbereiter und Seitenwege.', production: 'standard' } },
  { id: 'themenstunde', name: 'Themen-Stunde', description: 'Ein Thema in Kapiteln, mit passenden Songs', input: { kind: 'theme', label: 'Thema', example: 'z. B. Der Mond' }, music: true,
    show: { ...spoken, format: 'theme_hour', targetMinutes: 60, tracks: 8, talkSeconds: 120, verification: 'light', sourceMode: 'web',
      instructions: 'Erzähle das Thema in Kapiteln; jeder Song passt inhaltlich zum Kapitel davor.', production: 'standard' } },
  { id: 'musik', name: 'Musikblock', description: '30 Minuten Musik nach deinem Geschmack', music: true,
    show: { ...spoken, format: 'music_block', targetMinutes: 30, verification: 'off', sourceMode: 'web', instructions: '',
      groups: [{ name: 'Mein Geschmack', playlists: [], taste: '' }], switchAfterTracks: 0, switchAfterMinutes: 0, talkSeconds: 20, triggers: { ...DEFAULT_TRIGGERS } } },
  { id: 'neu', name: 'Neu von deinen Künstlern', description: 'Neue Alben und Singles aus deinem Spotify-Hörprofil', music: true,
    show: { ...spoken, format: 'music_block', targetMinutes: 20, verification: 'off', sourceMode: 'web', instructions: '',
      groups: [{ name: 'Neuerscheinungen', playlists: [], taste: '', releases: true }], switchAfterTracks: 0, switchAfterMinutes: 0, talkSeconds: 20,
      triggers: { ...DEFAULT_TRIGGERS, beforeTrack: 0, afterTrack: 0, everyMinutes: 10 } } },
  { id: 'vertiefung', name: 'Vertiefung', description: 'Mehr zum Beitrag davor', hidden: true,
    show: { ...spoken, format: 'brief', targetMinutes: 3, verification: 'strict', sourceMode: 'web',
      instructions: 'Vertiefe den vorherigen Beitrag: Hintergründe, Ursachen, Folgen und ein konkretes Beispiel. Wiederhole nicht, was er schon gesagt hat.' } },
];

/** Timeline items of a block carry this show ID. */
export const BLOCK_PREFIX = '_block:';
export const blockOf = (showId: string) => showId.startsWith(BLOCK_PREFIX) ? BLOCKS.find(block => block.id === showId.slice(BLOCK_PREFIX.length)) : undefined;

/** The show a block item is produced with; the music block uses the station's music taste. */
export function blockShow(block: Block, config: StationConfig, subject?: string): ShowConfig {
  const show: ShowConfig = { ...structuredClone(block.show), id: `${BLOCK_PREFIX}${block.id}`, name: block.name, enabled: true };
  if (show.groups) show.groups = show.groups.map(group => ({ ...group, taste: config.music.taste }));
  const topic = subject?.trim();
  if (topic && block.input?.kind === 'topic') show.researchPrompt = `Recherchiere zum Thema «${topic}»: aktuelle, konkrete und überprüfbare Entwicklungen und Geschichten.`;
  return show;
}

/** What the app and the cockpit show for a block: the catalog, one song, and the owner's own shows. */
export interface BlockView { id: string; name: string; description: string; minutes: number; music: boolean; own: boolean; input?: Block['input'] }

const FORMAT_NAMES: Record<ShowFormat, string> = {
  brief: 'Kurzbeitrag', podcast: 'Dialog', artist_hour: 'Künstler-Stunde', genre_hour: 'Genre-Stunde', theme_hour: 'Themen-Stunde', music_block: 'Musikblock',
};
const OWN_INPUT = {
  artist: { kind: 'artist', label: 'Künstler oder Band', example: 'z. B. Portishead' },
  genre: { kind: 'genre', label: 'Genre', example: 'z. B. Krautrock' },
  theme: { kind: 'theme', label: 'Thema', example: 'z. B. Der Mond' },
} as const;

export function blockViews(config: StationConfig): BlockView[] {
  return [
    ...BLOCKS.filter(block => !block.hidden).map(({ show, hidden: _hidden, ...block }) => ({ ...block, minutes: show.targetMinutes, music: !!block.music, own: false })),
    { id: 'song', name: 'Song', description: 'Ein Song nach deinem Geschmack', minutes: SONG_MINUTES, music: true, own: false },
    ...config.shows.filter(show => show.enabled).map(show => {
      const focus = HOUR_FOCUS[show.format];
      return { id: `show:${show.id}`, name: show.name, description: `Deine Sendung · ${FORMAT_NAMES[show.format]}`, minutes: show.targetMinutes,
        music: bringsOwnMusic(show.format), own: true, ...(focus ? { input: OWN_INPUT[focus] } : {}) };
    }),
  ];
}
