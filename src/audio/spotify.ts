export const SPOTIFY_SCOPES = ['streaming', 'user-read-playback-state', 'user-modify-playback-state'];
const AUTH_KEY = 'radio.spotify.pkce.v1';

export interface SpotifyTrackState { name: string; artists?: Array<{ name: string }>; uri: string }
export interface SpotifyPlaybackState { paused: boolean; position: number; duration: number; track_window: { current_track: SpotifyTrackState } }
export interface SpotifyPlayer {
  connect(): Promise<boolean>;
  disconnect(): void;
  addListener(event: string, callback: (value: any) => void): boolean;
  togglePlay(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  nextTrack(): Promise<void>;
  previousTrack(): Promise<void>;
  activateElement(): Promise<void>;
}
export interface SpotifySdk { Player: new (options: { name: string; getOAuthToken: (callback: (token: string) => void) => void; volume?: number }) => SpotifyPlayer }
export interface SpotifyTokens { accessToken: string; refreshToken?: string; expiresAt: number }

declare global {
  interface Window { Spotify?: SpotifySdk; onSpotifyWebPlaybackSDKReady?: () => void }
}

export function spotifyRedirectUri(location: Pick<Location, 'origin' | 'pathname'> = window.location): string {
  const page = `${location.origin}${location.pathname}`;
  return new URL(import.meta.env.BASE_URL, page).href;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function parseSpotifyContext(value: string): string | null {
  const input = value.trim();
  const uri = input.match(/^spotify:(playlist|album|artist):([A-Za-z0-9]+)$/i);
  if (uri) return `spotify:${uri[1].toLowerCase()}:${uri[2]}`;
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || !['open.spotify.com', 'www.open.spotify.com'].includes(url.hostname)) return null;
    const match = url.pathname.match(/^\/(playlist|album|artist)\/([A-Za-z0-9]+)\/?$/i);
    return match ? `spotify:${match[1].toLowerCase()}:${match[2]}` : null;
  } catch { return null; }
}

export function spotifyAuthorizeUrl(clientId: string, redirectUri: string, state: string, challenge: string): string {
  const url = new URL('https://accounts.spotify.com/authorize');
  url.search = new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: redirectUri, state,
    code_challenge_method: 'S256', code_challenge: challenge, scope: SPOTIFY_SCOPES.join(' '),
  }).toString();
  return url.toString();
}

export async function beginSpotifyLogin(clientId: string): Promise<void> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(64)));
  const state = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64Url(new Uint8Array(digest));
  sessionStorage.setItem(AUTH_KEY, JSON.stringify({ verifier, state }));
  window.location.assign(spotifyAuthorizeUrl(clientId, spotifyRedirectUri(), state, challenge));
}

function cleanCallbackUrl() { window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.hash}`); }

let finishCallback: Promise<SpotifyTokenManager | null> | undefined;
export function finishSpotifyLogin(clientId: string): Promise<SpotifyTokenManager | null> {
  finishCallback ??= consumeSpotifyCallback(clientId);
  return finishCallback;
}

async function consumeSpotifyCallback(clientId: string): Promise<SpotifyTokenManager | null> {
  const query = new URLSearchParams(window.location.search);
  const code = query.get('code');
  const error = query.get('error');
  if (!code && !error) return null;
  const saved = sessionStorage.getItem(AUTH_KEY);
  sessionStorage.removeItem(AUTH_KEY);
  cleanCallbackUrl();
  if (error) throw new Error('Spotify-Anmeldung wurde abgebrochen.');
  if (!code) throw new Error('Spotify lieferte keinen Anmeldungscode. Bitte erneut verbinden.');
  let challengeState: { verifier?: string; state?: string } = {};
  try { challengeState = JSON.parse(saved ?? '{}'); } catch { /* Invalid transient auth state. */ }
  if (!challengeState.verifier || !challengeState.state || query.get('state') !== challengeState.state) {
    throw new Error('Spotify-Anmeldung konnte nicht sicher bestätigt werden. Bitte erneut verbinden.');
  }
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: spotifyRedirectUri(), client_id: clientId, code_verifier: challengeState.verifier }),
  });
  if (!response.ok) throw new Error('Spotify-Anmeldung fehlgeschlagen. Bitte erneut verbinden.');
  return new SpotifyTokenManager(clientId, await response.json() as TokenResponse);
}

interface TokenResponse { access_token?: string; refresh_token?: string; expires_in?: number }

export class SpotifyTokenManager {
  private clientId: string;
  private accessToken: string;
  private refreshToken?: string;
  private expiresAt: number;
  private refreshPromise?: Promise<void>;
  constructor(clientId: string, response: TokenResponse) {
    if (!response.access_token || !response.expires_in) throw new Error('Spotify lieferte ein ungültiges Token.');
    this.clientId = clientId; this.accessToken = response.access_token;
    this.refreshToken = response.refresh_token; this.expiresAt = Date.now() + response.expires_in * 1000;
  }
  async getAccessToken(): Promise<string> {
    if (Date.now() + 60_000 >= this.expiresAt && this.refreshToken) {
      this.refreshPromise ??= this.refresh().finally(() => { this.refreshPromise = undefined; });
      await this.refreshPromise;
    }
    if (Date.now() >= this.expiresAt) throw new Error('Spotify-Token abgelaufen. Bitte erneut verbinden.');
    return this.accessToken;
  }
  private async refresh() {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.refreshToken!, client_id: this.clientId }),
    });
    if (!response.ok) throw new Error('Spotify-Token konnte nicht erneuert werden. Bitte erneut verbinden.');
    const data = await response.json() as TokenResponse;
    if (!data.access_token || !data.expires_in) throw new Error('Spotify lieferte ein ungültiges Token.');
    this.accessToken = data.access_token; this.expiresAt = Date.now() + data.expires_in * 1000;
    if (data.refresh_token) this.refreshToken = data.refresh_token;
  }
}

export async function loadSpotifySdk(): Promise<SpotifySdk> {
  if (window.Spotify) return window.Spotify;
  await new Promise<void>((resolve, reject) => {
    const prior = window.onSpotifyWebPlaybackSDKReady;
    const timeout = window.setTimeout(() => reject(new Error('Spotify-Player konnte nicht geladen werden.')), 15_000);
    window.onSpotifyWebPlaybackSDKReady = () => { window.clearTimeout(timeout); prior?.(); resolve(); };
    let script = document.querySelector<HTMLScriptElement>('script[data-spotify-sdk]');
    if (!script) {
      script = document.createElement('script'); script.src = 'https://sdk.scdn.co/spotify-player.js';
      script.async = true; script.dataset.spotifySdk = 'true';
      script.onerror = () => { window.clearTimeout(timeout); reject(new Error('Spotify-Player konnte nicht geladen werden.')); };
      document.head.append(script);
    }
  });
  if (!window.Spotify) throw new Error('Spotify-Player ist nicht verfügbar.');
  return window.Spotify;
}
