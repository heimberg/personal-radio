// Family: the owner and the listeners of one Worker. They see who hears what, chat, share produced items
// into each other's program and greet each other on air. It stays inside the Worker; the API names members
// by their name only (never the owner's email).
import type { D1Database, StationStore } from './station-store.ts';
import { audioKeysOf } from './station-store.ts';
import type { Listener } from './listeners.ts';
import { placeSoon, toView } from './station.ts';
import type { StationConfig } from '../src/domain/station.ts';

export interface Member {
  /** Stable key for the API: `owner`, or the listener's name. */
  key: string;
  /** The owner ID in the database. */
  owner: string;
  name: string;
  kids: boolean;
}

/** The owner (named [ownerName], «Papa» unless set) and every listener, named after their entry in LISTENERS. */
export function familyMembers(ownerEmail: string, listeners: Map<string, Listener>, ownerName?: string): Member[] {
  const members: Member[] = [{ key: 'owner', owner: ownerEmail.toLowerCase(), name: ownerName?.trim().slice(0, 30) || 'Papa', kids: false }];
  for (const listener of listeners.values()) {
    const key = listener.owner.slice('listener:'.length);
    if (members.some(member => member.key === key)) continue;
    members.push({ key, owner: listener.owner, name: key.charAt(0).toUpperCase() + key.slice(1), kids: listener.kids });
  }
  return members;
}

export type MessageKind = 'text' | 'share' | 'greeting';
export interface FamilyMessage { id: number; sender: string; recipient: string | null; kind: MessageKind; text: string; created_at: string }

const MAX_MESSAGES = 1000;

export class FamilyStore {
  private db: D1Database;
  constructor(db: D1Database) { this.db = db; }

  async addMessage(sender: string, kind: MessageKind, text: string, now: Date, recipient?: string): Promise<number> {
    const row = await this.db.prepare(`INSERT INTO family_messages (sender, recipient, kind, text, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id`)
      .bind(sender, recipient ?? null, kind, text, now.toISOString()).first<{ id: number }>();
    // The chat keeps its last thousand messages.
    await this.db.prepare('DELETE FROM family_messages WHERE id <= ?').bind((row?.id ?? 0) - MAX_MESSAGES).run();
    return row?.id ?? 0;
  }

  async messages(limit = 100): Promise<FamilyMessage[]> {
    return (await this.db.prepare('SELECT * FROM family_messages ORDER BY id DESC LIMIT ?').bind(limit).all<FamilyMessage>()).results.reverse();
  }

