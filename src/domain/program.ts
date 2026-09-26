export type Topic = 'Technologie' | 'Wissenschaft' | 'Kultur';
export interface Profile {
  topics: Topic[];
  interests: string[];
  interestWeights: Record<string, number>;
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
  turns?: Array<{ speaker: 'host-a' | 'host-b'; text: string }>;
  interestTags?: string[];
}
export interface TextGenerator {
  generate(profile: Profile, sources: Source[]): Promise<Script>;
}
export interface SpeechSynthesizer {
  synthesize(text: string, turns?: Script['turns']): Promise<Uint8Array>;
}

export const defaultProfile: Profile = {
  topics: ['Technologie', 'Wissenschaft'], interests: [], interestWeights: {}, speechMinutes: 3, exploration: 20,
};

export function parseScript(value: unknown, sources: Source[]): Script {
  if (!value || typeof value !== 'object') throw new Error('Ungültiges Skript');
  const script = value as Record<string, unknown>;
  if (typeof script.title !== 'string' || !script.title.trim() || script.title.length > 160 ||
      typeof script.text !== 'string' || !script.text.trim() || script.text.length > 12_000 ||
      !Array.isArray(script.sourceIds) || script.sourceIds.length === 0 ||
      script.sourceIds.some(id => typeof id !== 'string' || !sources.some(source => source.id === id))) {
    throw new Error('Skript oder Quellenverweise ungültig');
  }
  let turns: Script['turns'];
  if (script.turns !== undefined) {
    if (!Array.isArray(script.turns) || script.turns.length < 2 || script.turns.length > 32 ||
        script.turns.some(turn => !turn || (turn.speaker !== 'host-a' && turn.speaker !== 'host-b') ||
          typeof turn.text !== 'string' || !turn.text.trim() || turn.text.length > 4000)) {
      throw new Error('Dialogstruktur ungültig');
    }
    turns = script.turns as NonNullable<Script['turns']>;
    if (turns.map(turn => turn.text).join(' ').trim() !== script.text.trim()) throw new Error('Dialogtext stimmt nicht mit dem Skript überein');
  }
  let interestTags: string[] | undefined;
  if (script.interestTags !== undefined) {
    if (!Array.isArray(script.interestTags) || script.interestTags.length > 30 || script.interestTags.some(tag => typeof tag !== 'string' || tag.length > 48)) throw new Error('Themenmarkierungen ungültig');
    interestTags = [...new Set(script.interestTags as string[])];
  }
  return { title: script.title, text: script.text, sourceIds: [...new Set(script.sourceIds as string[])], ...(turns ? { turns } : {}), ...(interestTags ? { interestTags } : {}) };
}

export function parseProfile(raw: unknown): Profile {
  if (!raw || typeof raw !== 'object') return { ...defaultProfile, topics: [...defaultProfile.topics], interests: [], interestWeights: {} };
  const p = raw as Record<string, unknown>;
  const topics = Array.isArray(p.topics)
    ? p.topics.filter((t): t is Topic => ['Technologie', 'Wissenschaft', 'Kultur'].includes(String(t)))
    : defaultProfile.topics;
  const interests = Array.isArray(p.interests)
    ? [...new Set(p.interests.filter((value): value is string => typeof value === 'string').map(value => value.trim()).filter(value => value.length > 0 && value.length <= 48))].slice(0, 30)
    : [];
  const rawWeights = p.interestWeights && typeof p.interestWeights === 'object' ? p.interestWeights as Record<string, unknown> : {};
  const allowedInterests = [...new Set([...topics, ...interests])];
  const interestWeights = Object.fromEntries(Object.entries(rawWeights).filter(([key, value]) =>
    allowedInterests.includes(key) && typeof value === 'number' && Number.isFinite(value))
      .map(([key, value]) => [key, Math.max(-1, Math.min(1, value as number))]));
  return {
    topics: [...new Set(topics)],
    interests,
    interestWeights,
    speechMinutes: typeof p.speechMinutes === 'number' && Number.isFinite(p.speechMinutes)
      ? Math.min(10, Math.max(1, p.speechMinutes)) : 3,
    exploration: typeof p.exploration === 'number' && Number.isFinite(p.exploration)
      ? Math.min(50, Math.max(0, p.exploration)) : 20,
  };
}
