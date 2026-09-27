import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpotifyListening } from '../server/listening.ts';
import { sqliteD1 } from './d1-sqlite.ts';

const OWNER = 'owner@example.test';
const NOW = new Date('2026-09-27T08:00:00Z');

test('listening profile: code exchange stores the refresh token; top artists are fetched, merged and cached for 12 hours', async () => {
  const calls: string[] = [];
  let fail = false;
  const listening = new SpotifyListening(sqliteD1(), { clientId: 'id', clientSecret: 'secret' }, async (input, init) => {
    const url = String(input); calls.push(url.split('?')[0] + (url.includes('time_range') ? `?${new URL(url).searchParams.get('time_range')}` : ''));
    if (fail) return new Response('', { status: 503 });
    if (url === 'https://accounts.spotify.com/api/token') {
      assert.equal(new Headers(init?.headers).get('Authorization'), `Basic ${btoa('id:secret')}`);
      const body = new URLSearchParams(String(init?.body));
      if (body.get('grant_type') === 'authorization_code') {
        assert.equal(body.get('redirect_uri'), 'https://radio.example/api/spotify/callback');
        return Response.json({ access_token: 'a0', refresh_token: 'r1' });
      }
      assert.equal(body.get('refresh_token'), 'r1');
      return Response.json({ access_token: 'a1' });
    }
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer a1');
    return Response.json({ items: new URL(url).searchParams.get('time_range') === 'short_term'
      ? [{ name: 'Nine Inch Nails' }, { name: 'Protomartyr' }] : [{ name: 'Protomartyr' }, { name: 'Einstürzende Neubauten' }] });
  });
  assert.match(listening.authorizeUrl('https://radio.example/api/spotify/callback', 's1'), /scope=user-top-read&state=s1$/);
  assert.deepEqual(await listening.status(OWNER), { connected: false, artists: [] });
  assert.deepEqual(await listening.topArtists(OWNER, NOW), []);

  await listening.connect(OWNER, 'code', 'https://radio.example/api/spotify/callback', NOW);
  assert.deepEqual(await listening.topArtists(OWNER, NOW), ['Nine Inch Nails', 'Protomartyr', 'Einstürzende Neubauten']);
  const fetched = calls.length;
  assert.deepEqual(await listening.topArtists(OWNER, new Date(NOW.getTime() + 60 * 60_000)), ['Nine Inch Nails', 'Protomartyr', 'Einstürzende Neubauten']);
  assert.equal(calls.length, fetched); // cached
  // After 12 hours it refreshes; an outage keeps the cached list.
  fail = true;
  assert.equal((await listening.topArtists(OWNER, new Date(NOW.getTime() + 13 * 3_600_000))).length, 3);
  assert.equal((await listening.status(OWNER)).connected, true);
  await listening.disconnect(OWNER);
  assert.deepEqual(await listening.status(OWNER), { connected: false, artists: [] });
});
