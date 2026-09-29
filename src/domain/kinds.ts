// What kind of content something is: news, discovery, weather, music or a surprise. Each kind has a
// colour, shared with the Android app (core/Kinds.kt), which also gives every block its icon.

export type Kind = 'news' | 'discover' | 'weather' | 'music' | 'surprise';

/** Colours on the dark ground; always shown with an icon and a name, never as the only cue. */
export const KINDS: Record<Kind, { label: string; color: string }> = {
  news: { label: 'Aktuell', color: '#D08A2A' },
  discover: { label: 'Wissen', color: '#2BA57A' },
  weather: { label: 'Wetter', color: '#5B95F5' },
  music: { label: 'Musik', color: '#D06BD8' },
  surprise: { label: 'Überraschung', color: '#F0704F' },
};