  /** Messages from others since this member last read the chat. */
  async unread(owner: string): Promise<number> {
    const row = await this.db.prepare(`SELECT COUNT(*) AS n FROM family_messages WHERE sender != ?
      AND id > COALESCE((SELECT last_id FROM family_reads WHERE owner_id = ?), 0)`).bind(owner, owner).first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** The newest message from someone else that [owner] has not read yet. */
  async latestUnread(owner: string): Promise<FamilyMessage | null> {
    return this.db.prepare(`SELECT * FROM family_messages WHERE sender != ? AND id > COALESCE((SELECT last_id FROM family_reads WHERE owner_id = ?), 0)
      ORDER BY id DESC LIMIT 1`).bind(owner, owner).first<FamilyMessage>();
  }

  async markRead(owner: string, lastId: number) {
    await this.db.prepare(`INSERT INTO family_reads (owner_id, last_id) VALUES (?, ?)
      ON CONFLICT(owner_id) DO UPDATE SET last_id = MAX(family_reads.last_id, excluded.last_id)`).bind(owner, lastId).run();
  }

  async setPresence(owner: string, itemId: string, title: string, until: Date) {
    await this.db.prepare(`INSERT INTO family_presence (owner_id, item_id, title, until) VALUES (?, ?, ?, ?)
      ON CONFLICT(owner_id) DO UPDATE SET item_id = excluded.item_id, title = excluded.title, until = excluded.until`)
      .bind(owner, itemId, title, until.toISOString()).run();
  }

  /** What [owner] hears now; nothing once the item is over. */
  async presence(owner: string, now: Date): Promise<{ itemId: string; title: string } | null> {
    const row = await this.db.prepare('SELECT item_id, title FROM family_presence WHERE owner_id = ? AND until > ?')
      .bind(owner, now.toISOString()).first<{ item_id: string; title: string }>();
    return row ? { itemId: row.item_id, title: row.title } : null;
  }

  /** Profile picture versions by owner ID (only members who have one). */
  async avatars(): Promise<Map<string, string>> {
    return new Map((await this.db.prepare('SELECT owner_id, version FROM family_avatars').all<{ owner_id: string; version: string }>()).results
      .map(row => [row.owner_id, row.version]));
  }

  async setAvatar(owner: string, version: string | null) {
    if (version === null) await this.db.prepare('DELETE FROM family_avatars WHERE owner_id = ?').bind(owner).run();
    else await this.db.prepare(`INSERT INTO family_avatars (owner_id, version) VALUES (?, ?) ON CONFLICT(owner_id) DO UPDATE SET version = excluded.version`)
      .bind(owner, version).run();
  }

  async addGreeting(sender: string, recipient: string, text: string, now: Date) {
    await this.db.prepare('INSERT INTO family_greetings (sender, recipient, text, created_at) VALUES (?, ?, ?, ?)').bind(sender, recipient, text, now.toISOString()).run();
  }

  /** The oldest greeting not yet on air (from the last two days). */
  async pendingGreeting(recipient: string, now: Date): Promise<{ id: number; sender: string; text: string } | null> {
    return this.db.prepare(`SELECT id, sender, text FROM family_greetings WHERE recipient = ? AND aired_at IS NULL AND created_at > ? ORDER BY id LIMIT 1`)
      .bind(recipient, new Date(now.getTime() - 2 * 86_400_000).toISOString()).first<{ id: number; sender: string; text: string }>();
  }

  async markAired(id: number, now: Date) {
    await this.db.prepare('UPDATE family_greetings SET aired_at = ? WHERE id = ?').bind(now.toISOString(), id).run();
  }
}

/** One line for a message, as the chat and a notification show it. */
export function messageLine(message: FamilyMessage, members: Member[]): string {
  const name = (id: string | null) => members.find(member => member.owner === id)?.name ?? 'Jemand';
  if (message.kind === 'share') return `${name(message.sender)} hat «${message.text}» mit ${name(message.recipient)} geteilt`;
  if (message.kind === 'greeting') return `${name(message.sender)} grüsst ${name(message.recipient)}: «${message.text}»`;
  return `${name(message.sender)}: ${message.text}`;
}

/** A profile picture as the app sends it: a small JPEG or PNG, base64. Null when it is anything else. */
export function avatarImage(value: unknown): { bytes: Uint8Array; contentType: string } | null {
  if (typeof value !== 'string' || value.length < 100 || value.length > 400_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Uint8Array.from(atob(value), char => char.charCodeAt(0));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { bytes, contentType: 'image/jpeg' };
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return { bytes, contentType: 'image/png' };
  return null;
}

export const avatarKey = (member: Member) => `avatars/${member.key}`;

/** Something to copy: produced, with its audio still kept. */
const SHAREABLE = ['ready', 'played', 'skipped', 'archived'];

export interface AudioObjects {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; httpMetadata?: { contentType?: string } } | null>;
  put(key: string, value: Uint8Array, options: { httpMetadata: { contentType: string } }): Promise<unknown>;
}

/**
 * Copies a produced item (its script, sources and audio) into another member's program, right behind
 * the item that plays next there. Nothing is produced again. Returns the new item's ID, or null when the
 * item cannot be shared (not produced, or its audio already released).
 */
export async function copyItem(from: { store: StationStore; owner: string; config: StationConfig | null }, itemId: string,
  to: { store: StationStore; owner: string }, audio: AudioObjects, sharedBy: string, now: Date, newId: string): Promise<{ id: string; title: string } | null> {
  const row = await from.store.getItem(from.owner, itemId);
  if (!row || !SHAREABLE.includes(row.state) || !row.script_json) return null;
  const keys = audioKeysOf(row);
  if (!keys.length) return null;
  const view = toView(row, from.config);
  let script = row.script_json, audioKey: string | null = null;
  for (const key of keys) {
    const object = await audio.get(key);
    if (!object) return null;
    const copy = key.replace(row.id, newId);
    await audio.put(copy, new Uint8Array(await object.arrayBuffer()), { httpMetadata: { contentType: object.httpMetadata?.contentType ?? row.content_type ?? 'audio/mpeg' } });
    script = script.split(JSON.stringify(key)).join(JSON.stringify(copy));
    if (key === row.audio_key) audioKey = copy;
  }
  const last = await to.store.lastItem(to.owner);
  await to.store.insertItem(to.owner, { id: newId, seq: (last?.seq ?? 0) + 1, showId: row.show_id, plannedAt: now.toISOString(), estimatedMinutes: row.estimated_minutes }, now);
  // A story's choice belongs to the sender's series; it does not travel with the copy.
  const { choice: _choice, ...research } = (() => { try { return JSON.parse(row.research_json ?? 'null') ?? {}; } catch { return {}; } })() as Record<string, unknown>;
  await to.store.update(to.owner, newId, {
    state: 'ready', script_json: script, sources_json: row.sources_json, verification: row.verification,
    audio_key: audioKey ?? (row.audio_key ? row.audio_key.replace(row.id, newId) : null), content_type: row.content_type,
    research_json: JSON.stringify({ ...research, sharedBy, sharedShow: view.showName }),
  }, now);
  await placeSoon({ store: to.store, now: () => now }, to.owner, newId);
  return { id: newId, title: view.title ?? view.showName };
}

/** Who may put what into whose program: a child's station only takes what the owner shares. */
export function mayCopyInto(sender: Member, recipient: Member): boolean {
  return !recipient.kids || sender.key === 'owner';
}

