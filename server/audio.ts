// Loudness for spoken audio: every segment at the same level, silence at the edges trimmed, peaks kept
// below full scale. Works on 16-bit PCM WAV (the Gemini voices); anything else passes unchanged.

/** Speech level to aim for, as RMS of the voiced parts in dBFS (roughly −16 LUFS for speech). */
const TARGET_DB = -19;
/** Frames quieter than this count as silence for the level. */
const SILENCE_DB = -45;
/** At the edges only true silence is cut: soft onsets (a breath, an «s», an «h») are quieter than speech. */
const EDGE_DB = -60;
const FRAME_MS = 20;
/** Silence kept before and after the voice, so words are not clipped. */
const PAD_MS = 250;
const MIN_GAIN = 0.1, MAX_GAIN = 8;

interface Wav { channels: number; sampleRate: number; samples: Int16Array; fmt: Uint8Array }

function readWav(bytes: Uint8Array): Wav | null {
  if (bytes.length < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let offset = 12, fmt: Uint8Array | null = null, data: Uint8Array | null = null;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset), size = view.getUint32(offset + 4, true), start = offset + 8;
    const end = Math.min(start + size, bytes.length);
    if (id === 'fmt ') fmt = bytes.subarray(start, end);
    if (id === 'data') data = bytes.subarray(start, end);
    offset = start + size + (size % 2);
  }
  if (!fmt || !data || fmt.length < 16) return null;
  const format = new DataView(fmt.buffer, fmt.byteOffset, fmt.byteLength);
  if (format.getUint16(0, true) !== 1 || format.getUint16(14, true) !== 16) return null;
  const channels = format.getUint16(2, true), sampleRate = format.getUint32(4, true);
  if (channels < 1 || sampleRate < 8000) return null;
  const samples = new Int16Array(Math.floor(data.length / 2));
  const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < samples.length; i++) samples[i] = dataView.getInt16(i * 2, true);
  return { channels, sampleRate, samples, fmt: fmt.slice(0, 16) };
}

function writeWav(wav: Wav, samples: Int16Array): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(out.buffer);
  const text = (offset: number, value: string) => [...value].forEach((char, i) => { out[offset + i] = char.charCodeAt(0); });
  text(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); out.set(wav.fmt, 20);
  text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);
  return out;
}

const db = (value: number) => 20 * Math.log10(Math.max(value, 1e-9));

/** Brings a 16-bit PCM WAV to the target speech level and trims silent edges; other audio is returned as is. */
export function normalizeSpeech(bytes: Uint8Array): Uint8Array {
  const wav = readWav(bytes);
  if (!wav || !wav.samples.length) return bytes;
  const { samples, channels, sampleRate } = wav;
  const frame = Math.max(1, Math.round(sampleRate * FRAME_MS / 1000)) * channels;
  const frames = Math.ceil(samples.length / frame);
  const levels: number[] = [];
  let voicedSquares = 0, voicedCount = 0;
  for (let f = 0; f < frames; f++) {
    let squares = 0;
    const start = f * frame, end = Math.min(start + frame, samples.length);
    for (let i = start; i < end; i++) squares += (samples[i] / 32768) ** 2;
    const level = db(Math.sqrt(squares / Math.max(1, end - start)));
    levels.push(level);
    if (level > SILENCE_DB) { voicedSquares += squares; voicedCount += end - start; }
  }
  if (!voicedCount) return bytes;
  // Trim silence at the edges, keeping a short pad.
  const pad = Math.ceil(PAD_MS / FRAME_MS);
  const first = Math.max(0, levels.findIndex(level => level > EDGE_DB) - pad);
  let last = levels.length - 1;
  while (last > 0 && levels[last] <= EDGE_DB) last--;
  last = Math.min(levels.length - 1, last + pad);
  const trimmed = samples.subarray(first * frame, Math.min(samples.length, (last + 1) * frame));

  const gain = Math.min(MAX_GAIN, Math.max(MIN_GAIN, 10 ** ((TARGET_DB - db(Math.sqrt(voicedSquares / voicedCount))) / 20)));
  const out = new Int16Array(trimmed.length);
  for (let i = 0; i < trimmed.length; i++) {
    let x = trimmed[i] / 32768 * gain;
    // Soft limiter above −2 dBFS: peaks bend instead of clipping.
    const knee = 0.8, magnitude = Math.abs(x);
    if (magnitude > knee) x = Math.sign(x) * (knee + (1 - knee) * Math.tanh((magnitude - knee) / (1 - knee)));
    out[i] = Math.max(-32768, Math.min(32767, Math.round(x * 32767)));
  }
  return writeWav(wav, out);
}

