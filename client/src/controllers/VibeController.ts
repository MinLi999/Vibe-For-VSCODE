/**
 * Controller layer: the only layer that touches M/V/S simultaneously (02-STANDARDS §2).
 * Responsibilities: command/hotkey orchestration, recording state transitions, auth lifecycle
 * (SecretStorage), timeout auto-stop, error fallback (all user-facing actionable copy is assembled here).
 */
import * as vscode from 'vscode';

import { AudioState } from '../models/AudioState';
import { VocabularyModel } from '../models/VocabularyModel';
import { StatusBarViewer } from '../viewer/StatusBarViewer';
import { TextInserter, TextInsertionError, type InsertTarget } from '../viewer/TextInserter';
import { EditorContextViewer } from '../viewer/EditorContextViewer';
import { AudioRecorderService, FfmpegNotFoundError, RecorderStartError } from '../services/AudioRecorderService';
import { ApiError, CloudflareApiService } from '../services/CloudflareApiService';
import { WorkspaceContextService } from '../services/WorkspaceContextService';

const SECRET_KEY = 'vibe.licenseKey';

interface VibeConfig {
  endpoint: string;
  language: string;
  maxRecordSeconds: number;
  insertTarget: InsertTarget;
  ffmpegPath: string;
  audioDevice: string;
  contextHint: boolean;
  vadEnabled: boolean;
  vadSilenceMs: number;
  vadMinDurationMs: number;
}

