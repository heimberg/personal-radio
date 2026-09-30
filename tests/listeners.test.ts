import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KIDS_RULES, allOwners, forKids, isKids, parseListeners } from '../server/listeners.ts';
import { defaultStationConfig } from '../src/domain/station.ts';
import { SpotifyCatalog } from '../server/music.ts';

test('listeners: one token each, a name for the owner ID, :kids for a child; bad entries are skipped', () => {
  const listeners = parseListeners('lea-app.access=Lea:kids;\n tom.access = tom , x=, =y, bad id!=z, a.access=ok:admin, short=ab');
  assert.deepEqual([...listeners], [
    ['lea-app.access', { owner: 'listener:lea', kids: true }],
    ['tom.access', { owner: 'listener:tom', kids: false }],
    ['short', { owner: 'listener:ab', kids: false }],
  ]);
  assert.deepEqual(allOwners('Owner@Example.test', listeners), ['owner@example.test', 'listener:lea', 'listener:tom', 'listener:ab']);
  assert.deepEqual(allOwners(undefined, parseListeners(undefined)), []);
  assert.ok(isKids('listener:lea', listeners));
  assert.ok(!isKids('listener:tom', listeners) && !isKids('owner@example.test', listeners));
});

test('the station of a child: the rules lead host, shows and every agent, once', () => {
  const config = defaultStationConfig();
  const kids = forKids(config);
  assert.ok(kids.host.instructions.startsWith(KIDS_RULES));
  assert.ok(kids.shows.every(show => show.instructions.startsWith(KIDS_RULES)));
  assert.ok(Object.values(kids.agents!).every(agent => agent?.instructions?.startsWith(KIDS_RULES)));
  assert.match(kids.music.taste, /ohne explizite Texte/);
  assert.equal(forKids(kids).host.instructions, kids.host.instructions);
  assert.ok(!config.host.instructions.includes(KIDS_RULES));
});

test('a clean catalog never picks an explicit track', async () => {
  const fetcher = async (input: RequestInfo | URL) => String(input).includes('accounts.spotify.com')
    ? Response.json({ access_token: 't', expires_in: 3600 })
    : Response.json({ tracks: { items: [
      { uri: 'spotify:track:explicit1', name: 'Song', duration_ms: 1000, explicit: true, artists: [{ name: 'Band' }] },
      { uri: 'spotify:track:clean1', name: 'Song', duration_ms: 1000, explicit: false, artists: [{ name: 'Band' }] },
    ] } });
  const clean = new SpotifyCatalog({ clientId: 'i', clientSecret: 's', clean: true }, fetcher as typeof fetch);
  const normal = new SpotifyCatalog({ clientId: 'i', clientSecret: 's' }, fetcher as typeof fetch);
  assert.equal((await clean.find({ title: 'Song', artist: 'Band' }))?.uri, 'spotify:track:clean1');
  assert.equal((await normal.find({ title: 'Song', artist: 'Band' }))?.uri, 'spotify:track:explicit1');
});
