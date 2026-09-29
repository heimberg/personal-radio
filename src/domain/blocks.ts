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
  /** A surprise the planner mixes in (🎲): its weight in the draw; hidden from the palette. */
  surprise?: { weight: number; needsLocation?: boolean; minLevel?: number };
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
  // Surprises: the planner mixes them in by the station's surprise level; «Überraschung» in the palette draws one.
  { id: 'zufallsfund', name: 'Zufallsfund', description: 'Eine überraschende Geschichte von nebenan deiner Interessen', hidden: true, surprise: { weight: 3 },
    show: { ...spoken, format: 'brief', targetMinutes: 2, verification: 'strict', sourceMode: 'web',
      researchPrompt: 'Finde eine überraschende, wenig bekannte und belegte Geschichte aus einem Gebiet, das an die Interessen grenzt, aber nicht direkt dazugehört.',
      instructions: 'Erzähle den Fund als kleine Geschichte mit einem Aha-Moment; sag kurz, warum er überrascht.' } },
  { id: 'heute-vor', name: 'Heute vor … Jahren', description: 'Was an diesem Kalendertag passiert ist', hidden: true, surprise: { weight: 2 },
    show: { ...spoken, format: 'brief', targetMinutes: 2, verification: 'strict', sourceMode: 'web', tools: ['clock'],
      researchPrompt: 'Was ist an diesem Kalendertag ({datum}) in früheren Jahren passiert? Wähle ein weniger bekanntes, belegtes Ereignis mit einer guten Geschichte.',
      instructions: 'Erzähle ein Ereignis, das an diesem Kalendertag vor Jahren passiert ist, mit Jahreszahl und einer konkreten Szene.' } },
  { id: 'um-die-ecke', name: 'Um die Ecke', description: 'Aktuelles und Kurioses aus deiner Region', hidden: true, surprise: { weight: 2, needsLocation: true },
    show: { ...spoken, format: 'brief', targetMinutes: 2, verification: 'strict', sourceMode: 'web',
      researchPrompt: 'Aktuelles, Kurioses oder Bemerkenswertes aus {ort} und der näheren Umgebung aus den letzten Tagen.',
      instructions: 'Eine konkrete Geschichte aus der Region, nah und anschaulich.' } },
  { id: 'wort-des-tages', name: 'Wort des Tages', description: 'Ein seltenes Wort und seine Geschichte', hidden: true, surprise: { weight: 1 },
    show: { ...spoken, format: 'brief', targetMinutes: 1, verification: 'light', sourceMode: 'web',
      researchPrompt: 'Ein ungewöhnliches, schönes deutsches Wort (gern Mundart oder veraltet): Bedeutung und belegte Herkunft.',
      instructions: 'Stelle das Wort vor, erkläre Bedeutung und Herkunft in wenigen Sätzen und gib ein Beispiel.' } },
  { id: 'frage-des-tages', name: 'Frage des Tages', description: 'Eine verblüffende Frage und ihre Antwort', hidden: true, surprise: { weight: 2 },
    show: { ...spoken, format: 'brief', targetMinutes: 1, verification: 'strict', sourceMode: 'web',
      researchPrompt: 'Eine verblüffende Alltags- oder Wissenschaftsfrage mit einer belegten, überraschenden Antwort.',
      instructions: 'Stelle die Frage, lass sie kurz wirken, dann die Antwort mit einem konkreten Detail.' } },
  { id: 'musik-wildcard', name: 'Musik-Wildcard', description: 'Musik, die du sonst nie hörst', music: true, hidden: true, surprise: { weight: 2 },
    show: { ...spoken, format: 'music_block', targetMinutes: 8, verification: 'off', sourceMode: 'web', instructions: 'Stelle die Songs als bewusste Überraschung abseits des üblichen Geschmacks vor.',
      groups: [{ name: 'Wildcard', playlists: [], taste: '' }], switchAfterTracks: 0, switchAfterMinutes: 0, talkSeconds: 20,
      triggers: { ...DEFAULT_TRIGGERS, blockEnd: false, beforeTrack: 1, afterTrack: 0, everyMinutes: 0 } } },
  { id: 'ueberraschungsstunde', name: 'Überraschungsstunde', description: 'Eine Themenstunde, deren Thema die KI wählt', music: true, hidden: true, surprise: { weight: 1, minLevel: 50 },
    show: { ...spoken, format: 'theme_hour', targetMinutes: 60, tracks: 8, talkSeconds: 90, verification: 'light', sourceMode: 'web',
      instructions: 'Wähle ein überraschendes Thema, das der Hörer nicht erwartet; erzähle es in Kapiteln mit passenden Songs.', production: 'standard' } },
  { id: 'vertiefung', name: 'Vertiefung', description: 'Mehr zum Beitrag davor', hidden: true,
    show: { ...spoken, format: 'brief', targetMinutes: 3, verification: 'strict', sourceMode: 'web',
      instructions: 'Vertiefe den vorherigen Beitrag: Hintergründe, Ursachen, Folgen und ein konkretes Beispiel. Wiederhole nicht, was er schon gesagt hat.' } },
];

