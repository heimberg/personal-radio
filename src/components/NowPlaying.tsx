import { useSyncExternalStore } from 'react';
import type React from 'react';
import { KINDS } from '../domain/kinds.ts';
import type { Kind } from '../domain/kinds.ts';
import type { RadioPlayer } from '../audio/player.ts';
import type { FeedbackAction } from '../domain/recommendation.ts';
import { FEEDBACK_REASONS, REASON_IDS } from '../domain/listener-notes.ts';
import type { FeedbackReason } from '../domain/listener-notes.ts';

interface Props {
  player: RadioPlayer; readyCount: number; onListen(): void; onRate(action: FeedbackAction): void; rated: FeedbackAction | null;
  onReason(reason: FeedbackReason): void; reason: FeedbackReason | null;
  onMore(): void; deepened: boolean;
  /** Kind and icon of the playing item: the player takes its colour. */
  look?: { kind: Kind; icon: string };
}

const STATUS: Record<string, string> = {
  idle: 'Bereit', loading: 'Wird gestartet', playing: 'Läuft', paused: 'Pausiert', buffering: 'Wird geladen', ended: 'Warte auf den nächsten Beitrag', error: 'Unterbrochen',
};
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

/** Listening in the browser: the spoken program. Music hours play in the Android app, where Spotify is. */
export function NowPlaying({ player, readyCount, onListen, onRate, rated, onReason, reason, onMore, deepened, look }: Props) {
  const state = useSyncExternalStore(player.subscribe, player.snapshot);
  const track = player.tracks[state.index];
  const started = player.tracks.length > 0;
  const active = ['playing', 'loading', 'buffering'].includes(state.status);

  const shown = started && look ? look : undefined;
  return <section className={`now ${active ? 'live' : ''}`} aria-label="Audioplayer" style={{ '--kind': shown ? KINDS[shown.kind].color : 'var(--brand)' } as React.CSSProperties}>
    <div className="now-top">
      <span className={`eq ${active ? 'on' : ''}`} aria-hidden="true"><i /><i /><i /><i /></span>
      <span>{started ? STATUS[state.status] : `${readyCount} ${readyCount === 1 ? 'Beitrag' : 'Beiträge'} bereit`}</span>
      {shown && <span className="now-chip"><span aria-hidden="true">{shown.icon}</span> {KINDS[shown.kind].label}</span>}
    </div>
    <p className="now-kind">{track?.kind ?? 'Dein Programm'}</p>
    <h2 className="now-title">{track?.title ?? 'Einschalten und zuhören.'}</h2>
    {started && <>
      <label className="sr-only" htmlFor="seek">Wiedergabeposition</label>
      <input id="seek" type="range" min="0" max={state.duration || 1} step="0.1" value={Math.min(state.position, state.duration || 1)} disabled={!state.duration} onChange={event => player.seek(Number(event.target.value))} />
      <div className="now-time"><span>{clock(state.position)}</span><span>{clock(state.duration)}</span></div>
    </>}
    <div className="now-controls">
      {started && <button className="round" aria-label="Vorheriger Beitrag" onClick={() => void player.previous()}>⏮</button>}
      <button className="play" onClick={() => !started ? onListen() : active ? player.pause() : void player.start()}>{!started ? '▶ Programm hören' : active ? 'Ⅱ Pause' : '▶ Weiter'}</button>
      {started && <button className="round" aria-label="Nächster Beitrag" onClick={() => void player.next()}>⏭</button>}
    </div>
    {track?.timelineId && <div className="now-rate" role="group" aria-label="Beitrag bewerten">
      <button aria-label="Mehr davon" aria-pressed={rated === 'like'} onClick={() => onRate('like')}>👍 Mehr davon</button>
      <button aria-label="Weniger davon" aria-pressed={rated === 'dislike'} onClick={() => onRate('dislike')}>👎 Weniger</button>
      <button aria-label="Mehr dazu" aria-pressed={deepened} disabled={deepened} onClick={onMore}>＋ Mehr dazu</button>
    </div>}
    {track?.timelineId && rated === 'dislike' && <div className="now-reasons" role="group" aria-label="Warum weniger?">
      <span>{reason ? 'Danke, gemerkt.' : 'Warum? (optional)'}</span>
      {REASON_IDS.map(id => <button key={id} type="button" aria-pressed={reason === id} onClick={() => onReason(id)}>{FEEDBACK_REASONS[id].label}</button>)}
    </div>}
    {state.error && <p role="alert" className="now-error">{state.error}</p>}
  </section>;
}
