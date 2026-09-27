export interface MistralVoice {
  id: string;
  name: string;
  type: 'preset' | 'custom';
  languages: string[];
  gender?: string;
}

/** Lists available preset and account-owned voices without exposing the API key. */
export async function listMistralVoices(apiKey: string, fetcher: typeof fetch = fetch): Promise<MistralVoice[]> {
  if (!apiKey) throw new Error('Mistral is not configured');
  let response: Response;
  try {
    response = await fetcher('https://api.mistral.ai/v1/audio/voices?limit=1000&type=all', {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error('Mistral voice catalog unavailable');
  }
  if (!response.ok) throw new Error('Mistral voice catalog unavailable');
  try {
    const payload = await response.json() as { items?: unknown };
    if (!Array.isArray(payload.items) || payload.items.length > 1000) throw new Error();
    return payload.items.flatMap((item: any) => {
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
  } catch {
    throw new Error('Mistral returned an invalid voice catalog');
  }
}
