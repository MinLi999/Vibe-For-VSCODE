/**
 * Service layer: system ffmpeg recording process — platform args, MP3 stream capture, detection and stop.
 * I/O only; no vscode.window UI calls; errors are thrown as typed Errors to the Controller (02-STANDARDS §2).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export class FfmpegNotFoundError extends Error {
  /** `installCommand` is directly runnable in the integrated terminal (one-click install). */
  constructor(public readonly installCommand: string) {
    super('ffmpeg not found');
  }
}

export class RecorderStartError extends Error {}

/** MP3 compression failure of a recorded PCM segment (surfaced to the Controller for UI). */
export class CompressionError extends Error {}

/** Internal control-flow signal only: cancel()/stop() won the race against a pending trySpawn attempt. Never surfaced to the Controller. */
class RecorderCancelledError extends Error {}

export interface RecorderOptions {
  /** Empty string = use `ffmpeg` from PATH. */
  ffmpegPath: string;
  /** Empty string = platform default input device. */
  audioDevice: string;
  /** ffmpeg-side hard duration cap (-t); the Controller's timer is the primary stop mechanism, this is a backstop. */
  maxSeconds: number;
  // VAD options
  vadEnabled?: boolean;
  vadSilenceMs?: number;
  vadMinDurationMs?: number;
  /** Floor (adaptive mode) or fixed value (adaptive off) for the silence amplitude threshold. */
  vadSilenceThreshold?: number;
  /** Noise-floor self-calibrating threshold; falls back to the fixed vadSilenceThreshold when false. */
  vadAdaptiveThreshold?: boolean;
  onSegment?: (segmentMp3: Buffer) => void;
  /** Mid-session segment failures (e.g. compression); no UI here — the Controller decides how to surface them. */
  onSegmentError?: (error: Error) => void;
}

/** Exact runnable install command per platform (executed verbatim by the one-click install terminal). */
export function ffmpegInstallCommand(): string {
  switch (os.platform()) {
    case 'darwin':
      return 'brew install ffmpeg';
    case 'win32':
      return 'winget install --id Gyan.FFmpeg -e';
    default:
      return 'sudo apt install -y ffmpeg';
  }
}

/**
 * Common absolute install locations probed after PATH lookup fails.
 * VS Code launched from the GUI (Dock/Start menu) often gets a minimal PATH that
 * lacks package-manager bin dirs (notably Homebrew's /opt/homebrew/bin), so a user
 * who *has* ffmpeg installed would otherwise see a false "not found".
 */
