import type { Track } from './player.ts';

// Low-volume synthesized test audio; no copyrighted music or external requests.
function wave(frequency: number): Blob {
  const rate = 16000, seconds = 30, samples = rate * seconds;
  const bytes = new ArrayBuffer(44 + samples * 2), view = new DataView(bytes);
  const label = (offset: number, text: string) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  label(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); label(8, 'WAVE'); label(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); label(36, 'data'); view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) {
    const t = i / rate, fade = Math.min(1, t * 4, (seconds - t) * 4);
    const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI);
    view.setInt16(44 + i * 2, Math.sin(2 * Math.PI * frequency * t) * 1400 * fade * pulse, true);
  }
  return new Blob([bytes], { type: 'audio/wav' });
}
export function demoTracks(): Track[] {
  return [220, 330, 440, 275].map((frequency, index) => ({
    id: `demo-${index}`, title: `Testsequenz ${index + 1}`, kind: 'Testton · 30 Sekunden',
    url: URL.createObjectURL(wave(frequency)),
  }));
}
