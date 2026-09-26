import { useEffect, useRef, useState } from 'react';
import { beginSpotifyLogin, finishSpotifyLogin, loadSpotifySdk, parseSpotifyContext, type SpotifyPlayer, type SpotifyPlaybackState, type SpotifyTokenManager } from '../audio/spotify.ts';

export interface SpotifyControls { pause(): void; resume(): void }
interface Props { clientId: string; controlsRef?: { current: SpotifyControls | null }; onSpotifyPlay?: () => void }

export function SpotifyPanel({ clientId, controlsRef, onSpotifyPlay }: Props) {
  const tokensRef = useRef<SpotifyTokenManager | null>(null);
  const playerRef = useRef<SpotifyPlayer | null>(null);
  const [hasToken, setHasToken] = useState(false);
  const [deviceId, setDeviceId] = useState('');
  const [context, setContext] = useState('');
  const [track, setTrack] = useState('');
  const [spotifyPlaying, setSpotifyPlaying] = useState(false);
  const [status, setStatus] = useState('Mit Spotify verbinden');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void finishSpotifyLogin(clientId).then(manager => {
      if (manager && active) { tokensRef.current = manager; setHasToken(true); setStatus('Spotify verbunden · Player bereit zum Starten'); }
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Spotify-Anmeldung fehlgeschlagen.'); });
    return () => { active = false; playerRef.current?.disconnect(); playerRef.current = null; };
  }, [clientId]);

  useEffect(() => {
    if (!controlsRef) return;
    controlsRef.current = {
      pause: () => { void playerRef.current?.pause().catch(() => setError('Spotify konnte nicht pausiert werden.')); },
      resume: () => { void playerRef.current?.resume().catch(() => setError('Spotify konnte nicht fortgesetzt werden.')); },
    };
    return () => { controlsRef.current = null; };
  }, [controlsRef]);

  async function connect() {
    setError('');
    if (!tokensRef.current) { await beginSpotifyLogin(clientId); return; }
    if (playerRef.current) {
      await playerRef.current.activateElement();
      await playerRef.current.connect();
      return;
    }
    try {
      const sdk = await loadSpotifySdk();
      const manager = tokensRef.current;
      const player = new sdk.Player({ name: 'Personal Radio', volume: 0.7,
        getOAuthToken: callback => { void manager!.getAccessToken().then(callback).catch(() => setError('Spotify-Token abgelaufen. Bitte erneut verbinden.')); },
      });
      player.addListener('ready', ({ device_id }: { device_id: string }) => { setDeviceId(device_id); setStatus('Spotify-Player bereit'); });
      player.addListener('not_ready', () => { setDeviceId(''); setStatus('Spotify-Player nicht erreichbar'); });
      player.addListener('player_state_changed', (value: SpotifyPlaybackState | null) => {
        if (!value) return;
        const item = value.track_window?.current_track;
        setTrack(item ? `${item.name}${item.artists?.length ? ` · ${item.artists.map(artist => artist.name).join(', ')}` : ''}` : '');
        setSpotifyPlaying(!value.paused);
        setStatus(value.paused ? 'Spotify pausiert' : 'Spotify spielt');
      });
      for (const event of ['initialization_error', 'authentication_error', 'account_error', 'playback_error']) {
        player.addListener(event, () => setError(`Spotify-Player-Fehler (${event}). Bitte Verbindung und Premium prüfen.`));
      }
      playerRef.current = player;
      setStatus('Spotify-Player geladen · nochmals verbinden zum Starten');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Spotify-Player konnte nicht gestartet werden.'); }
  }

  async function startContext() {
    const uri = parseSpotifyContext(context);
    const player = playerRef.current;
    const manager = tokensRef.current;
    if (!uri) { setError('Bitte eine Spotify-Playlist-, Album- oder Künstler-URL bzw. URI eingeben.'); return; }
    if (!player || !deviceId || !manager) { setError('Verbinde zuerst den Spotify-Player.'); return; }
    setError(''); onSpotifyPlay?.();
    try {
      await player.activateElement();
      const token = await manager.getAccessToken();
      const response = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
        method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ context_uri: uri }),
      });
      if (!response.ok) throw new Error(response.status === 403 ? 'Spotify benötigt Premium für Wiedergabe im Webplayer.' : 'Spotify konnte diesen Kontext nicht starten.');
      setStatus('Spotify-Wiedergabe gestartet');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Spotify-Wiedergabe fehlgeschlagen.'); }
  }

  function togglePlayback() {
    if (!spotifyPlaying) onSpotifyPlay?.();
    void playerRef.current?.togglePlay();
  }

  function skipTrack(direction: 'previous' | 'next') {
    onSpotifyPlay?.();
    const player = playerRef.current;
    if (direction === 'previous') void player?.previousTrack();
    else void player?.nextTrack();
  }

  return <section className="panel settings spotify-panel" aria-label="Spotify-Musik">
    <div className="section-heading"><h2>Spotify-Musik</h2><span>Privater Player</span></div>
    <p>Verbinde dein Spotify-Premium-Konto und wähle eine Playlist, ein Album oder einen Künstler.</p>
    <button className="secondary" onClick={() => void connect()}>{hasToken ? deviceId ? 'Spotify verbunden' : 'Spotify-Player verbinden' : 'Mit Spotify verbinden'}</button>
    {hasToken && <>
      <label htmlFor="spotify-context">Spotify-Playlist, Album oder Künstler</label>
      <div className="feed-load-row"><input id="spotify-context" value={context} onChange={event => setContext(event.target.value)} placeholder="Spotify-Link oder spotify:playlist:…" /><button className="primary" onClick={() => void startContext()} disabled={!deviceId}>Start</button></div>
      <div className="controls spotify-controls">
        <button aria-label="Spotify vorheriger Titel" disabled={!deviceId} onClick={() => skipTrack('previous')}>↤</button>
        <button className="play" disabled={!deviceId} onClick={togglePlayback}>▶ / Ⅱ</button>
        <button aria-label="Spotify nächster Titel" disabled={!deviceId} onClick={() => skipTrack('next')}>↦</button>
      </div>
    </>}
    <p role="status">{track ? `${status} · ${track}` : status}</p>
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}
