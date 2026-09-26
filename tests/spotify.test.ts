import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpotifyContext, spotifyAuthorizeUrl, SPOTIFY_SCOPES } from '../src/audio/spotify.ts';

test('accepts Spotify playlist, album, and artist identifiers from official URI and URL forms', () => {
  assert.equal(parseSpotifyContext('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M'), 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M');
  assert.equal(parseSpotifyContext('https://open.spotify.com/album/6d6aB2a8F6bR3cD7e5F4gH?si=abc'), 'spotify:album:6d6aB2a8F6bR3cD7e5F4gH');
  assert.equal(parseSpotifyContext('spotify:artist:4Z8W4fKeB5YxbusRsdQVPb'), 'spotify:artist:4Z8W4fKeB5YxbusRsdQVPb');
});

test('rejects non-Spotify URLs, unsupported content, and malformed URIs', () => {
  assert.equal(parseSpotifyContext('https://example.com/playlist/abc'), null);
  assert.equal(parseSpotifyContext('https://open.spotify.com/track/abc'), null);
  assert.equal(parseSpotifyContext('spotify:playlist:bad/id'), null);
  assert.equal(parseSpotifyContext('javascript:alert(1)'), null);
});

test('authorization uses PKCE and only the playback scopes needed for this first slice', () => {
  const url = new URL(spotifyAuthorizeUrl('client-id', 'https://radio.example/', 'state-value', 'challenge-value'));
  assert.equal(url.origin, 'https://accounts.spotify.com');
  assert.equal(url.pathname, '/authorize');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'state-value');
  assert.deepEqual(url.searchParams.get('scope')?.split(' '), SPOTIFY_SCOPES);
  assert.equal(url.searchParams.get('response_type'), 'code');
});
