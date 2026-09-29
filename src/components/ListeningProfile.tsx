import { useEffect, useState } from 'react';
import { api, post, readJson } from '../station-client.ts';

const embeddedInApp = navigator.userAgent.includes('PersonalRadioAndroid');

interface Status { connected: boolean; artists: string[]; fetchedAt?: string }

/** The owner's Spotify listening profile: which artists shape the music picks. */
export function ListeningProfile() {
  const [status, setStatus] = useState<Status | null | 'unavailable'>(null);
  const load = async () => {
    try {
      const response = await fetch(api('api/spotify/profile'), { credentials: 'same-origin' });
      setStatus(response.ok ? await readJson<Status>(response) : 'unavailable');
    } catch { setStatus('unavailable'); }
  };
  useEffect(() => {
    void load();
    // Back from Spotify's login (in the app it runs in the system browser): show the new state.
    const refresh = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', refresh);
    return () => document.removeEventListener('visibilitychange', refresh);
  }, []);

  if (status === null || status === 'unavailable') return null;
  return <div className="listening" aria-label="Spotify-Hörprofil" role="group">
    <strong>Spotify-Hörprofil</strong>
    {status.connected ? <>
      <p className="muted">{status.artists.length
        ? `Die Songauswahl orientiert sich an dem, was du hörst: ${status.artists.slice(0, 12).join(', ')}${status.artists.length > 12 ? ' …' : ''}`
        : 'Verbunden. Deine Top-Künstler werden beim nächsten Song geladen.'}</p>
      <button type="button" className="button ghost small" onClick={() => void post('api/spotify/disconnect').then(load)}>Trennen</button>
    </> : <>
      <p className="muted">Verbinde dein Spotify-Konto, damit die Songauswahl deine meistgehörten Künstler kennt. Gelesen werden nur deine Top-Künstler und, für Musikblöcke, deine Playlists.{embeddedInApp ? ' Die Anmeldung öffnet sich im Browser; danach hierher zurückkehren.' : ''}</p>
      <a className="button small" href={api('api/spotify/connect').href}>Mit Spotify verbinden</a>
    </>}
  </div>;
}
