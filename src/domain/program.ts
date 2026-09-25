export type Topic = 'Technologie' | 'Wissenschaft' | 'Kultur';
export interface Profile {
  topics: Topic[];
  speechMinutes: number;
  exploration: number;
}
export interface Source {
  id: string;
  url: string;
  title: string;
  publishedAt: string;
  retrievedAt: string;
  excerpt: string;
}
export interface Script {
  title: string;
  text: string;
  sourceIds: string[];
}
export interface TextGenerator {
  generate(profile: Profile, sources: Source[]): Promise<Script>;
}
export interface SpeechSynthesizer {
  synthesize(text: string): Promise<Uint8Array>;
}

export const defaultProfile: Profile = {
  topics: ['Technologie', 'Wissenschaft'], speechMinutes: 3, exploration: 20,
};

export function parseScript(value: unknown, sources: Source[]): Script {
  if (!value || typeof value !== 'object') throw new Error('Ungültiges Skript');
  const script = value as Record<string, unknown>;
  if (typeof script.title !== 'string' || !script.title.trim() || script.title.length > 160 ||
      typeof script.text !== 'string' || !script.text.trim() || script.text.length > 6000 ||
      !Array.isArray(script.sourceIds) || script.sourceIds.length === 0 ||
      script.sourceIds.some(id => typeof id !== 'string' || !sources.some(source => source.id === id))) {
    throw new Error('Skript oder Quellenverweise ungültig');
  }
  return { title: script.title, text: script.text, sourceIds: [...new Set(script.sourceIds as string[])] };
}

export function parseProfile(raw: unknown): Profile {
  if (!raw || typeof raw !== 'object') return { ...defaultProfile, topics: [...defaultProfile.topics] };
  const p = raw as Record<string, unknown>;
  const topics = Array.isArray(p.topics)
    ? p.topics.filter((t): t is Topic => ['Technologie', 'Wissenschaft', 'Kultur'].includes(String(t)))
    : defaultProfile.topics;
  return {
    topics: [...new Set(topics)],
    speechMinutes: typeof p.speechMinutes === 'number' && Number.isFinite(p.speechMinutes)
      ? Math.min(10, Math.max(1, p.speechMinutes)) : 3,
    exploration: typeof p.exploration === 'number' && Number.isFinite(p.exploration)
      ? Math.min(50, Math.max(0, p.exploration)) : 20,
  };
}