export class VibeController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private autoStopTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly audioState: AudioState,
    private readonly vocabulary: VocabularyModel,
    private readonly statusBar: StatusBarViewer,
    private readonly inserter: TextInserter,
    private readonly editorContext: EditorContextViewer,
    private readonly recorder: AudioRecorderService,
    private readonly api: CloudflareApiService,
    private readonly workspaceContext: WorkspaceContextService,
  ) {
    // The keybinding's `when: vibe.recording` (Esc to cancel) depends on this context.
    this.disposables.push(
      this.audioState.onPhaseChange((phase) => {
        void vscode.commands.executeCommand('setContext', 'vibe.recording', phase === 'recording');
      }),
    );
  }

  registerCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.commands.registerCommand('vibe.toggleRecording', () => this.toggle()),
      vscode.commands.registerCommand('vibe.cancelRecording', () => this.cancel()),
      vscode.commands.registerCommand('vibe.setLicenseKey', () => this.promptForLicenseKey()),
      vscode.commands.registerCommand('vibe.clearLicenseKey', () => this.clearLicenseKey()),
    );
  }

  // ── Command entry points ──────────────────────────────────

  private async toggle(): Promise<void> {
    switch (this.audioState.currentPhase) {
      case 'idle':
        await this.startRecording();
        return;
      case 'recording':
        await this.stopAndTranscribe();
        return;
      case 'processing':
        void vscode.window.setStatusBarMessage('Vibe:正在转写上一段,请稍候', 2000);
        return;
    }
  }

  private async cancel(): Promise<void> {
    if (!this.audioState.isRecording) {
      return;
    }
    this.clearAutoStop();
    await this.recorder.cancel();
    this.audioState.reset();
    this.statusBar.showIdle();
  }

  // ── Recording flow ────────────────────────────────────────

  private async startRecording(): Promise<void> {
    const config = this.readConfig();

    // Preflight checks: endpoint, license key, ffmpeg — all must be ready before entering the recording state.
    if (config.endpoint === '') {
      const pick = await vscode.window.showErrorMessage(
        'Vibe:尚未配置转写服务地址(vibe.endpoint)',
        '打开设置',
      );
      if (pick === '打开设置') {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'vibe.endpoint');
      }
      return;
    }

    const licenseKey = await this.ensureLicenseKey();
    if (licenseKey === undefined) {
      return; // User cancelled the input.
    }

    try {
      await this.recorder.ensureFfmpeg(config.ffmpegPath);
    } catch (err) {
      if (err instanceof FfmpegNotFoundError) {
        await this.offerFfmpegInstall(err.installCommand);
        return;
      }
      throw err;
    }

    this.audioState.beginRecording();
    this.statusBar.showRecording(() => this.audioState.elapsedSeconds, config.maxRecordSeconds);

    try {
      await this.recorder.start(
        {
          ffmpegPath: config.ffmpegPath,
          audioDevice: config.audioDevice,
          maxSeconds: config.maxRecordSeconds,
          vadEnabled: config.vadEnabled,
          vadSilenceMs: config.vadSilenceMs,
          vadMinDurationMs: config.vadMinDurationMs,
          onSegment: config.vadEnabled ? (segmentMp3) => void this.handleVadSegment(segmentMp3) : undefined,
        },
        (chunk) => this.audioState.appendChunk(chunk),
        (error) => {
          // Mid-recording failure (e.g. device unplugged): reset and notify.
          this.clearAutoStop();
          this.audioState.reset();
          this.statusBar.flashResult('error', '录音中断');
          void vscode.window.showErrorMessage(`Vibe:${error.message}`);
        },
      );
    } catch (err) {
      this.audioState.reset();
      this.statusBar.showIdle();
      const message = err instanceof RecorderStartError ? err.message : String(err);
      void vscode.window.showErrorMessage(
        `Vibe:录音启动失败 —— ${message}${process.platform === 'darwin' ? '(macOS:系统设置 → 隐私与安全性 → 麦克风,允许 VS Code)' : ''}`,
      );
      return;
    }

    this.autoStopTimer = setTimeout(() => {
      void this.stopAndTranscribe();
    }, config.maxRecordSeconds * 1000);
  }

  private async stopAndTranscribe(): Promise<void> {
    if (!this.audioState.isRecording) {
      return;
    }
    this.clearAutoStop();

    // Wait for ffmpeg to exit and flush trailing chunks (or return the final VAD MP3 segment)
    const finalMp3 = await this.recorder.stop();
    this.audioState.beginProcessing();
    this.statusBar.showProcessing();

    try {
      const config = this.readConfig();
      const licenseKey = await this.secrets.get(SECRET_KEY);
      if (licenseKey === undefined) {
        throw new ApiError('unauthorized', 'License key 已被清除,请重新设置');
      }

      let audioBase64 = '';
      if (config.vadEnabled && finalMp3 !== null) {
        audioBase64 = finalMp3.toString('base64');
      } else {
        if (!this.audioState.hasAudio()) {
          // In VAD mode, it is normal that the final segment is empty if silence split occurred right before stop.
          if (config.vadEnabled) {
            this.audioState.reset();
            this.statusBar.showIdle();
            return;
          }
          throw new RecorderStartError('没有录到音频(检查输入设备)');
        }
        audioBase64 = this.audioState.toBase64();
      }

      const keywords = config.contextHint ? await this.collectKeywords() : [];
      const result = await this.api.transcribe(config.endpoint, licenseKey, {
        audio: audioBase64,
        language: config.language,
        keywords,
      });

      const outcome = await this.inserter.insert(result.text, config.insertTarget);
      this.audioState.completeWithText(result.text);
      this.statusBar.flashResult('ok', `已插入 ${result.text.length} 字`);
      if (outcome.via === 'clipboard' || outcome.via === 'chat') {
        void vscode.window.showInformationMessage('Vibe:转写结果已复制到剪贴板,如果聊天框未自动填入,可直接粘贴(⌘V / Ctrl+V)');
      }
    } catch (err) {
      this.audioState.reset();
      this.statusBar.flashResult('error', '转写失败');
      await this.reportTranscribeError(err);
    }
  }

  private async handleVadSegment(segmentMp3: Buffer): Promise<void> {
    const config = this.readConfig();
    const licenseKey = await this.secrets.get(SECRET_KEY);
    if (licenseKey === undefined) {
      return;
    }

    try {
      const keywords = config.contextHint ? await this.collectKeywords() : [];
      const result = await this.api.transcribe(config.endpoint, licenseKey, {
        audio: segmentMp3.toString('base64'),
        language: config.language,
        keywords,
      });

      await this.inserter.insert(result.text, config.insertTarget);
    } catch {
      // Ignore background transcription slice errors to prevent interrupting recording flow
    }
  }

  /**
   * One-click ffmpeg install guidance: runs the platform install command in the
   * integrated terminal so the user never has to look up or copy commands.
   */
  private async offerFfmpegInstall(installCommand: string): Promise<void> {
    const pick = await vscode.window.showErrorMessage(
      'Vibe:未找到 ffmpeg(录音依赖,仅需安装一次)',
      '一键安装',
      '手动指定路径',
    );
    if (pick === '一键安装') {
      const terminal = vscode.window.createTerminal('Vibe:安装 ffmpeg');
      terminal.show();
      terminal.sendText(installCommand, true);
      void vscode.window.showInformationMessage(
        `Vibe:正在终端执行「${installCommand}」,完成后再按 Ctrl+Shift+Space 即可录音`,
      );
    } else if (pick === '手动指定路径') {
      void vscode.commands.executeCommand('workbench.action.openSettings', 'vibe.ffmpegPath');
    }
  }

  /** Viewer takes a text snapshot → Model extracts keywords. */
  private async collectKeywords(): Promise<string[]> {
    const snapshot = await this.editorContext.snapshot();
    const workspaceKeywords = this.workspaceContext.getWorkspaceKeywords();
    return this.vocabulary.extractKeywords(snapshot, workspaceKeywords);
  }

  // ── Auth lifecycle ────────────────────────────────────────

  /** Returns the key directly if present; otherwise prompts for input. Returns undefined if the user cancels. */
  private async ensureLicenseKey(): Promise<string | undefined> {
    const existing = await this.secrets.get(SECRET_KEY);
    if (existing !== undefined) {
      return existing;
    }
    return this.promptForLicenseKey();
  }

  private async promptForLicenseKey(): Promise<string | undefined> {
    const input = await vscode.window.showInputBox({
      title: 'Vibe License Key',
      prompt: '输入授权密钥(仅存于 VS Code SecretStorage,不进设置文件)',
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim().length < 8 ? '密钥长度至少 8 位' : undefined),
    });
    if (input === undefined) {
      return undefined;
    }
    const trimmed = input.trim();
    await this.secrets.store(SECRET_KEY, trimmed);
    void vscode.window.showInformationMessage('Vibe:License key 已保存');
    return trimmed;
  }

  private async clearLicenseKey(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
    void vscode.window.showInformationMessage('Vibe:License key 已清除');
  }

  // ── Error fallback ────────────────────────────────────────

  private async reportTranscribeError(err: unknown): Promise<void> {
    if (err instanceof ApiError) {
      switch (err.kind) {
        case 'unauthorized': {
          const pick = await vscode.window.showErrorMessage(`Vibe:授权失败 —— ${err.message}`, '重新设置密钥');
          if (pick === '重新设置密钥') {
            await this.secrets.delete(SECRET_KEY);
            await this.promptForLicenseKey();
          }
          return;
        }
        case 'payload-too-large':
          void vscode.window.showErrorMessage('Vibe:录音过长被服务端拒收,请缩短后重试(或调低 vibe.maxRecordSeconds)');
          return;
        case 'timeout':
        case 'network':
          void vscode.window.showErrorMessage(`Vibe:${err.message},检查网络与 vibe.endpoint`);
          return;
        case 'server':
          void vscode.window.showErrorMessage(`Vibe:转写服务出错 —— ${err.message}`);
          return;
      }
    }
    if (err instanceof TextInsertionError || err instanceof RecorderStartError) {
      void vscode.window.showErrorMessage(`Vibe:${err.message}`);
      return;
    }
    void vscode.window.showErrorMessage(`Vibe:未知错误 —— ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Misc ───────────────────────────────────────────────────

  private readConfig(): VibeConfig {
    const cfg = vscode.workspace.getConfiguration('vibe');
    return {
      endpoint: cfg.get<string>('endpoint', '').trim(),
      language: cfg.get<string>('language', 'zh'),
      maxRecordSeconds: cfg.get<number>('maxRecordSeconds', 25),
      insertTarget: cfg.get<InsertTarget>('insertTarget', 'auto'),
      ffmpegPath: cfg.get<string>('ffmpegPath', '').trim(),
      audioDevice: cfg.get<string>('audioDevice', '').trim(),
      contextHint: cfg.get<boolean>('contextHint', true),
      vadEnabled: cfg.get<boolean>('vadEnabled', true),
      vadSilenceMs: cfg.get<number>('vadSilenceMs', 1200),
      vadMinDurationMs: cfg.get<number>('vadMinDurationMs', 3000),
    };
  }

  private clearAutoStop(): void {
    if (this.autoStopTimer !== null) {
      clearTimeout(this.autoStopTimer);
      this.autoStopTimer = null;
    }
  }

  dispose(): void {
    this.clearAutoStop();
    void this.recorder.cancel();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
