/** Cloudflare Access: who is asking (the owner or a listener), or why the request is refused. */
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { listenersOf } from './listeners.ts';
import type { Environment } from './http.ts';

// Reused per isolate so the Access signing keys are not fetched on every request.
const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** The owner, or why the request was refused. Reasons only name settings, never token values. */
type Auth = { owner: string } | { owner: null; reason: string };

export async function authenticate(request: Request, env: Environment): Promise<Auth> {
  const refuse = (reason: string): Auth => ({ owner: null, reason });
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.ALLOWED_EMAIL) return refuse('access_not_configured');
  if (!assertion) return refuse('no_access_token');
  try {
    const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
    let jwks = jwksByIssuer.get(issuer);
    if (!jwks) { jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)); jwksByIssuer.set(issuer, jwks); }
    const { payload } = await jwtVerify(assertion, jwks, { issuer, audience: env.ACCESS_AUD });
    if (payload.type !== 'app') return refuse('wrong_token_type');
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
    if (email) return email === env.ALLOWED_EMAIL.toLowerCase() ? { owner: email } : refuse('email_not_allowed');
    // Service tokens carry no email; Access puts the token's client ID into common_name.
    const serviceToken = typeof payload.common_name === 'string' ? payload.common_name.trim() : '';
    if (!serviceToken) return refuse('no_identity');
    if (env.ACCESS_SERVICE_TOKEN_ID?.trim() && serviceToken === env.ACCESS_SERVICE_TOKEN_ID.trim()) return { owner: env.ALLOWED_EMAIL.toLowerCase() };
    // Further listeners each have their own token, and with it their own station.
    const listener = (await listenersOf(env)).get(serviceToken);
    if (listener) return { owner: listener.owner };
    if (!env.ACCESS_SERVICE_TOKEN_ID?.trim()) return refuse('service_token_not_configured');
    return refuse('service_token_not_allowed');
  } catch { return refuse('invalid_access_token'); }
}
