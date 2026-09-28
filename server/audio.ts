// Loudness for spoken audio: every segment at the same level, silence at the edges trimmed, peaks kept
// below full scale. Works on 16-bit PCM WAV (the Gemini voices); anything else passes unchanged.

/** Speech level to aim for, as RMS of the voiced parts in dBFS (roughly −16 LUFS for speech). */
const TARGET_DB = -19;
/** Frames quieter than this count as silence: they neither set the level nor stay at the edges. */
const SILENCE_DB = -45;
const FRAME_MS = 20;
/** Silence kept before and after the voice, so words are not clipped. */
const PAD_MS = 120;
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
  const first = Math.max(0, levels.findIndex(level => level > SILENCE_DB) - pad);
  let last = levels.length - 1;
  while (last > 0 && levels[last] <= SILENCE_DB) last--;
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
