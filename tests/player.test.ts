import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RadioPlayer } from '../src/audio/player.ts';
import type { AudioPort } from '../src/audio/player.ts';

class FakeAudio extends EventTarget implements AudioPort {
  src = ''; currentTime = 0; duration = 30; paused = true;
  fail = false; pending: Promise<void> | undefined;
  load() { this.currentTime = 0; }
  removeAttribute() { this.src = ''; }
  pause() { this.paused = true; }
  async play() { if (this.fail) throw new Error('NotAllowedError'); this.paused = false; await this.pending; }
}
function setup() {
  const audio = new FakeAudio(), player = new RadioPlayer(audio);
  player.setTracks([0, 1].map(id => ({ id: String(id), title: `Track ${id}`, kind: 'test', url: `blob:${id}` })));
  return { audio, player };
}
test('ended advances to next track and counts only completed segments', async () => {
  const { audio, player } = setup(); await player.start(); audio.dispatchEvent(new Event('ended'));
  assert.equal(player.state.index, 1); assert.equal(player.state.completed, 1);
});
test('repeat off ends at queue boundary', async () => {
  const { audio, player } = setup(); player.repeat(false); await player.start(1);
  audio.dispatchEvent(new Event('ended')); assert.equal(player.state.status, 'ended');
});
test('repeat wraps to beginning', async () => {
  const { audio, player } = setup(); await player.start(1); audio.dispatchEvent(new Event('ended'));
  assert.equal(player.state.index, 0);
});
test('blocked autoplay becomes a recoverable error', async () => {
  const { audio, player } = setup(); audio.fail = true; await player.start();
  assert.equal(player.state.status, 'error'); audio.fail = false; await player.start();
  assert.equal(player.state.status, 'playing');
});
test('pause wins against a delayed play promise', async () => {
  const { audio, player } = setup(); let resolve!: () => void;
  audio.pending = new Promise<void>(r => { resolve = r; });
  const start = player.start(); player.pause(); resolve(); await start;
  assert.equal(player.state.status, 'paused');
});
test('late playing event cannot undo explicit pause', async () => {
  const { audio, player } = setup(); await player.start(); player.pause();
  audio.dispatchEvent(new Event('playing')); assert.equal(player.state.status, 'paused'); assert.equal(audio.paused, true);
});
test('switch queue stops and resets session counters', async () => {
  const { audio, player } = setup(); await player.start(); audio.dispatchEvent(new Event('ended'));
  player.setTracks([]); assert.equal(player.state.completed, 0); assert.equal(audio.paused, true);
  await player.next(); assert.equal(player.state.status, 'idle');
});
test('seek clamps both boundaries and ignores NaN', () => {
  const { audio, player } = setup(); player.seek(500); assert.equal(audio.currentTime, 30);
  player.seek(-5); assert.equal(audio.currentTime, 0); player.seek(NaN); assert.equal(audio.currentTime, 0);
});
test('pause and resume retain position', async () => {
  const { audio, player } = setup(); await player.start(); player.seek(12); player.pause(); await player.start();
  assert.equal(audio.currentTime, 12);
});
