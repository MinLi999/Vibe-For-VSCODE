/**
 * Service layer: system ffmpeg recording process — platform args, MP3 stream capture, detection and stop.
 * I/O only; no vscode.window UI calls; errors are thrown as typed Errors to the Controller (02-STANDARDS §2).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as os from 'node:os';

export class FfmpegNotFoundError extends Error {
  constructor(public readonly installHint: string) {
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
}

/** Platform install hint (the Controller uses this to build an actionable error message). */
export function ffmpegInstallHint(): string {
  switch (os.platform()) {
    case 'darwin':
      return 'brew install ffmpeg';
    case 'win32':
      return 'winget install Gyan.FFmpeg(或 choco install ffmpeg)';
    default:
      return 'sudo apt install ffmpeg(或对应发行版包管理器)';
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

export class AudioRecorderService {
  private child: ChildProcessWithoutNullStreams | null = null;
  private detectedOk: string | null = null; // Caches the binary path once successfully probed.

  get isRecording(): boolean {
    return this.child !== null;
  }

  /** Probes ffmpeg availability (spawns `ffmpeg -version`), caching the result per path. */
  async ensureFfmpeg(ffmpegPath: string): Promise<string> {
    const binary = ffmpegPath !== '' ? ffmpegPath : 'ffmpeg';
    if (this.detectedOk === binary) {
      return binary;
    }
    const ok = await new Promise<boolean>((resolve) => {
      try {
        const probe = spawn(binary, ['-version'], { stdio: 'ignore' });
        probe.once('error', () => resolve(false));
        probe.once('exit', (code) => resolve(code === 0));
      } catch {
        resolve(false);
      }
    });
    if (!ok) {
      throw new FfmpegNotFoundError(ffmpegInstallHint());
    }
    this.detectedOk = binary;
    return binary;
  }

  /**
   * Starts recording: MP3 / 16kHz / mono / ~32kbps streamed to stdout.
   * Calls onChunk per data chunk (Controller forwards it into AudioState); calls onError on abnormal exit.
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

    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      ...captureArgs(options.audioDevice),
      '-t', String(options.maxSeconds + 2), // Backstop: Controller timer + ffmpeg's own duration cap.
      '-ac', '1',
      '-ar', '16000',
      '-b:a', '32k',
      '-f', 'mp3',
      'pipe:1',
    ];

    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;

    let stderrTail = '';
    child.stderr.on('data', (data: Buffer) => {
      stderrTail = (stderrTail + data.toString()).slice(-500);
    });
    child.stdout.on('data', (chunk: Buffer) => onChunk(chunk));

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
   * Stops recording and waits for the process to exit and stdout to flush (MP3 trailer written in full).
   * Graceful chain: stdin 'q' → SIGTERM → SIGKILL fallback after 2s.
   */
  async stop(): Promise<void> {
    const child = this.child;
    if (child === null) {
      return;
    }
    this.child = null; // Null it first so the exit handler recognizes this as a deliberate stop.

    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 2000);
      child.once('close', () => {
        // 'close' fires after all stdio streams close, guaranteeing trailing chunks were flushed to onChunk.
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
  }

  /** Cancel: kill immediately, don't care about trailing data. */
  async cancel(): Promise<void> {
    const child = this.child;
    if (child === null) {
      return;
    }
    this.child = null;
    child.kill('SIGKILL');
  }
}
