export interface MistralVoice {
  id: string;
  name: string;
  type: 'preset' | 'custom';
  languages: string[];
  gender?: string;
}

// Mistral's public preset voices are not consistently returned by the voice-list API.
// These IDs are the preset slugs used by Mistral's own Voxtral TTS demo.
const PRESET_VOICES: MistralVoice[] = [
  { id: 'en_paul_neutral', name: 'Paul · Neutral', type: 'preset', languages: ['en-US'], gender: 'male' },
  { id: 'gb_oliver_neutral', name: 'Oliver · Neutral', type: 'preset', languages: ['en-GB'], gender: 'male' },
  { id: 'gb_jane_neutral', name: 'Jane · Neutral', type: 'preset', languages: ['en-GB'], gender: 'female' },
  { id: 'fr_marie_neutral', name: 'Marie · Neutral', type: 'preset', languages: ['fr-FR'], gender: 'female' },
];

/** Returns known presets even if the optional Mistral voice catalog is unavailable. */
export async function listMistralVoices(apiKey: string, fetcher: typeof fetch = fetch): Promise<MistralVoice[]> {
  if (!apiKey) return PRESET_VOICES;
  try {
    const response = await fetcher('https://api.mistral.ai/v1/audio/voices?limit=1000&type=all', {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return PRESET_VOICES;
    const payload = await response.json() as { items?: unknown };
    if (!Array.isArray(payload.items) || payload.items.length > 1000) return PRESET_VOICES;
    const listed = payload.items.flatMap((item: any) => {
      if (!item || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(item.id) ||
          typeof item.name !== 'string' || item.name.length > 120 ||
          (item.type !== 'preset' && item.type !== 'custom')) return [];
      const languages = Array.isArray(item.languages)
        ? item.languages.filter((language: unknown): language is string =>
          typeof language === 'string' && /^[a-zA-Z-]{2,12}$/.test(language)).slice(0, 20)
        : [];
      return [{ id: item.id, name: item.name, type: item.type, languages,
        ...(typeof item.gender === 'string' && item.gender.length <= 32 ? { gender: item.gender } : {}) }];
    });
    const voices = new Map<string, MistralVoice>();
    for (const voice of [...PRESET_VOICES, ...listed]) voices.set(voice.id, voice);
    return [...voices.values()];
  } catch {
    return PRESET_VOICES;
  }
}
