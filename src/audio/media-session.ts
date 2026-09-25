import type { RadioPlayer } from './player.ts';

export function connectMediaSession(player: RadioPlayer) {
  if (!('mediaSession' in navigator)) return;
  const actions: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
    play: () => { void player.start(); }, pause: () => player.pause(),
    nexttrack: () => { void player.next(); }, previoustrack: () => { void player.previous(); },
    seekto: detail => { if (detail.seekTime !== undefined) player.seek(detail.seekTime); },
    seekbackward: detail => player.seek(player.state.position - (detail.seekOffset ?? 10)),
    seekforward: detail => player.seek(player.state.position + (detail.seekOffset ?? 10)),
    stop: () => player.pause(),
  };
  for (const [action, handler] of Object.entries(actions)) {
    try { navigator.mediaSession.setActionHandler(action as MediaSessionAction, handler!); } catch { /* Optional browser capability. */ }
  }
  let lastTitle = '';
  return player.subscribe(() => {
    const title = player.tracks[player.state.index]?.title ?? 'Personal Radio';
    if (title !== lastTitle) {
      navigator.mediaSession.metadata = new MediaMetadata({ title, artist: 'Personal Radio · Audiolabor' }); lastTitle = title;
    }
    navigator.mediaSession.playbackState = player.state.status === 'playing' ? 'playing' : 'paused';
    if (player.state.duration > 0) {
      try { navigator.mediaSession.setPositionState({ duration: player.state.duration, playbackRate: 1,
        position: Math.min(player.state.position, player.state.duration) }); } catch { /* Optional. */ }
    }
  });
}