function commonFfmpegLocations(): string[] {
  switch (os.platform()) {
    case 'darwin':
      return [
        '/opt/homebrew/bin/ffmpeg', // Homebrew on Apple Silicon
        '/usr/local/bin/ffmpeg', // Homebrew on Intel
        '/opt/local/bin/ffmpeg', // MacPorts
      ];
    case 'win32': {
      const local = process.env['LOCALAPPDATA'];
      const profile = process.env['USERPROFILE'];
      return [
        ...(local ? [path.join(local, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe')] : []),
        'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe',
        ...(profile ? [path.join(profile, 'scoop', 'shims', 'ffmpeg.exe')] : []),
        'C:\\ffmpeg\\bin\\ffmpeg.exe',
      ];
    }
    default:
      return ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/snap/bin/ffmpeg'];
  }
}

/** Platform capture args: macOS avfoundation / Windows dshow / Linux pulse. */
function captureArgs(audioDevice: string): string[] {
  switch (os.platform()) {
    case 'darwin':
      return ['-f', 'avfoundation', '-i', audioDevice !== '' ? audioDevice : ':default'];
    case 'win32':
      return ['-f', 'dshow', '-i', audioDevice !== '' ? audioDevice : 'audio=default'];
    default:
      return ['-f', 'pulse', '-i', audioDevice !== '' ? audioDevice : 'default'];
  }
}

/** Spawns `<binary> -version` to verify the candidate actually runs. */
function probeFfmpeg(binary: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      const probe = spawn(binary, ['-version'], { stdio: 'ignore' });
      probe.once('error', () => resolve(false));
      probe.once('exit', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

/** Upper clamp for the adaptive threshold (matches the vadSilenceThreshold setting's max). */
const ADAPTIVE_THRESHOLD_MAX = 2000;
/** effectiveThreshold = clamp(noiseFloor * this factor, configured floor, max). */
const NOISE_FLOOR_FACTOR = 2.5;
/** Initial calibration window: the minimum chunk amplitude within this window seeds the noise floor. */
const CALIBRATION_WINDOW_MS = 500;

/** 16-bit PCM chunk average that maps to a full input meter (typical conversational speech). */
const LEVEL_CEILING = 2500;

/**
 * macOS's avfoundation device isn't always released the instant the previous ffmpeg process
 * exits — a new capture that starts too soon can silently record a perfectly valid, correctly
 * timed MP3 of pure digital silence while CoreAudio finishes tearing down the prior session.
 * Confirmed via server logs: a 502 "no speech" with a normal-sized (~6s) audio payload that
 * both Qwen3-ASR and Whisper independently read as empty — not a capture failure, a silent one.
 */
const AVFOUNDATION_SETTLE_MS = 400;

/**
 * Kills capture processes orphaned by a PREVIOUS extension host. We spawn ffmpeg with
 * `detached: true` (an earlier deliberate fix for IDE audio-session sample-rate locking), which
 * means a window reload / .vsix update that kills the extension host does NOT kill a running
 * ffmpeg — the orphan keeps the microphone open until its own `-t` cap expires (up to ~40s),
 * and every recording attempt in the new session fails with avfoundation
 * "Error opening input: Input/output error" until then. The pkill pattern matches our exact,
 * highly distinctive arg combination (capture input + 16kHz + pipe output) so a user's own
 * unrelated ffmpeg jobs are not touched. pkill exiting 1 just means "no match" — not an error.
 */
function reapOrphanCaptures(): Promise<void> {
  return new Promise((resolve) => {
    try {
      const reaper = spawn('pkill', ['-f', 'ffmpeg.*avfoundation.*-ar 16000.*pipe:1'], { stdio: 'ignore' });
      reaper.once('error', () => resolve());
      reaper.once('exit', () => resolve());
    } catch {
      resolve();
    }
  });
}

export class AudioRecorderService {
  private child: ChildProcessWithoutNullStreams | null = null;
  private detectedOk: string | null = null; // Caches the resolved binary path once successfully probed.
  private pcmChunks: Buffer[] = [];
  private totalPcmBytes = 0;
  private silentTimeMs = 0;
  private lastFfmpegPath = '';
  private activeVadThreshold = 350;
  private adaptiveEnabled = true;
  private noiseFloor: number | null = null;
  private observedMs = 0;
  private onSegmentError: ((error: Error) => void) | undefined;
  /** Timestamp of the last stop/cancel — used to give macOS's avfoundation device time to release. */
  private lastStoppedAtMs = 0;
  /** One-shot per session: reap orphaned capture processes left by a previous extension host. */
  private orphansCleaned = false;
  /**
   * Loudest 16-bit PCM chunk average seen this recording session (VAD path only, reset in start()).
   * Lets the Controller distinguish "mic delivered silence" (intermittent macOS avfoundation
   * capture failure → whole recording near-zero) from "real audio the ASR couldn't read".
   */
  private sessionPeakAmplitude = 0;
  /**
   * Live normalized input level (0..1), updated per PCM chunk, jumps up fast and decays slowly
   * so a status-bar meter reads like a VU meter. 0 when VAD is off (no PCM stream to measure).
   */
  private currentLevel = 0;

  /** Loudest chunk amplitude captured this session (0 when VAD is off — no PCM to measure). */
  get peakAmplitude(): number {
    return this.sessionPeakAmplitude;
  }

  /** Live input level 0..1 for a reactive mic meter (0 when VAD is off — no PCM to measure). */
  get inputLevel(): number {
    return this.currentLevel;
  }

  get isRecording(): boolean {
    return this.child !== null;
  }

  /**
   * Tiered ffmpeg resolution (02-STANDARDS §3): configured path → PATH → common
   * install locations. Only successful results are cached, so a retry right after
   * the user installs ffmpeg re-probes and succeeds.
   */
  async ensureFfmpeg(ffmpegPath: string): Promise<string> {
    if (this.detectedOk !== null) {
      // Re-resolve if the user changed the configured path since the last success.
      if (ffmpegPath === '' || this.detectedOk === ffmpegPath) {
        return this.detectedOk;
      }
    }

    const candidates =
      ffmpegPath !== ''
        ? [ffmpegPath] // Explicit config wins outright; do not silently fall back.
        : ['ffmpeg', ...commonFfmpegLocations().filter((p) => fs.existsSync(p))];

    for (const candidate of candidates) {
      if (await probeFfmpeg(candidate)) {
        this.detectedOk = candidate;
        return candidate;
      }
    }
    throw new FfmpegNotFoundError(ffmpegInstallCommand());
  }

  /**
   * Starts recording: MP3 / 16kHz / mono / ~32kbps streamed to stdout (or raw PCM if VAD is enabled).
   * Calls onChunk per data chunk; calls onError on abnormal exit.
   */
  async start(
    options: RecorderOptions,
    onChunk: (chunk: Buffer) => void,
    onError: (error: Error) => void,
  ): Promise<void> {
    if (this.child !== null) {
      throw new RecorderStartError('recorder already running');
    }
    if (os.platform() === 'darwin' && !this.orphansCleaned) {
      // First recording of this session: a previous extension host (window reload / .vsix
      // update) may have left a detached ffmpeg holding the microphone — reap it first.
      this.orphansCleaned = true;
      await reapOrphanCaptures();
    }
    if (os.platform() === 'darwin' && this.lastStoppedAtMs > 0) {
      const sinceStop = Date.now() - this.lastStoppedAtMs;
      if (sinceStop < AVFOUNDATION_SETTLE_MS) {
        await new Promise((resolve) => setTimeout(resolve, AVFOUNDATION_SETTLE_MS - sinceStop));
      }
    }
    const binary = await this.ensureFfmpeg(options.ffmpegPath);
    this.lastFfmpegPath = binary;
    this.pcmChunks = [];
    this.totalPcmBytes = 0;
    this.silentTimeMs = 0;
    this.activeVadThreshold = options.vadSilenceThreshold ?? 350;
    this.adaptiveEnabled = options.vadAdaptiveThreshold ?? true;
    this.noiseFloor = null;
    this.observedMs = 0;
    this.sessionPeakAmplitude = 0;
    this.currentLevel = 0;
    this.onSegmentError = options.onSegmentError;

    const isVad = Boolean(options.vadEnabled && options.onSegment);

    const args = isVad
      ? [
          '-hide_banner',
          '-loglevel', 'error',
          ...captureArgs(options.audioDevice),
          // Generous backstop margin: the Controller's own JS timer is the primary stop
          // mechanism and fires at exactly maxSeconds — a tight +2s buffer here risked ffmpeg's
          // own internal -t enforcement racing (and sometimes losing badly, e.g. an abnormal
          // exit) against our controlled stop() path if the event loop was even briefly busy.
          '-t', String(options.maxSeconds + 15),
          '-ac', '1',
          '-ar', '16000',
          '-f', 's16le',
          'pipe:1',
        ]
      : [
          '-hide_banner',
          '-loglevel', 'error',
          ...captureArgs(options.audioDevice),
          // Generous backstop margin: the Controller's own JS timer is the primary stop
          // mechanism and fires at exactly maxSeconds — a tight +2s buffer here risked ffmpeg's
          // own internal -t enforcement racing (and sometimes losing badly, e.g. an abnormal
          // exit) against our controlled stop() path if the event loop was even briefly busy.
          '-t', String(options.maxSeconds + 15),
          '-ac', '1',
          '-ar', '16000',
          '-b:a', '64k',
          '-f', 'mp3',
          'pipe:1',
        ];

    // avfoundation can take noticeably longer than a blind timeout to fail opening a device
    // that isn't released yet ("audio format is not supported" / "Input/output error") — seen
    // in the wild well past 300ms. Confirm success on the first real stdout data instead of a
    // fixed clock, and retry once on failure: this is exactly the "wait a bit, then it works"
    // pattern users hit, now handled transparently instead of making them retry manually.
    const MAX_ATTEMPTS = 2;
    const RETRY_DELAY_MS = 700;
    let lastError: RecorderStartError | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await this.trySpawn(binary, args, isVad, options, onChunk, onError);
        return;
      } catch (err) {
        if (err instanceof RecorderCancelledError) {
          return; // cancel()/stop() raced the startup attempt — not a failure, don't retry.
        }
        lastError = err instanceof RecorderStartError ? err : new RecorderStartError(String(err));
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        }
      }
    }
    throw lastError ?? new RecorderStartError('ffmpeg failed to start for an unknown reason');
  }

  /**
   * Spawns ffmpeg and races the first stdout chunk (device opened — capture data flows
   * continuously once open, even for silence) against an exit/error event and a 4s hung-open
   * deadline. `this.child` is set synchronously so cancel()/stop() can act on the in-flight
   * process during this race. Resolves on confirmed success (permanent onChunk/onError
   * listeners stay wired for the rest of the session); rejects on failure/hang so the caller
   * can retry; rejects with RecorderCancelledError if cancel()/stop() won the race instead.
   */
  private trySpawn(
    binary: string,
    args: string[],
    isVad: boolean,
    options: RecorderOptions,
    onChunk: (chunk: Buffer) => void,
    onError: (error: Error) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true, windowsHide: true });
      this.child = child;
      let stderrTail = '';
      let confirmed = false;

      const confirmTimer = setTimeout(() => {
        // Once capture actually starts, ffmpeg emits stream bytes continuously EVEN FOR PURE
        // SILENCE (PCM/MP3 of zeros is still data) — so "no data by now" is not a quiet room,
        // it's a hung device open. Fail this attempt so the caller's retry gets a fresh shot;
        // an earlier version resolved here as "probably fine" and let slow (>1.5s) device-open
        // failures slip past the retry entirely.
        this.child = null;
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        reject(new RecorderStartError('ffmpeg produced no audio data within 4s (device open appears hung)'));
      }, 4000);

      child.stderr.on('data', (data: Buffer) => {
        stderrTail = (stderrTail + data.toString()).slice(-500);
      });
      child.stdout.on('data', (chunk: Buffer) => {
        if (!confirmed) {
          confirmed = true;
          clearTimeout(confirmTimer);
          resolve();
        }
        if (isVad) {
          this.processPcmChunk(chunk, options, onChunk);
        } else {
          onChunk(chunk);
        }
      });

      child.once('error', (err) => {
        const wasStopping = this.child === null;
        this.child = null;
        clearTimeout(confirmTimer);
        if (wasStopping) {
          reject(new RecorderCancelledError());
        } else if (!confirmed) {
          reject(new RecorderStartError(`ffmpeg failed to start: ${err.message}`));
        } else {
          onError(new RecorderStartError(`ffmpeg failed to start: ${err.message}`));
        }
      });
      child.once('exit', (code, signal) => {
        const wasStopping = this.child === null; // Already nulled by stop()/cancel() = deliberate.
        this.child = null;
        clearTimeout(confirmTimer);
        if (wasStopping) {
          if (!confirmed) {
            reject(new RecorderCancelledError());
          }
          return;
        }
        // A deliberate stop (SIGTERM/q) or hitting -t (code 0/255) both count as normal.
        if (code === 0 || code === 255 || signal !== null) {
          return;
        }
        const message = `ffmpeg exited abnormally (code ${code}): ${stderrTail.trim() || 'no stderr output'}`;
        if (!confirmed) {
          reject(new RecorderStartError(message));
        } else {
          onError(new RecorderStartError(message));
        }
      });
    });
  }

  /**
   * Stops recording and waits for the process to exit.
   * If VAD was active, returns the remaining trailing PCM buffer compressed to MP3.
   */
  async stop(): Promise<Buffer | null> {
    const child = this.child;
    if (child === null) {
      return null;
    }
    this.child = null; // Null it first so the exit handler recognizes this as a deliberate stop.

    const remainingPcm = this.pcmChunks.length > 0 ? Buffer.concat(this.pcmChunks) : null;
    this.pcmChunks = [];
    this.totalPcmBytes = 0;

    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 2000);
      child.once('close', () => {
        clearTimeout(killTimer);
        resolve();
      });
      try {
        child.stdin.write('q'); // ffmpeg's graceful-quit key; writes the full MP3 trailer frame.
        child.stdin.end();
      } catch {
        /* stdin may already be closed. */
      }
      child.kill('SIGTERM');
    });
    this.lastStoppedAtMs = Date.now();

    // Send any trailing PCM ≥200ms to the ASR — even quiet audio may hold real final words
    // (amplitude-based discarding here used to eat softly-spoken endings); silence is the
    // ASR's call, and the Controller silently skips empty transcriptions.
    if (remainingPcm && remainingPcm.byteLength > 3200 * 2) {
      try {
        // Killing ffmpeg can cut the stream mid-sample; trim to the s16le sample grid.
        const aligned = remainingPcm.byteLength % 2 === 0 ? remainingPcm : remainingPcm.slice(0, remainingPcm.byteLength - 1);
        const mp3 = await this.compressToMp3(aligned, this.lastFfmpegPath);
        return mp3;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.onSegmentError?.(new CompressionError(`压缩音频失败(Stop): ${msg}`));
        return null;
      }
    }
    return null;
  }

  /** Cancel: kill immediately, don't care about trailing data. */
  async cancel(): Promise<void> {
    const child = this.child;
    if (child === null) {
      return;
    }
    this.child = null;
    this.pcmChunks = [];
    this.totalPcmBytes = 0;
    child.kill('SIGKILL');
    this.lastStoppedAtMs = Date.now();
  }

  private processPcmChunk(
    chunk: Buffer,
    options: RecorderOptions,
    onChunk: (chunk: Buffer) => void,
  ): void {
    this.pcmChunks.push(chunk);
    this.totalPcmBytes += chunk.byteLength;

    // Calculate volume average for the chunk
    let sum = 0;
    const numSamples = Math.floor(chunk.byteLength / 2);
    if (numSamples > 0) {
      for (let i = 0; i < numSamples * 2; i += 2) {
        sum += Math.abs(chunk.readInt16LE(i));
      }
      const average = sum / numSamples;
      const durationMs = chunk.byteLength / 32;
      this.sessionPeakAmplitude = Math.max(this.sessionPeakAmplitude, average);
      // Normalize to 0..1 against a typical-speech ceiling; fast attack, slow release (VU feel).
      const normalized = Math.min(1, average / LEVEL_CEILING);
      this.currentLevel = Math.max(normalized, this.currentLevel * 0.65);

      const silenceThreshold = this.updateAdaptiveThreshold(average, durationMs);
      if (average < silenceThreshold) {
        this.silentTimeMs += durationMs;
      } else {
        this.silentTimeMs = 0;
      }

      const vadSilenceMs = options.vadSilenceMs ?? 1200;
      const vadMinDurationMs = options.vadMinDurationMs ?? 3000;

      if (this.silentTimeMs >= vadSilenceMs) {
        // CRITICAL: the split offset MUST land on the 2-byte s16le sample grid. silentTimeMs is a
        // float accumulation, so silentTimeMs*32 can be fractional/odd; slicing the stream at an
        // odd byte offset byte-swaps EVERY subsequent sample (violent metallic-grinding noise) and,
        // because the trailing buffer seeds the next segment, corrupts the whole rest of the session.
        const silenceBytes = Math.min(this.totalPcmBytes, Math.floor((this.silentTimeMs * 32) / 2) * 2);
        const segmentLength = Math.max(0, Math.floor((this.totalPcmBytes - silenceBytes) / 2) * 2);

        if (segmentLength >= vadMinDurationMs * 32) {
          const allPcm = Buffer.concat(this.pcmChunks);
          const segmentPcm = allPcm.slice(0, segmentLength);
          const trailingPcm = allPcm.slice(segmentLength);

          this.pcmChunks = [trailingPcm];
          this.totalPcmBytes = trailingPcm.byteLength;
          this.silentTimeMs = 0; // reset silence timer for next segment

          if (options.onSegment) {
            void this.compressAndEmit(segmentPcm, options.onSegment);
          }
        }
      }
    }
  }

  /**
   * Noise-floor tracking silence threshold: quiet mics under-trigger and loud rooms
   * over-trigger a fixed threshold, so the floor is seeded from the first 500ms minimum
   * and then tracks fast-down / slow-up (floor = min(chunkAvg, floor * 1.02)).
   * The configured vadSilenceThreshold acts as the lower clamp.
   */
  private updateAdaptiveThreshold(chunkAverage: number, durationMs: number): number {
    if (!this.adaptiveEnabled) {
      return this.activeVadThreshold;
    }
    this.observedMs += durationMs;
    if (this.noiseFloor === null || this.observedMs <= CALIBRATION_WINDOW_MS) {
      this.noiseFloor = this.noiseFloor === null ? chunkAverage : Math.min(this.noiseFloor, chunkAverage);
    } else {
      this.noiseFloor = Math.min(chunkAverage, this.noiseFloor * 1.02);
    }
    return Math.min(Math.max(this.noiseFloor * NOISE_FLOOR_FACTOR, this.activeVadThreshold), ADAPTIVE_THRESHOLD_MAX);
  }

  /**
   * Cross-platform microphone sample for the diagnose command: records `seconds` of PCM
   * via the same platform capture args as real recording and reports the average amplitude.
   */
  async captureSample(ffmpegPath: string, audioDevice: string, seconds: number): Promise<{ averageAmplitude: number }> {
    const binary = await this.ensureFfmpeg(ffmpegPath);
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-nostdin',
      ...captureArgs(audioDevice),
      '-t', String(seconds),
      '-ac', '1',
      '-ar', '16000',
      '-f', 's16le',
      'pipe:1',
    ];

    const proc = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = [];
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    await new Promise<void>((resolve, reject) => {
      proc.on('close', (code) => {
        if (code !== 0 && code !== 255) {
          reject(new RecorderStartError(stderr.trim() || `exit code ${code}`));
        } else {
          resolve();
        }
      });
      proc.on('error', (err) => reject(err));
    });

    const buffer = Buffer.concat(chunks);
    if (buffer.length === 0) {
      throw new RecorderStartError('未捕获到任何音频数据');
    }
    let sum = 0;
    const numSamples = Math.floor(buffer.length / 2);
    for (let i = 0; i < numSamples * 2; i += 2) {
      sum += Math.abs(buffer.readInt16LE(i));
    }
    return { averageAmplitude: Math.round(sum / numSamples) };
  }

  private async compressAndEmit(pcm: Buffer, onSegment: (mp3: Buffer) => void): Promise<void> {
    try {
      const mp3 = await this.compressToMp3(pcm, this.lastFfmpegPath);
      onSegment(mp3);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.onSegmentError?.(new CompressionError(`压缩分段失败(VAD): ${msg}`));
    }
  }

  private async compressToMp3(pcmBuffer: Buffer, ffmpegPath: string): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const binary = ffmpegPath !== '' ? ffmpegPath : 'ffmpeg';
      const args = [
        '-hide_banner',
        '-loglevel', 'error',
        '-f', 's16le',
        '-ar', '16000',
        '-ac', '1',
        '-i', 'pipe:0',
        '-b:a', '64k',
        '-f', 'mp3',
        'pipe:1',
      ];
      const compressor = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const mp3Chunks: Buffer[] = [];
      let stderr = '';

      compressor.stdout.on('data', (chunk: Buffer) => {
        mp3Chunks.push(chunk);
      });
      compressor.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      compressor.once('error', (err) => {
        reject(new Error(`Failed to start compression: ${err.message}`));
      });

      compressor.once('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Compression failed (code ${code}): ${stderr}`));
        } else {
          resolve(Buffer.concat(mp3Chunks));
        }
      });

      compressor.stdin.write(pcmBuffer);
      compressor.stdin.end();
    });
  }
}
