// Server-only orchestration. Invoke only after authenticating the owner.
import { parseProfile, parseScript } from '../src/domain/program.ts';
import type { Profile, Source, Script, TextGenerator, SpeechSynthesizer } from '../src/domain/program.ts';

export interface EditorialDecision { approved: boolean; reasons: string[] }
export interface EditorialVerifier { verify(script: Script, sources: Source[]): Promise<EditorialDecision> }
export interface PreparedSegment { script: Script; audio: Uint8Array; contentType: 'audio/mpeg'; ttsCharacters: number }
export interface CharacterBudgetStore { reserve(ownerId: string, characters: number): Promise<void> }

export class PipelineError extends Error {
  readonly code: 'INVALID_INPUT' | 'REJECTED' | 'BUDGET_EXCEEDED' | 'IDEMPOTENCY_CONFLICT' | 'TOO_MANY_REQUESTS';
  constructor(code: PipelineError['code']) {
    super(code); this.code = code;
  }
}

function validateSources(sources: Source[]) {
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > 8) throw new PipelineError('INVALID_INPUT');
  const ids = new Set<string>(); let total = 0;
  for (const source of sources) {
    if (!source || typeof source.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(source.id) || ids.has(source.id) ||
        typeof source.title !== 'string' || source.title.length > 300 ||
        typeof source.excerpt !== 'string' || !source.excerpt.trim() || source.excerpt.length > 12_000 ||
        typeof source.publishedAt !== 'string' || !Number.isFinite(Date.parse(source.publishedAt)) ||
        typeof source.retrievedAt !== 'string' || !Number.isFinite(Date.parse(source.retrievedAt))) {
      throw new PipelineError('INVALID_INPUT');
    }
    let url: URL;
    try { url = new URL(source.url); } catch { throw new PipelineError('INVALID_INPUT'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new PipelineError('INVALID_INPUT');
    ids.add(source.id); total += source.excerpt.length;
  }
  if (total > 24_000) throw new PipelineError('INVALID_INPUT');
}

/** Hard cap per individual segment, before any paid provider call. */
export class CharacterBudget implements CharacterBudgetStore {
  private spent = new Map<string, { day: string; used: number }>();
  readonly maxCharactersPerOwnerPerDay: number;
  private readonly now: () => Date;
  constructor(maxCharactersPerOwnerPerDay = 12_000, now = () => new Date()) {
    this.maxCharactersPerOwnerPerDay = maxCharactersPerOwnerPerDay;
    this.now = now;
    if (!Number.isSafeInteger(maxCharactersPerOwnerPerDay) || maxCharactersPerOwnerPerDay < 1) throw new Error('Invalid character budget');
  }
  async reserve(ownerId: string, characters: number) {
    if (!ownerId || !Number.isSafeInteger(characters) || characters < 1) throw new PipelineError('INVALID_INPUT');
    const day = this.now().toISOString().slice(0, 10), current = this.spent.get(ownerId);
    const used = current?.day === day ? current.used : 0;
    if (characters > this.maxCharactersPerOwnerPerDay - used) throw new PipelineError('BUDGET_EXCEEDED');
    // Count before the provider call. A timeout might occur after the provider charged for the request.
    this.spent.set(ownerId, { day, used: used + characters });
  }
}

export class SegmentPipeline {
  private active = new Map<string, { fingerprint: string; promise: Promise<PreparedSegment> }>();
  private readonly text: TextGenerator;
  private readonly speech: SpeechSynthesizer;
  private readonly verifier: EditorialVerifier;
  private readonly budget: CharacterBudgetStore;
  private readonly maxConcurrent: number;
  constructor(
    text: TextGenerator,
    speech: SpeechSynthesizer,
    verifier: EditorialVerifier,
    budget: CharacterBudgetStore,
    maxConcurrent = 4,
  ) {
    this.text = text; this.speech = speech; this.verifier = verifier;
    this.budget = budget; this.maxConcurrent = maxConcurrent;
  }

  prepare(ownerId: string, idempotencyKey: string, profile: Profile, sources: Source[]): Promise<PreparedSegment> {
    if (!ownerId || !/^[a-zA-Z0-9_-]{12,100}$/.test(idempotencyKey)) return Promise.reject(new PipelineError('INVALID_INPUT'));
    try { validateSources(sources); } catch (error) { return Promise.reject(error); }
    const safeProfile = parseProfile(profile);
    const fingerprint = JSON.stringify({ profile: safeProfile, sources });
    const key = `${ownerId}:${idempotencyKey}`;
    const existing = this.active.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return Promise.reject(new PipelineError('IDEMPOTENCY_CONFLICT'));
      return existing.promise;
    }
    if (this.active.size >= this.maxConcurrent) return Promise.reject(new PipelineError('TOO_MANY_REQUESTS'));
    // Remove settled entries: this coalesces concurrent retries only, not retries after completion.
    const promise = this.run(ownerId, safeProfile, sources).finally(() => this.active.delete(key));
    this.active.set(key, { fingerprint, promise });
    return promise;
  }

  private async run(ownerId: string, profile: Profile, sources: Source[]): Promise<PreparedSegment> {
    const script = parseScript(await this.text.generate(profile, sources), sources);
    if (script.text.length > 6_000 || [...script.text.trim().split(/\s+/)].length > 280) throw new PipelineError('INVALID_INPUT');
    let decision: EditorialDecision;
    try { decision = await this.verifier.verify(script, sources); }
    catch { throw new PipelineError('REJECTED'); }
    if (!decision.approved) throw new PipelineError('REJECTED');
    const characters = [...script.text].length;
    await this.budget.reserve(ownerId, characters);
    const audio = await this.speech.synthesize(script.text);
    if (!(audio instanceof Uint8Array) || audio.length < 1 || audio.length > 12_000_000) throw new PipelineError('INVALID_INPUT');
    return { script, audio, contentType: 'audio/mpeg', ttsCharacters: characters };
  }
}
