export interface Track { id: string; title: string; url: string; kind: string; interests?: string[]; feedbackId?: string }
export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'buffering' | 'ended' | 'error';
export interface PlayerState {
  status: PlayerStatus; index: number; position: number; duration: number;
  completed: number; repeat: boolean; error: string;
}
export interface AudioPort extends EventTarget {
  src: string; currentTime: number; duration: number; paused: boolean;
  play(): Promise<void>; pause(): void; load(): void; removeAttribute(name: string): void;
}
export interface LogEntry { at: string; event: string; track: number; detail?: string }
export interface PlaybackSignal { action: 'skip' | 'complete'; track: Track; listenedRatio: number }

// One audio element owns playback. UI rerenders never recreate the player.
export class RadioPlayer {
  audio: AudioPort;
  tracks: Track[] = [];
  state: PlayerState = { status: 'idle', index: 0, position: 0, duration: 0, completed: 0, repeat: true, error: '' };
  logs: LogEntry[] = [];
  private listeners = new Set<() => void>();
  private signalListeners = new Set<(signal: PlaybackSignal) => void>();
  private generation = 0;
  private wantsPlayback = false;
  beforeStart?: () => void;

  constructor(audio: AudioPort) {
    this.audio = audio;
    audio.addEventListener('timeupdate', () => this.update({ position: audio.currentTime }));
    audio.addEventListener('durationchange', () => this.update({ duration: Number.isFinite(audio.duration) ? audio.duration : 0 }));
    audio.addEventListener('playing', () => {
      if (!this.wantsPlayback) { audio.pause(); return; }
      this.update({ status: 'playing', error: '' }); this.log('playing');
    });
    audio.addEventListener('pause', () => {
      if (!this.wantsPlayback && this.state.status !== 'ended') this.update({ status: 'paused' });
      else if (this.wantsPlayback && this.state.status === 'playing') {
        this.wantsPlayback = false; this.update({ status: 'paused' }); this.log('external-pause');
      }
    });
    audio.addEventListener('waiting', () => {
      if (this.wantsPlayback) { this.update({ status: 'buffering' }); this.log('buffering'); }
    });
    audio.addEventListener('ended', () => {
      const track = this.tracks[this.state.index];
      if (track) this.emitSignal({ action: 'complete', track, listenedRatio: 1 });
      this.wantsPlayback = false;
      this.update({ completed: this.state.completed + 1 }); this.log('ended');
      if (this.state.index + 1 < this.tracks.length) void this.start(this.state.index + 1);
      else if (this.state.repeat && this.tracks.length) void this.start(0);
      else this.update({ status: 'ended' });
    });
    audio.addEventListener('error', () => {
      this.wantsPlayback = false;
      this.update({ status: 'error', error: 'Audio konnte nicht geladen werden. Datei oder Verbindung prüfen.' });
      this.log('audio-error');
    });
  }
  subscribe = (callback: () => void) => { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; };
  subscribeSignals = (callback: (signal: PlaybackSignal) => void) => { this.signalListeners.add(callback); return () => { this.signalListeners.delete(callback); }; };
  private emitSignal(signal: PlaybackSignal) { this.signalListeners.forEach(fn => fn(signal)); }
  snapshot = () => this.state;
  private update(patch: Partial<PlayerState>) {
    this.state = { ...this.state, ...patch }; this.listeners.forEach(fn => fn());
  }
  log(event: string, detail?: string) {
    this.logs.push({ at: new Date().toISOString(), event, track: this.state.index + 1, ...(detail ? { detail } : {}) });
    if (this.logs.length > 2000) this.logs.shift();
  }
  setTracks(tracks: Track[]) {
    this.pause(); this.tracks = tracks;
    this.audio.removeAttribute('src'); this.audio.load();
    this.update({ index: 0, position: 0, duration: 0, completed: 0, status: 'idle', error: '' });
    this.log('queue-loaded', `${tracks.length} tracks`);
  }
  async start(index = this.state.index) {
    const track = this.tracks[index]; if (!track) return;
    this.beforeStart?.();
    const generation = ++this.generation;
    this.wantsPlayback = false; this.audio.pause();
    if (this.audio.src !== track.url) {
      this.audio.src = track.url; this.audio.load();
      this.update({ position: 0, duration: 0 });
    }
    this.update({ index, status: 'loading', error: '' });
    this.wantsPlayback = true;
    try {
      await this.audio.play();
      if (generation === this.generation && this.wantsPlayback) this.update({ status: 'playing' });
    } catch {
      if (generation !== this.generation) return;
      this.wantsPlayback = false;
      this.update({ status: 'error', error: 'Wiedergabe blockiert. Bitte erneut auf Start tippen.' });
      this.log('play-rejected');
    }
  }
  pause() { ++this.generation; this.wantsPlayback = false; this.audio.pause(); this.update({ status: 'paused' }); this.log('pause'); }
  next() {
    if (!this.tracks.length) return;
    const track = this.tracks[this.state.index];
    const ratio = this.state.duration > 0 ? Math.min(1, this.state.position / this.state.duration) : 0;
    if (track) this.emitSignal({ action: 'skip', track, listenedRatio: ratio });
    return this.start((this.state.index + 1) % this.tracks.length);
  }
  previous() { if (this.tracks.length) return this.start(Math.max(0, this.state.index - 1)); }
  repeat(value: boolean) { this.update({ repeat: value }); }
  seek(seconds: number) {
    if (!Number.isFinite(seconds) || !Number.isFinite(this.audio.duration)) return;
    this.audio.currentTime = Math.max(0, Math.min(seconds, this.audio.duration));
    this.update({ position: this.audio.currentTime });
  }
}
