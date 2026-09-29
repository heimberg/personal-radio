import { useEffect, useState } from 'react';
import type React from 'react';
import type { BlockView } from '../domain/blocks.ts';
import type { StationConfig } from '../domain/station.ts';
import { KINDS, lookOfBlock } from '../domain/kinds.ts';
import { api, post, readJson } from '../station-client.ts';

interface Props { busy: boolean; config?: StationConfig; onAdded(message: string): Promise<void>; onFailed(message: string): void }

/**
 * Ready-made building blocks: a click adds one at the start of the program, blocks that take a word
 * (a topic, an artist) ask for it first; empty lets the AI choose. Nothing to write or configure.
 */
export function BlockPalette({ busy, config, onAdded, onFailed }: Props) {
  const [blocks, setBlocks] = useState<BlockView[]>([]);
  const [asking, setAsking] = useState<BlockView | null>(null);
  const [word, setWord] = useState('');

  useEffect(() => {
    fetch(api('api/blocks'), { credentials: 'same-origin' })
      .then(response => readJson<{ blocks?: BlockView[] }>(response))
      .then(result => setBlocks(result.blocks ?? []))
      .catch(() => setBlocks([]));
  }, []);

  async function add(block: BlockView, subject = '') {
    setAsking(null); setWord('');
    try {
      await post(`api/blocks/${encodeURIComponent(block.id)}/add`, subject.trim() ? { subject: subject.trim() } : {});
      await onAdded(`«${block.name}»${subject.trim() ? ` über «${subject.trim()}»` : ''} kommt als Nächstes und wird produziert.`);
    } catch { onFailed(`«${block.name}» konnte nicht hinzugefügt werden.`); }
  }

  if (!blocks.length) return null;
  return <div className="blocks" role="group" aria-label="Bausteine">
    <p className="muted">Baustein antippen – er kommt als Nächstes ins Programm.</p>
    <div className="block-list">{blocks.map(block => {
      const look = lookOfBlock(block.id, config ?? null, block.music);
      return <button type="button" key={block.id} className={`block kind-${look.kind} ${block.own ? 'own' : ''}`} disabled={busy}
        style={{ '--kind': KINDS[look.kind].color } as React.CSSProperties}
        aria-pressed={asking?.id === block.id} onClick={() => block.input ? setAsking(asking?.id === block.id ? null : block) : void add(block)}>
        <span className="block-icon" aria-hidden="true">{look.icon}</span>
        <strong>{block.name}{block.music ? ' ♫' : ''}</strong><small>{block.description}</small>
      </button>;
    })}</div>
    {asking?.input && <form className="inline block-ask" onSubmit={event => { event.preventDefault(); void add(asking, word); }}>
      <label className="sr-only" htmlFor="block-word">{asking.input.label}</label>
      <input id="block-word" autoFocus value={word} maxLength={200} placeholder={`${asking.input.label} – leer: die KI wählt (${asking.input.example})`} onChange={event => setWord(event.target.value)} />
      <button className="button primary" type="submit" disabled={busy}>Hinzufügen</button>
    </form>}
  </div>;
}
