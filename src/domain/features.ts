// What the station does on its own, switched on or off in one place, and which building blocks the
// palette shows. Missing settings mean the defaults below, so older stations keep working unchanged.
import type { StationConfig } from './station.ts';

export const FEATURE_IDS = ['review', 'concerts', 'follow', 'quiz', 'places', 'linker'] as const;
export type FeatureId = typeof FEATURE_IDS[number];

export interface FeatureInfo {
  id: FeatureId;
  name: string;
  description: string;
  /** What it costs when it runs, in words. */
  cost: string;
  /** Default when the station has no setting. */
  default: boolean;
  /** Only shown on a child's station (quiz) or only for stations with Spotify (concerts) – see `featureViews`. */
  only?: 'kids' | 'grownups';
}

export const FEATURES: readonly FeatureInfo[] = [
  { id: 'linker', name: 'Live-Übergänge', description: 'Die Moderation verbindet die Beiträge mit ein, zwei Sätzen, beantwortet Fragen ans Radio und liest Grüsse vor.', cost: 'kurzer KI-Aufruf und Sprache pro Übergang', default: true },
  { id: 'review', name: 'Wochenrückblick', description: 'Sonntags ab 8 Uhr: das Beste der Woche, deine Fragen und Entscheidungen.', cost: 'eine Produktion pro Woche', default: true },
  { id: 'follow', name: 'Dranbleiben', description: 'Deine Themen werden täglich geprüft; ein Beitrag kommt nur, wenn es Neues gibt.', cost: 'eine Suche und ein KI-Aufruf pro Thema und Tag', default: true },
  { id: 'concerts', name: 'Konzerte in der Nähe', description: 'Freitags ab 16 Uhr: wo deine Spotify-Künstler bald in der Schweiz spielen.', cost: 'eine Produktion pro Woche', default: true, only: 'grownups' },
  { id: 'quiz', name: 'Quizfragen', description: 'Wissensbeiträge enden mit einer Quizfrage; richtige Antworten bringen Sticker.', cost: 'ein KI-Aufruf pro Beitrag', default: true, only: 'kids' },
  { id: 'places', name: 'Ortsgeschichten unterwegs', description: 'Kommst du an einem neuen Ort vorbei, erzählt das Radio kurz seine Geschichte. Braucht den Standort, solange die App offen ist.', cost: 'eine Produktion pro Ort', default: false },
];

export type FeatureSettings = Partial<Record<FeatureId, boolean>>;

/** Whether [id] is on for the station: its setting, else the default (live transitions follow `sounds.linker`). */
export function featureOn(config: StationConfig, id: FeatureId): boolean {
  if (id === 'linker') return config.sounds?.linker ?? true;
  return config.features?.[id] ?? FEATURES.find(feature => feature.id === id)!.default;
}

/** Validated feature settings; unknown keys and non-booleans are left out. */
export function parseFeatures(value: unknown): FeatureSettings | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const settings: FeatureSettings = {};
  for (const id of FEATURE_IDS) {
    const on = (value as Record<string, unknown>)[id];
    if (typeof on === 'boolean' && id !== 'linker') settings[id] = on;
  }
  return Object.keys(settings).length ? settings : undefined;
}

/** Hidden building blocks: short IDs only, at most 60. */
export function parseHiddenBlocks(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = [...new Set(value.filter((id): id is string => typeof id === 'string' && /^(song|ueberraschung|[a-z0-9-]{1,40}|show:[a-z0-9-]{1,40})$/.test(id)))].slice(0, 60);
  return ids.length ? ids : undefined;
}
