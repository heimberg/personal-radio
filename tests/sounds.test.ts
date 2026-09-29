import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hourKey, hourText, identJingle, timeSignal } from '../server/sounds.ts';
import { SpotifyCatalog } from '../server/music.ts';

const header = (bytes: Uint8Array) => new TextDecoder().decode(bytes.slice(0, 4)) + new TextDecoder().decode(bytes.slice(8, 12));

test('the ident and the time signal are valid mono WAV files of a few seconds, never clipping', () => {
  for (const [audio, seconds] of [[identJingle(), 2.2], [timeSignal(), 3.8]] as const) {
    assert.equal(header(audio), 'RIFFWAVE');
    const view = new DataView(audio.buffer);
    assert.equal(view.getUint16(22, true), 1);
    assert.equal(view.getUint32(40, true), Math.round(seconds * 22_050) * 2);
    let peak = 0;
    for (let offset = 44; offset < audio.length; offset += 2) peak = Math.max(peak, Math.abs(view.getInt16(offset, true)));
    assert.ok(peak > 10_000 && peak < 32_767);
  }
  assert.equal(hourText(1, 'Radio Melchnau'), 'Es ist ein Uhr. Du hörst Radio Melchnau.');
  assert.equal(hourText(15, ' '), 'Es ist 15 Uhr.');
  assert.notEqual(hourKey(8, 'kerstin', 'Radio A'), hourKey(8, 'kerstin', 'Radio B'));
  assert.match(hourKey(8, 'v', 'n'), /^sounds\/hour-[a-z0-9]+-8$/);
});

test('new releases: exact artist, only dated releases since the cut-off, first track of each, newest first', async () => {
  const seen: string[] = [];
  const catalog = new SpotifyCatalog({ clientId: 'c', clientSecret: 's' }, async input => {
    const url = new URL(String(input));
    seen.push(url.pathname);
    if (url.hostname === 'accounts.spotify.com') return Response.json({ access_token: 't', expires_in: 3600 });
    if (url.pathname === '/v1/search') {
      const q = url.searchParams.get('q');
      return Response.json({ artists: { items: q === 'Björk' ? [{ id: 'A'.repeat(22), name: 'Bjork Tribute' }, { id: 'B'.repeat(22), name: 'Björk' }] : [{ id: 'C'.repeat(22), name: 'Someone Else' }] } });
    }
    if (url.pathname === `/v1/artists/${'B'.repeat(22)}/albums`) return Response.json({ items: [
      { id: '1'.repeat(22), release_date: '2026-09-20', release_date_precision: 'day' },
      { id: '2'.repeat(22), release_date: '2026-09', release_date_precision: 'month' },
      { id: '3'.repeat(22), release_date: '2026', release_date_precision: 'year' },
      { id: '4'.repeat(22), release_date: '2025-01-01', release_date_precision: 'day' },
    ] });
    const album = url.pathname.match(/^\/v1\/albums\/(\w+)\/tracks$/)?.[1];
    if (album) return Response.json({ items: [{ uri: `spotify:track:${album.slice(0, 5)}`, name: `Track ${album[0]}`, duration_ms: 1000, artists: [{ name: 'Björk' }] }] });
    throw new Error(`unexpected ${url}`);
  });
  const tracks = await catalog.newReleases(['Björk', 'Unbekannt'], new Date('2026-08-01T00:00:00Z'));
  assert.deepEqual(tracks.map(track => [track.uri, track.title, track.artist]), [['spotify:track:11111', 'Track 1', 'Björk'], ['spotify:track:22222', 'Track 2', 'Björk']]);
  assert.ok(!seen.includes(`/v1/artists/${'C'.repeat(22)}/albums`));
});