/** The music wildcard draws one of these as its taste. */
export const WILDCARD = 'musik-wildcard';
export const WILDCARD_TASTES = [
  'Musik aus einem Land oder Jahrzehnt, das nicht im Geschmack des Hörers liegt',
  'Westafrikanischer Funk und Afrobeat der 1970er', 'Japanischer City Pop der 1980er', 'Brasilianische Tropicália',
  'Äthiopischer Jazz', 'Frühe elektronische Musik und Tape-Experimente', 'Anatolischer Psychedelic Rock', 'Schweizer Mundart abseits des Radios',
  'Barockmusik mit Originalinstrumenten', 'Kolumbianische Cumbia', 'Isländischer Indie', 'Delta-Blues der 1930er',
];

/** Palette entry that draws a surprise. */
export const SURPRISE_ID = 'ueberraschung';
export const SURPRISE_BLOCKS = BLOCKS.filter(block => block.surprise);
export const isSurprise = (showId: string) => !!blockOf(showId)?.surprise;

/**
 * Draws a surprise for the station: by weight, only those that fit (a location for regional ones, a
 * high enough level for a whole hour), never the one before.
 */
export function drawSurprise(config: StationConfig, random: () => number, avoid?: string): Block {
  const level = surpriseLevel(config);
  const fitting = SURPRISE_BLOCKS.filter(block => (!block.surprise!.needsLocation || config.location) && level >= (block.surprise!.minLevel ?? 0)
    && `${BLOCK_PREFIX}${block.id}` !== avoid && block.id !== avoid);
  const pool = fitting.length ? fitting : SURPRISE_BLOCKS.filter(block => !block.surprise!.needsLocation);
  let pick = random() * pool.reduce((sum, block) => sum + block.surprise!.weight, 0);
  for (const block of pool) { pick -= block.surprise!.weight; if (pick < 0) return block; }
  return pool[pool.length - 1];
}

/** 0 = never, 100 = often; 25 is about one surprise an hour. */
export const surpriseLevel = (config: StationConfig) => config.surprise ?? 25;
/** Share of spoken items the planner turns into a surprise. */
export const surpriseChance = (config: StationConfig) => surpriseLevel(config) / 100 * 0.45;

/** Timeline items of a block carry this show ID. */
export const BLOCK_PREFIX = '_block:';
export const blockOf = (showId: string) => showId.startsWith(BLOCK_PREFIX) ? BLOCKS.find(block => block.id === showId.slice(BLOCK_PREFIX.length)) : undefined;

/** The show a block item is produced with; the music block uses the station's music taste. */
export function blockShow(block: Block, config: StationConfig, subject?: string): ShowConfig {
  const show: ShowConfig = { ...structuredClone(block.show), id: `${BLOCK_PREFIX}${block.id}`, name: block.name, enabled: true };
  if (show.groups) show.groups = show.groups.map(group => ({ ...group, taste: block.id === WILDCARD ? subject?.trim() || WILDCARD_TASTES[0] : config.music.taste }));
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
    ...BLOCKS.filter(block => !block.hidden).map(({ show, hidden: _hidden, surprise: _surprise, ...block }) => ({ ...block, minutes: show.targetMinutes, music: !!block.music, own: false })),
    { id: SURPRISE_ID, name: 'Überraschung', description: 'Etwas, das du nicht erwartest', minutes: 2, music: false, own: false },
    { id: 'song', name: 'Song', description: 'Ein Song nach deinem Geschmack', minutes: SONG_MINUTES, music: true, own: false },
    ...config.shows.filter(show => show.enabled).map(show => {
      const focus = HOUR_FOCUS[show.format];
      return { id: `show:${show.id}`, name: show.name, description: `Deine Sendung · ${FORMAT_NAMES[show.format]}`, minutes: show.targetMinutes,
        music: bringsOwnMusic(show.format), own: true, ...(focus ? { input: OWN_INPUT[focus] } : {}) };
    }),
  ];
}
