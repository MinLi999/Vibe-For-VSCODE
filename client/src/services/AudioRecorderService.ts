/**
 * Service layer: system ffmpeg recording process — platform args, MP3 stream capture, detection and stop.
 * I/O only; no vscode.window UI calls; errors are thrown as typed Errors to the Controller (02-STANDARDS §2).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

export class FfmpegNotFoundError extends Error {
  /** `installCommand` is directly runnable in the integrated terminal (one-click install). */
  constructor(public readonly installCommand: string) {
    super('ffmpeg not found');
  }
}

export class RecorderStartError extends Error {}

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
  vadSilenceThreshold?: number;
  onSegment?: (segmentMp3: Buffer) => void;
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

export class AudioRecorderService {
  private child: ChildProcessWithoutNullStreams | null = null;
  private detectedOk: string | null = null; // Caches the resolved binary path once successfully probed.
  private pcmChunks: Buffer[] = [];
  private totalPcmBytes = 0;
  private silentTimeMs = 0;
  private lastFfmpegPath = '';
  private activeVadThreshold = 350;

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
    const binary = await this.ensureFfmpeg(options.ffmpegPath);
    this.lastFfmpegPath = binary;
    this.pcmChunks = [];
    this.totalPcmBytes = 0;
    this.silentTimeMs = 0;
    this.activeVadThreshold = options.vadSilenceThreshold ?? 350;

    const isVad = options.vadEnabled && options.onSegment;

    const args = isVad
      ? [
          '-hide_banner',
          '-loglevel', 'error',
          ...captureArgs(options.audioDevice),
          '-t', String(options.maxSeconds + 2),
          '-ac', '1',
          '-ar', '16000',
          '-f', 's16le',
          'pipe:1',
        ]
      : [
          '-hide_banner',
          '-loglevel', 'error',
          ...captureArgs(options.audioDevice),
          '-t', String(options.maxSeconds + 2),
          '-ac', '1',
          '-ar', '16000',
          '-b:a', '64k',
          '-f', 'mp3',
          'pipe:1',
        ];

    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;

    let stderrTail = '';
    child.stderr.on('data', (data: Buffer) => {
      stderrTail = (stderrTail + data.toString()).slice(-500);
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (isVad) {
        this.processPcmChunk(chunk, options, onChunk);
      } else {
        onChunk(chunk);
      }
    });

    child.once('error', (err) => {
      this.child = null;
      onError(new RecorderStartError(`ffmpeg failed to start: ${err.message}`));
    });
    child.once('exit', (code, signal) => {
      const wasStopping = this.child === null; // Already nulled by stop() = a normal stop.
      this.child = null;
      // A deliberate stop (SIGTERM/q) or hitting -t (code 0/255) both count as normal; anything else is abnormal.
      if (!wasStopping && code !== 0 && code !== 255 && signal === null) {
        onError(new RecorderStartError(`ffmpeg exited abnormally (code ${code}): ${stderrTail.trim() || 'no stderr output'}`));
      }
    });

    // Surface immediate failures (e.g. device in use / no permission) within 300ms so start() rejects directly.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.removeListener('exit', earlyExit);
        resolve();
      }, 300);
      const earlyExit = (code: number | null): void => {
        clearTimeout(timer);
        reject(
          new RecorderStartError(
            `ffmpeg exited immediately (code ${code}): ${stderrTail.trim() || 'check microphone permission and input device'}`,
          ),
        );
      };
      child.once('exit', earlyExit);
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

    // If we have remaining PCM (longer than 200ms), check if it is loud enough to contain speech (silence threshold = 350)
    if (remainingPcm && remainingPcm.byteLength > 3200 * 2) {
      let sum = 0;
      const numSamples = Math.floor(remainingPcm.byteLength / 2);
      for (let i = 0; i < numSamples * 2; i += 2) {
        sum += Math.abs(remainingPcm.readInt16LE(i));
      }
      const average = sum / numSamples;

      // Discard silent trailing segments to avoid Whisper hallucinations on background noise/clicks
      if (average < this.activeVadThreshold) {
        return null;
      }

      try {
        const mp3 = await this.compressToMp3(remainingPcm, this.lastFfmpegPath);
        return mp3;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`VibeFox 压缩音频失败(Stop): ${msg}`);
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

      const silenceThreshold = this.activeVadThreshold;
      if (average < silenceThreshold) {
        this.silentTimeMs += durationMs;
      } else {
        this.silentTimeMs = 0;
      }

      const vadSilenceMs = options.vadSilenceMs ?? 1200;
      const vadMinDurationMs = options.vadMinDurationMs ?? 3000;

      if (this.silentTimeMs >= vadSilenceMs) {
        const silenceBytes = this.silentTimeMs * 32;
        const segmentLength = this.totalPcmBytes - silenceBytes;

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

  private async compressAndEmit(pcm: Buffer, onSegment: (mp3: Buffer) => void): Promise<void> {
    try {
      const mp3 = await this.compressToMp3(pcm, this.lastFfmpegPath);
      onSegment(mp3);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`VibeFox 压缩分段失败(VAD): ${msg}`);
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
        '-f', 'mp3',
        'pipe:1',
      ];
      const compressor = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
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
