// The station's sound: a short ident jingle between music and speech, and a time signal at the full
// hour. Both are synthesised here (no third-party audio, no licences); the hour announcement is spoken
// once per hour and voice by the host and kept in the bucket.

const RATE = 22_050;

function wav(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2), view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, Math.round(Math.max(-1, Math.min(1, sample)) * 32_767), true));
  return bytes;
}

/** A bell-like note: fundamental with two soft harmonics, quick attack, exponential decay. */
function note(out: Float32Array, start: number, frequency: number, length: number, gain: number, decay: number) {
  const first = Math.round(start * RATE), count = Math.min(out.length - first, Math.round(length * RATE));
  for (let i = 0; i < count; i++) {
    const t = i / RATE;
    const envelope = Math.min(1, t / 0.008) * Math.exp(-t / decay) * Math.min(1, (count - i) / (0.02 * RATE));
    const phase = 2 * Math.PI * frequency * t;
    out[first + i] += gain * envelope * (Math.sin(phase) + 0.3 * Math.sin(2 * phase) + 0.08 * Math.sin(3 * phase));
  }
}

function normalized(out: Float32Array, peak: number): Float32Array {
  const max = out.reduce((value, sample) => Math.max(value, Math.abs(sample)), 0) || 1;
  return out.map(sample => sample / max * peak);
}

/**
 * The station's jingles: one bell voice and one key family, so every variant sounds like the same station.
 * Each is a short motif landing on a soft chord, about two seconds.
 */
const IDENTS: Array<{ motif: number[]; spacing: number; chord: number[]; chordAt: number }> = [
  { motif: [392, 523.25, 659.25, 783.99], spacing: 0.16, chord: [523.25, 659.25, 783.99, 1046.5], chordAt: 0.7 },
  { motif: [783.99, 659.25, 783.99, 1046.5], spacing: 0.14, chord: [523.25, 783.99, 1046.5, 1318.5], chordAt: 0.62 },
  { motif: [659.25, 523.25], spacing: 0.3, chord: [392, 523.25, 659.25, 987.77], chordAt: 0.62 },
  { motif: [523.25, 587.33, 659.25, 783.99, 880], spacing: 0.1, chord: [440, 523.25, 659.25, 880], chordAt: 0.58 },
];
export const IDENT_VARIANTS = IDENTS.length;

export function identJingle(variant = 0): Uint8Array {
  const { motif, spacing, chord, chordAt } = IDENTS[Math.abs(Math.trunc(variant)) % IDENTS.length];
  const out = new Float32Array(Math.round(2.2 * RATE));
  motif.forEach((frequency, index) => note(out, index * spacing, frequency, 1.6, 0.5, 0.45));
  chord.forEach(frequency => note(out, chordAt, frequency, 1.5, 0.28, 0.7));
  return wav(normalized(out, 0.7));
}

/** The news opener: a ticking pulse over a rising low tone, closed by a firm chord; about 2.6 seconds. */
export function newsOpener(): Uint8Array {
  const out = new Float32Array(Math.round(2.6 * RATE));
  // The pulse: eight short ticks, the accent on every fourth.
  for (let tick = 0; tick < 8; tick++) note(out, tick * 0.13, tick % 4 === 0 ? 1318.5 : 880, 0.09, tick % 4 === 0 ? 0.35 : 0.22, 0.03);
  // The low tone swells under the ticks.
  const swell = Math.round(1.1 * RATE);
  for (let i = 0; i < swell; i++) {
    const t = i / RATE, level = 0.18 * (t / 1.1) ** 2 * Math.min(1, (swell - i) / (0.05 * RATE));
    out[i] += level * (Math.sin(2 * Math.PI * 146.83 * t) + 0.4 * Math.sin(4 * Math.PI * 146.83 * t));
  }
  [293.66, 440, 587.33, 698.46].forEach(frequency => note(out, 1.08, frequency, 1.5, 0.3, 0.5));
  return wav(normalized(out, 0.7));
}

/** The time signal: three short pips a second apart and a long one on the hour. */
export function timeSignal(): Uint8Array {
  const out = new Float32Array(Math.round(3.8 * RATE));
  const pip = (start: number, length: number) => {
    const first = Math.round(start * RATE), count = Math.round(length * RATE);
    for (let i = 0; i < count; i++) {
      const edge = Math.min(1, i / (0.005 * RATE), (count - i) / (0.005 * RATE));
      out[first + i] = 0.5 * edge * Math.sin(2 * Math.PI * 1000 * i / RATE);
    }
  };
  pip(0, 0.1); pip(1, 0.1); pip(2, 0.1); pip(3, 0.5);
  return wav(out);
}

/** What the host says at the full hour. */
export function hourText(hour: number, stationName: string): string {
  const name = stationName.trim();
  return `Es ist ${hour === 1 ? 'ein' : hour} Uhr.${name ? ` Du hörst ${name}.` : ''}`;
}

/** Bucket key of one hour announcement; it changes with the voice and the station name, so edits re-record it. */
export function hourKey(hour: number, voice: string, stationName: string): string {
  let hash = 2166136261;
  for (const char of `${voice}|${stationName}`) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619) >>> 0; }
  return `sounds/hour-${hash.toString(36)}-${hour}`;
}

/** What a voice says as a sample in the studio: the host introduces the station. */
export function previewText(hostName: string, stationName: string): string {
  const host = hostName.trim(), station = stationName.trim();
  return `Hallo, ${host ? `hier ist ${host}` : 'schön, dass du da bist'}${station ? ` auf ${station}` : ''}. So klinge ich, wenn ich dir dein Programm präsentiere.`;
}

/** Bucket key of one voice sample; it changes with everything that is heard. */
export function previewKey(voice: string, style: string, text: string): string {
  let hash = 2166136261;
  for (const char of `${voice}|${style}|${text}`) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619) >>> 0; }
  return `sounds/preview-${hash.toString(36)}`;
}
