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

/** Four rising notes and a soft chord, about two seconds. */
export function identJingle(): Uint8Array {
  const out = new Float32Array(Math.round(2.2 * RATE));
  [392, 523.25, 659.25, 783.99].forEach((frequency, index) => note(out, index * 0.16, frequency, 1.6, 0.5, 0.45));
  [523.25, 659.25, 783.99, 1046.5].forEach(frequency => note(out, 0.7, frequency, 1.5, 0.28, 0.7));
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
