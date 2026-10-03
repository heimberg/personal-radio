import { ProviderError } from '../providers.ts';
import { json } from '../http.ts';
import type { Environment } from '../http.ts';
import { listeningFor } from '../services.ts';

/** Connecting the owner's Spotify listening profile (authorization code flow; the secret stays in the Worker). */
export async function listeningRoutes(request: Request, env: Environment, owner: string, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/spotify/')) return null;
  const listening = listeningFor(env);
  if (!listening) return json({ error: 'spotify_not_configured' }, 404);
  const redirectUri = `${url.origin}/api/spotify/callback`;
  if (url.pathname === '/api/spotify/profile' && request.method === 'GET') return json(await listening.status(owner), 200);
  if (url.pathname === '/api/spotify/connect' && request.method === 'GET') {
    // The state is kept on the server for the authenticated owner: the app opens Spotify's login in the
    // system browser, which does not share the app's cookies, so a state cookie would never come back.
    const state = await listening.beginConnect(owner, new Date());
    return new Response(null, { status: 302, headers: { Location: listening.authorizeUrl(redirectUri, state), 'Cache-Control': 'no-store' } });
  }
  if (url.pathname === '/api/spotify/callback' && request.method === 'GET') {
    const done = (result: string, status?: number) => new Response(null, { status: 302, headers: {
      Location: `${url.origin}/?spotify=${result}${status ? `&status=${status}` : ''}`, 'Cache-Control': 'no-store',
    } });
    const code = url.searchParams.get('code'), state = url.searchParams.get('state');
    const known = state ? await listening.takeState(owner, state, new Date()) : false;
    if (url.searchParams.get('error')) return done('verweigert');
    if (!code || !known) return done('abgelaufen');
    try { await listening.connect(owner, code, redirectUri, new Date()); return done('verbunden'); }
    catch (error) { return done('fehler', error instanceof ProviderError ? error.status : undefined); }
  }
  if (url.pathname === '/api/spotify/disconnect' && request.method === 'POST') {
    if (request.headers.get('Origin') !== url.origin) return json({ error: 'origin_rejected' }, 403);
    await listening.disconnect(owner);
    return json({ connected: false }, 200);
  }
  return json({ error: 'not_found' }, 404);
}

const SPOTIFY_RESULTS: Record<string, string> = {
  verbunden: 'Spotify ist verbunden. Die Songauswahl kennt jetzt deine meistgehörten Künstler.',
  verweigert: 'Die Verbindung mit Spotify wurde abgebrochen.',
  abgelaufen: 'Die Anmeldung ist abgelaufen. Starte sie in der App noch einmal.',
  fehler: 'Spotify hat die Anmeldung nicht bestätigt. Prüfe im Spotify-Dashboard Client-ID, Secret und Redirect-URI.',
};

/**
 * There is no web interface: everything is set in the app. The root says so, and after Spotify's login
 * (which runs in the browser) it shows how it went, so the owner can return to the app.
 */
export function landingPage(url: URL): Response {
  const result = SPOTIFY_RESULTS[url.searchParams.get('spotify') ?? ''];
  const status = url.searchParams.get('status');
  const message = result ? `${result}${status ? ` (Status ${status.replace(/[^0-9]/g, '').slice(0, 3)})` : ''} Du kannst zur App zurückkehren.`
    : 'Dein Radio läuft auf diesem Server. Hören und einstellen kannst du es in der App.';
  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Personal Radio</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F3F4F0;color:#16171B;font:17px/1.5 system-ui,sans-serif}
main{max-width:30rem;padding:24px}h1{font:900 40px/1 system-ui,sans-serif;text-transform:uppercase;letter-spacing:-0.5px;margin:0 0 12px}</style></head>
<body><main><h1>Personal Radio</h1><p>${message}</p></main></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
