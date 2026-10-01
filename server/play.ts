// Mitmachen on the server: the sticker album and the questions to the radio, kept per listener in D1.
import type { D1Database } from './station-store.ts';
import type { Sticker } from '../src/domain/play.ts';
import { STICKERS, drawSticker, stickerById } from '../src/domain/play.ts';

export type StickerReason = 'quiz' | 'choice' | 'episode';
export interface EarnedSticker extends Sticker { reason: StickerReason; at: string }

/** Questions older than this are not answered on air any more. */
const QUESTION_DAYS = 2;

export class PlayStore {
  private db: D1Database;
  constructor(db: D1Database) { this.db = db; }

  async stickers(owner: string): Promise<EarnedSticker[]> {
    const rows = (await this.db.prepare('SELECT sticker, reason, created_at FROM stickers WHERE owner_id = ? ORDER BY id').bind(owner)
      .all<{ sticker: string; reason: StickerReason; created_at: string }>()).results;
    return rows.flatMap(row => { const sticker = stickerById(row.sticker); return sticker ? [{ ...sticker, reason: row.reason, at: row.created_at }] : []; });
  }

  /** A new sticker for the album: one the listener does not have yet, while there are any. */
  async award(owner: string, reason: StickerReason, now: Date, random?: () => number): Promise<Sticker> {
    const sticker = drawSticker((await this.stickers(owner)).map(item => item.id), random);
    await this.db.prepare('INSERT INTO stickers (owner_id, sticker, reason, created_at) VALUES (?, ?, ?, ?)').bind(owner, sticker.id, reason, now.toISOString()).run();
    return sticker;
  }

  async addQuestion(owner: string, text: string, now: Date): Promise<number> {
    const row = await this.db.prepare('INSERT INTO radio_questions (owner_id, text, created_at) VALUES (?, ?, ?) RETURNING id')
      .bind(owner, text, now.toISOString()).first<{ id: number }>();
    return row?.id ?? 0;
  }

  /** The oldest question not answered yet (from the last two days). */
  async pendingQuestion(owner: string, now: Date): Promise<{ id: number; text: string } | null> {
    return this.db.prepare('SELECT id, text FROM radio_questions WHERE owner_id = ? AND aired_at IS NULL AND created_at > ? ORDER BY id LIMIT 1')
      .bind(owner, new Date(now.getTime() - QUESTION_DAYS * 86_400_000).toISOString()).first<{ id: number; text: string }>();
  }

  async answered(id: number, answer: string, now: Date) {
    await this.db.prepare('UPDATE radio_questions SET aired_at = ?, answer = ? WHERE id = ?').bind(now.toISOString(), answer, id).run();
  }

  /** The listener's recent questions, newest first, with the answer once it was on air. */
  async questions(owner: string, limit = 20): Promise<Array<{ id: number; text: string; at: string; answer: string | null }>> {
    return (await this.db.prepare('SELECT id, text, created_at AS at, answer FROM radio_questions WHERE owner_id = ? ORDER BY id DESC LIMIT ?')
      .bind(owner, limit).all<{ id: number; text: string; at: string; answer: string | null }>()).results;
  }
}

/** The album for the app: every sticker, with when it was earned (the first time) for those the listener has. */
export function albumView(earned: EarnedSticker[]) {
  const first = new Map<string, EarnedSticker>();
  for (const item of earned) if (!first.has(item.id)) first.set(item.id, item);
  return {
    total: STICKERS.length,
    count: first.size,
    stickers: STICKERS.map(sticker => ({ ...sticker, ...(first.has(sticker.id) ? { at: first.get(sticker.id)!.at } : {}) })),
  };
}
