/**
 * Model layer: recording lifecycle state machine + audio byte buffering + Base64 conversion.
 * Pure data and state — must not touch VS Code UI/command APIs or any I/O (02-STANDARDS §2).
 */

export type RecordingPhase = 'idle' | 'recording' | 'processing';

export type AudioStateListener = (phase: RecordingPhase) => void;

export class InvalidTransitionError extends Error {
  constructor(from: RecordingPhase, to: RecordingPhase) {
    super(`Invalid recording state transition: ${from} → ${to}`);
  }
}

const ALLOWED_TRANSITIONS: Record<RecordingPhase, readonly RecordingPhase[]> = {
  idle: ['recording'],
  recording: ['processing', 'idle'], // idle = cancelled
  processing: ['idle'],
};

export class AudioState {
  private phase: RecordingPhase = 'idle';
  private chunks: Buffer[] = [];
  private totalBytes = 0;
  private startedAtMs: number | null = null;
  private lastTranscription: string | null = null;
  private readonly listeners = new Set<AudioStateListener>();

  get currentPhase(): RecordingPhase {
    return this.phase;
  }

  get isRecording(): boolean {
    return this.phase === 'recording';
  }

  get byteLength(): number {
    return this.totalBytes;
  }

  /** Seconds since recording started (returns 0 outside the recording phase). */
  get elapsedSeconds(): number {
    if (this.startedAtMs === null) {
      return 0;
    }
    return Math.floor((Date.now() - this.startedAtMs) / 1000);
  }

  /** Milliseconds since recording started (for minimum-duration guards on quick stops). */
  get elapsedMs(): number {
    return this.startedAtMs === null ? 0 : Date.now() - this.startedAtMs;
  }

  /** Text of the most recent successful transcription (for re-insert scenarios). */
  get lastText(): string | null {
    return this.lastTranscription;
  }

  onPhaseChange(listener: AudioStateListener): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** idle → recording: clear the buffer, record the start time. */
  beginRecording(): void {
    this.transition('recording');
    this.chunks = [];
    this.totalBytes = 0;
    this.startedAtMs = Date.now();
  }

  /** MP3 chunk streamed in from the recording process. */
  appendChunk(chunk: Buffer): void {
    if (this.phase !== 'recording') {
      return; // Trailing chunk from after stop; silently discard.
    }
    this.chunks.push(chunk);
    this.totalBytes += chunk.byteLength;
  }

  /** recording → processing: seal the buffer, further appendChunk calls are no-ops. */
  beginProcessing(): void {
    this.transition('processing');
    this.startedAtMs = null;
  }

  /** Any state → idle (recording cancelled / transcription complete / error reset). */
  reset(): void {
    if (this.phase === 'idle') {
      return;
    }
    this.phase = 'idle';
    this.chunks = [];
    this.totalBytes = 0;
    this.startedAtMs = null;
    this.emit();
  }

  /** Cache the text after a successful transcription and reset. */
  completeWithText(text: string): void {
    this.lastTranscription = text;
    this.reset();
  }

  /** Buffered complete MP3 → Base64 (called during the processing phase). */
  toBase64(): string {
    return Buffer.concat(this.chunks).toString('base64');
  }

  hasAudio(): boolean {
    return this.totalBytes > 0;
  }

  private transition(to: RecordingPhase): void {
    if (!ALLOWED_TRANSITIONS[this.phase].includes(to)) {
      throw new InvalidTransitionError(this.phase, to);
    }
    this.phase = to;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(this.phase);
    }
  }
}