/** RMS of the voiced part in dBFS, for tests and diagnostics. */
export function speechLevel(bytes: Uint8Array): number | null {
  const wav = readWav(bytes);
  if (!wav) return null;
  let squares = 0, count = 0;
  const frame = Math.round(wav.sampleRate * FRAME_MS / 1000) * wav.channels;
  for (let start = 0; start < wav.samples.length; start += frame) {
    let s = 0;
    const end = Math.min(start + frame, wav.samples.length);
    for (let i = start; i < end; i++) s += (wav.samples[i] / 32768) ** 2;
    if (db(Math.sqrt(s / Math.max(1, end - start))) > SILENCE_DB) { squares += s; count += end - start; }
  }
  return count ? db(Math.sqrt(squares / count)) : null;
}

/** The bed sits this far below the speech level; only short moderations get one. */
const BED_DB = TARGET_DB - 15;
const BED_MAX_SECONDS = 75;
const BED_LEAD = 0.6, BED_TAIL = 1.6;
/** A warm, open chord (F major seventh); each voice slowly breathes and is gently detuned. */
const BED_CHORD = [174.61, 220, 261.63, 329.63];
const SINE_SIZE = 8192, SINE_MASK = SINE_SIZE - 1;
const SINE = Float32Array.from({ length: SINE_SIZE }, (_, index) => Math.sin(2 * Math.PI * index / SINE_SIZE));

/**
 * Lays a soft synthesised pad under a spoken 16-bit PCM WAV: it starts a moment before the voice and
 * fades out after it. Longer speech, and anything that is not such a WAV, is returned unchanged.
 */
export function withBed(bytes: Uint8Array): Uint8Array {
  const wav = readWav(bytes);
  if (!wav || !wav.samples.length) return bytes;
  const { samples, channels, sampleRate } = wav;
  const frames = Math.floor(samples.length / channels);
  if (frames / sampleRate > BED_MAX_SECONDS) return bytes;
  const lead = Math.round(BED_LEAD * sampleRate), tail = Math.round(BED_TAIL * sampleRate), total = lead + frames + tail;
  const bed = new Float32Array(total);
  // Oscillators read a sine table with phase accumulators: a minute of pad costs a few milliseconds.
  const step = (frequency: number) => frequency / sampleRate * SINE_SIZE;
  BED_CHORD.forEach((frequency, voice) => {
    const oscillators = [step(frequency), step(frequency + 0.6), step(2 * frequency)], gains = [0.5, 0.5, 0.075];
    const phases = [0, voice * 311, voice * 97];
    const breath = step(0.07 + voice * 0.023);
    let breathPhase = voice * 1.7 / (2 * Math.PI) * SINE_SIZE;
    for (let i = 0; i < total; i++) {
      let value = 0;
      for (let o = 0; o < 3; o++) { value += gains[o] * SINE[phases[o] & SINE_MASK]; phases[o] += oscillators[o]; }
      bed[i] += (0.65 + 0.35 * SINE[breathPhase & SINE_MASK]) * value;
      breathPhase += breath;
    }
  });
  let squares = 0;
  for (let i = 0; i < total; i++) squares += bed[i] ** 2;
  const scale = 10 ** (BED_DB / 20) / Math.sqrt(squares / total || 1);
  const out = new Int16Array(total * channels);
  for (let i = 0; i < total; i++) {
    const fade = Math.min(1, i / lead, (total - i) / tail);
    const pad = bed[i] * scale * fade * fade;
    for (let c = 0; c < channels; c++) {
      const index = i - lead, voice = index >= 0 && index < frames ? samples[index * channels + c] / 32768 : 0;
      let x = voice + pad;
      const knee = 0.8, magnitude = Math.abs(x);
      if (magnitude > knee) x = Math.sign(x) * (knee + (1 - knee) * Math.tanh((magnitude - knee) / (1 - knee)));
      out[i * channels + c] = Math.max(-32768, Math.min(32767, Math.round(x * 32767)));
    }
  }
  return writeWav(wav, out);
}
