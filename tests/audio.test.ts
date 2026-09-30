import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinSpeech, normalizeSpeech, speechLevel, withBed } from '../server/audio.ts';
import { pcmToWav } from '../server/providers.ts';

/** A quiet 440 Hz tone framed by a second of silence on both sides, as 16-bit mono PCM at 24 kHz. */
function quietTone(amplitude: number, seconds = 1) {
  const rate = 24_000, silence = rate, tone = rate * seconds;
  const pcm = new Uint8Array((silence * 2 + tone) * 2);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < tone; i++) view.setInt16((silence + i) * 2, Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * amplitude * 32767), true);
  return pcmToWav(pcm, rate);
}

test('speech is brought to one level, silent edges are trimmed, peaks stay below full scale', () => {
  const quiet = quietTone(0.02), loud = quietTone(0.9);
  const a = normalizeSpeech(quiet), b = normalizeSpeech(loud);
  const levelA = speechLevel(a)!, levelB = speechLevel(b)!;
  assert.ok(Math.abs(levelA - -19) < 1.5, `quiet speech at ${levelA} dBFS`);
  assert.ok(Math.abs(levelA - levelB) < 2, `levels ${levelA} and ${levelB}`);
  // Three seconds in, a bit more than one second of tone plus short pads (0.25 s each) out.
  const seconds = (a.length - 44) / 2 / 24_000;
  assert.ok(seconds > 1.4 && seconds < 1.6, `${seconds} s after trimming`);
  const view = new DataView(b.buffer, 44);
  let peak = 0;
  for (let i = 0; i < (b.length - 44) / 2; i++) peak = Math.max(peak, Math.abs(view.getInt16(i * 2, true)));
  assert.ok(peak < 32767);
  assert.equal(new TextDecoder().decode(a.subarray(0, 4)), 'RIFF');
});

test('audio that is not 16-bit PCM WAV passes unchanged', () => {
  const mp3 = new Uint8Array([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]);
  assert.equal(normalizeSpeech(mp3), mp3);
  const silent = pcmToWav(new Uint8Array(48_000), 24_000);
  assert.equal(normalizeSpeech(silent), silent);
});

test('a short moderation gets a soft bed that starts before the voice and fades out after it; long speech stays dry', () => {
  const speech = normalizeSpeech(quietTone(0.3, 2));
  const bedded = withBed(speech);
  const seconds = (bytes: Uint8Array) => (bytes.length - 44) / 2 / 24_000;
  assert.ok(Math.abs(seconds(bedded) - seconds(speech) - 2.2) < 0.01, `${seconds(bedded)} s with bed`);
  // The voice keeps its level; the lead-in alone is quiet but audible, well below the speech.
  const voice = pcmToWav(bedded.slice(44 + 2 * 24_000, 44 + 2 * 48_000)), dry = pcmToWav(speech.slice(44 + 2 * 9_600, 44 + 2 * 33_600));
  assert.ok(Math.abs(speechLevel(voice)! - speechLevel(dry)!) < 0.5);
  const lead = pcmToWav(bedded.slice(44 + 2 * 2_400, 44 + 2 * 12_000));
  const leadLevel = speechLevel(lead)!;
  assert.ok(leadLevel < -30 && leadLevel > -44, `bed at ${leadLevel} dBFS`);
  const long = normalizeSpeech(quietTone(0.3, 80));
  assert.equal(withBed(long), long);
  const mp3 = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]);
  assert.equal(withBed(mp3), mp3);
});

test('a soft onset before the voice is kept, only true silence is cut', () => {
  const rate = 24_000, pcm = new Uint8Array(rate * 3 * 2), view = new DataView(pcm.buffer);
  // One second of silence, half a second of a soft «h» (about -52 dBFS), then a second of voice.
  for (let i = 0; i < rate / 2; i++) view.setInt16((rate + i) * 2, Math.round(Math.sin(i / 3) * 0.0035 * 32767), true);
  for (let i = 0; i < rate; i++) view.setInt16((rate * 1.5 + i) * 2, Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 0.3 * 32767), true);
  const out = normalizeSpeech(pcmToWav(pcm, rate));
  const seconds = (out.length - 44) / 2 / rate;
  assert.ok(seconds > 1.6, `${seconds} s: the soft onset stays`);
});

test('dialog turns from separate calls are joined at one level, without clicks, at one sample rate', () => {
  // A loud turn that starts and ends mid-wave (no silence: a hard cut would click) at 16 kHz, then a quiet one at 24 kHz.
  const hard = (amplitude: number, rate: number) => {
    const pcm = new Uint8Array(rate * 2), view = new DataView(pcm.buffer);
    for (let i = 0; i < rate; i++) view.setInt16(i * 2, Math.round(Math.cos(2 * Math.PI * 220 * i / rate) * amplitude * 32767), true);
    return pcmToWav(pcm, rate);
  };
  const joined = joinSpeech([hard(0.9, 16_000), quietTone(0.03)], 0.35);
  const view = new DataView(joined.buffer, joined.byteOffset);
  assert.equal(view.getUint32(24, true), 16_000);
  const samples = (joined.length - 44) / 2, at = (i: number) => view.getInt16(44 + i * 2, true);
  // The first turn fades in and out instead of starting and stopping at full swing.
  assert.ok(Math.abs(at(0)) < 200, `starts at ${at(0)}`);
  const firstEnd = 16_000 - 1;
  assert.ok(Math.abs(at(firstEnd)) < 200, `first turn ends at ${at(firstEnd)}`);
  // Both turns at about the same level.
  const level = (from: number, to: number) => {
    let squares = 0, count = 0;
    for (let i = from; i < to; i++) { const x = at(i) / 32768; if (Math.abs(x) > 0.003) { squares += x * x; count++; } }
    return 20 * Math.log10(Math.sqrt(squares / count));
  };
  const a = level(0, 16_000), b = level(16_000 + 5600, samples);
  assert.ok(Math.abs(a - b) < 3, `turn levels ${a} and ${b} dBFS`);
});
