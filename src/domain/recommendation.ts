export type FeedbackAction = 'like' | 'dislike' | 'skip' | 'complete';
export interface FeedbackEvent {
  itemId: string;
  interests: string[];
  action: FeedbackAction;
  listenedRatio: number;
  createdAt: string;
}
export interface Candidate { id: string; interests: string[]; publishedAt?: string }

const HALF_LIFE_DAYS = 45;

export function parseFeedback(value: unknown): FeedbackEvent[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is FeedbackEvent => !!item && typeof item === 'object' &&
    typeof item.itemId === 'string' && item.itemId.length <= 120 && Array.isArray(item.interests) &&
    item.interests.length <= 30 && item.interests.every((tag: unknown) => typeof tag === 'string' && tag.length <= 48) &&
    ['like', 'dislike', 'skip', 'complete'].includes(item.action) && Number.isFinite(item.listenedRatio) &&
    item.listenedRatio >= 0 && item.listenedRatio <= 1 && typeof item.createdAt === 'string' &&
    Number.isFinite(Date.parse(item.createdAt))).slice(-200);
}

export function learnedWeights(events: FeedbackEvent[], now = Date.now()): Record<string, number> {
  const sums = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const event of parseFeedback(events)) {
    // A very early skip is likely interruption or accidental playback, not a negative vote.
    if (event.action === 'skip' && event.listenedRatio < 0.2) continue;
    const ageDays = Math.max(0, (now - Date.parse(event.createdAt)) / 86_400_000);
    const recency = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
    const signal = event.action === 'like' ? 1 : event.action === 'dislike' ? -1 :
      event.action === 'complete' ? 0.18 : event.listenedRatio < 0.5 ? -0.22 : -0.08;
    for (const tag of new Set(event.interests)) {
      sums.set(tag, (sums.get(tag) ?? 0) + signal * recency);
      counts.set(tag, (counts.get(tag) ?? 0) + recency);
    }
  }
  // Neutral prior pulls sparse and old evidence back towards zero as it decays.
  return Object.fromEntries([...sums].map(([tag, sum]) => [tag,
    Math.max(-1, Math.min(1, sum / (1 + (counts.get(tag) ?? 0))))]));
}

/** Content-first score with an explicit epsilon-greedy exploration chance. */
export function rankCandidates<T extends Candidate>(candidates: T[], explicitInterests: string[], weights: Record<string, number>, explorationPercent: number, seed = Math.random()): T[] {
  const explicit = new Set(explicitInterests.map(x => x.toLocaleLowerCase()));
  const scored = candidates.map(candidate => {
    const tags = [...new Set(candidate.interests.map(x => x.toLocaleLowerCase()))];
    const relevance = tags.reduce((total, tag) => total + (explicit.has(tag) ? 0.5 : 0) + (weights[tag] ?? weights[Object.keys(weights).find(key => key.toLocaleLowerCase() === tag) ?? ''] ?? 0), 0) / Math.max(tags.length, 1);
    return { candidate, relevance, tie: Math.random() };
  }).sort((a, b) => b.relevance - a.relevance || a.tie - b.tie);
  const explorationChance = Math.max(0, Math.min(50, explorationPercent)) / 100;
  if (scored.length < 2 || explorationChance === 0 || seed >= explorationChance) return scored.map(item => item.candidate);
  const pool = scored.slice(1);
  const selected = pool[Math.min(pool.length - 1, Math.floor(seed / explorationChance * pool.length))]!;
  return [selected, ...scored.filter(item => item !== selected)].map(item => item.candidate);
}
