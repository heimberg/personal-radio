export interface MistralVoice {
  id: string;
  name: string;
  type: 'preset';
  languages: string[];
  gender: string;
}

// Stable preset IDs documented in Mistral's own Voxtral TTS demo. The list endpoint
// does not consistently return built-in voices, so keep this small catalog local.
const PRESET_VOICES: MistralVoice[] = [
  { id: 'de_kerstin_cc0', name: 'Kerstin · Deutsch (CC0)', type: 'preset', languages: ['de-DE'], gender: 'female' },
  { id: 'en_paul_neutral', name: 'Paul · Neutral', type: 'preset', languages: ['en-US'], gender: 'male' },
  { id: 'gb_oliver_neutral', name: 'Oliver · Neutral', type: 'preset', languages: ['en-GB'], gender: 'male' },
  { id: 'gb_jane_neutral', name: 'Jane · Neutral', type: 'preset', languages: ['en-GB'], gender: 'female' },
  { id: 'fr_marie_neutral', name: 'Marie · Neutral', type: 'preset', languages: ['fr-FR'], gender: 'female' },
];

export async function listMistralVoices(): Promise<MistralVoice[]> {
  return PRESET_VOICES.map(voice => ({ ...voice, languages: [...voice.languages] }));
}
