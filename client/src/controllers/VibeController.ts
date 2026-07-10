/**
 * Controller layer: the only layer that touches M/V/S simultaneously (02-STANDARDS §2).
 * Responsibilities: command/hotkey orchestration, recording state transitions, auth lifecycle
 * (SecretStorage), timeout auto-stop, error fallback (all user-facing actionable copy is assembled here).
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { AudioState } from '../models/AudioState';
import { VocabularyModel } from '../models/VocabularyModel';
import { StatusBarViewer } from '../viewer/StatusBarViewer';
import { TextInserter, TextInsertionError, type InsertTarget } from '../viewer/TextInserter';
import { EditorContextViewer } from '../viewer/EditorContextViewer';
import { AudioRecorderService, FfmpegNotFoundError, RecorderStartError } from '../services/AudioRecorderService';
import { ApiError, CloudflareApiService } from '../services/CloudflareApiService';
import { WorkspaceContextService } from '../services/WorkspaceContextService';

export function getActiveKeybinding(): string {
  const defaultKey = 'Ctrl+Shift+Space';
  try {
    let appDir = 'Code';
    const appName = vscode.env.appName.toLowerCase();
    if (appName.includes('cursor')) {
      appDir = 'Cursor';
    } else if (appName.includes('insiders')) {
      appDir = 'Code - Insiders';
    } else if (appName.includes('codium')) {
      appDir = 'VSCodium';
    }

    let userFolder = '';
    const home = os.homedir();
    if (process.platform === 'darwin') {
      userFolder = path.join(home, 'Library', 'Application Support', appDir, 'User');
    } else if (process.platform === 'win32') {
      const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
      userFolder = path.join(appdata, appDir, 'User');
    } else {
      userFolder = path.join(home, '.config', appDir, 'User');
    }

    const keybindingsPath = path.join(userFolder, 'keybindings.json');
    if (!fs.existsSync(keybindingsPath)) {
      return defaultKey;
    }

    const content = fs.readFileSync(keybindingsPath, 'utf8');
    const cleanContent = content.replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, '$1');
    const bindings = JSON.parse(cleanContent);
    if (Array.isArray(bindings)) {
      const match = bindings.find(b => b.command === 'vibefox.toggleRecording');
      if (match && typeof match.key === 'string') {
        return match.key.split('+').map(part => part.trim().charAt(0).toUpperCase() + part.trim().slice(1)).join('+');
      }
    }
  } catch (err) {
    // Silently fall back to default
  }
  return defaultKey;
}

const SECRET_KEY = 'vibefox.licenseKey';

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
  apiProvider: string;
  customEndpoint: string;
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
    // The keybinding's `when: vibefox.recording` (Esc to cancel) depends on this context.
    this.disposables.push(
      this.audioState.onPhaseChange((phase) => {
        void vscode.commands.executeCommand('setContext', 'vibefox.recording', phase === 'recording');
      }),
    );
  }

  registerCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.commands.registerCommand('vibefox.toggleRecording', () => this.toggle()),
      vscode.commands.registerCommand('vibefox.cancelRecording', () => this.cancel()),
      vscode.commands.registerCommand('vibefox.setLicenseKey', () => this.promptForLicenseKey()),
      vscode.commands.registerCommand('vibefox.clearLicenseKey', () => this.clearLicenseKey()),
      vscode.commands.registerCommand('vibefox.setApiKey', () => this.promptForApiKey()),
      vscode.commands.registerCommand('vibefox.clearApiKey', () => this.clearApiKey()),
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
        void vscode.window.setStatusBarMessage('VibeFox:正在转写上一段,请稍候', 2000);
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
    if (config.apiProvider === 'cloudflare') {
      if (config.endpoint === '') {
        const pick = await vscode.window.showErrorMessage(
          'VibeFox:尚未配置转写服务地址(vibefox.endpoint)',
          '打开设置',
        );
        if (pick === '打开设置') {
          void vscode.commands.executeCommand('workbench.action.openSettings', 'vibefox.endpoint');
        }
        return;
      }

      const licenseKey = await this.ensureLicenseKey();
      if (licenseKey === undefined) {
        return; // User cancelled the input.
      }
    } else if (config.apiProvider === 'groq') {
      const apiKey = await this.secrets.get('vibefox.groqKey');
      if (apiKey === undefined) {
        await this.promptForApiKey();
        const verifiedKey = await this.secrets.get('vibefox.groqKey');
        if (verifiedKey === undefined) {
          return;
        }
      }
    } else if (config.apiProvider === 'openai') {
      const apiKey = await this.secrets.get('vibefox.openaiKey');
      if (apiKey === undefined) {
        await this.promptForApiKey();
        const verifiedKey = await this.secrets.get('vibefox.openaiKey');
        if (verifiedKey === undefined) {
          return;
        }
      }
    } else if (config.apiProvider === 'aliyun') {
      const apiKey = await this.secrets.get('vibefox.aliyunKey');
      if (apiKey === undefined) {
        await this.promptForApiKey();
        const verifiedKey = await this.secrets.get('vibefox.aliyunKey');
        if (verifiedKey === undefined) {
          return;
        }
      }
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
          void vscode.window.showErrorMessage(`VibeFox:${error.message}`);
        },
      );
    } catch (err) {
      this.audioState.reset();
      this.statusBar.showIdle();
      const message = err instanceof RecorderStartError ? err.message : String(err);
      void vscode.window.showErrorMessage(
        `VibeFox:录音启动失败 —— ${message}${process.platform === 'darwin' ? '(macOS:系统设置 → 隐私与安全性 → 麦克风,允许 VS Code)' : ''}`,
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
      const text = await this.transcribeWithProvider(config, audioBase64, keywords);

      const outcome = await this.inserter.insert(text, config.insertTarget);
      this.audioState.completeWithText(text);
      this.statusBar.flashResult('ok', `已插入 ${text.length} 字`);
      if (outcome.via === 'clipboard' || outcome.via === 'chat') {
        void vscode.window.showInformationMessage('VibeFox:转写结果已复制到剪贴板,如果聊天框未自动填入,可直接粘贴(⌘V / Ctrl+V)');
      }
    } catch (err) {
      this.audioState.reset();
      
      const config = this.readConfig();
      if (config.vadEnabled) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (
          errMsg.includes('no text') ||
          errMsg.includes('silent') ||
          errMsg.includes('empty') ||
          errMsg.includes('502')
        ) {
          this.statusBar.showIdle();
          return;
        }
      }

      this.statusBar.flashResult('error', '转写失败');
      await this.reportTranscribeError(err);
    }
  }

  private async handleVadSegment(segmentMp3: Buffer): Promise<void> {
    const config = this.readConfig();
    try {
      const keywords = config.contextHint ? await this.collectKeywords() : [];
      const text = await this.transcribeWithProvider(config, segmentMp3.toString('base64'), keywords);
      void vscode.window.showInformationMessage(`VibeFox 识别成功: [${text}]`);
      await this.inserter.insert(text, config.insertTarget);
    } catch (err) {
      console.error('[VibeFox VAD Segment ASR Error]', err);
      void vscode.window.showErrorMessage(`VibeFox 语音转写错误: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async transcribeWithProvider(
    config: VibeConfig,
    audioBase64: string,
    keywords: string[]
  ): Promise<string> {
    const provider = config.apiProvider;
    if (provider === 'cloudflare') {
      const licenseKey = await this.secrets.get(SECRET_KEY);
      if (licenseKey === undefined) {
        throw new ApiError('unauthorized', 'License key 已被清除,请重新设置');
      }
      const result = await this.api.transcribe(config.endpoint, licenseKey, {
        audio: audioBase64,
        language: config.language,
        keywords,
      });
      return result.text;
    } else if (provider === 'groq') {
      const apiKey = await this.secrets.get('vibefox.groqKey');
      if (apiKey === undefined) {
        throw new ApiError('unauthorized', 'Groq API Key 未设置，请运行「VibeFox: Set API Key」进行设置');
      }
      return this.api.transcribeGroq(apiKey, audioBase64, config.language, keywords);
    } else if (provider === 'openai') {
      const apiKey = await this.secrets.get('vibefox.openaiKey');
      if (apiKey === undefined) {
        throw new ApiError('unauthorized', 'OpenAI API Key 未设置，请运行「VibeFox: Set API Key」进行设置');
      }
      return this.api.transcribeOpenAI(apiKey, audioBase64, config.language, keywords);
    } else if (provider === 'aliyun') {
      const apiKey = await this.secrets.get('vibefox.aliyunKey');
      if (apiKey === undefined) {
        throw new ApiError('unauthorized', '阿里云 API Key 未设置，请运行「VibeFox: Set API Key」进行设置');
      }
      return this.api.transcribeAliyun(config.endpoint, apiKey, audioBase64, config.language, keywords);
    } else if (provider === 'custom') {
      if (!config.customEndpoint) {
        throw new Error('自定义服务地址 (vibefox.customEndpoint) 未配置');
      }
      return this.api.transcribeCustom(config.customEndpoint, audioBase64, config.language, keywords);
    }
    throw new Error(`不支持的 API Provider: ${provider}`);
  }

  /**
   * One-click ffmpeg install guidance: runs the platform install command in the
   * integrated terminal so the user never has to look up or copy commands.
   */
  private async offerFfmpegInstall(installCommand: string): Promise<void> {
    const pick = await vscode.window.showErrorMessage(
      'VibeFox:未找到 ffmpeg(录音依赖,仅需安装一次)',
      '一键安装',
      '手动指定路径',
    );
    if (pick === '一键安装') {
      const terminal = vscode.window.createTerminal('VibeFox:安装 ffmpeg');
      terminal.show();
      terminal.sendText(installCommand, true);
      void vscode.window.showInformationMessage(
        `VibeFox:正在终端执行「${installCommand}」,完成后再按 ${getActiveKeybinding()} 即可录音`,
      );
    } else if (pick === '手动指定路径') {
      void vscode.commands.executeCommand('workbench.action.openSettings', 'vibefox.ffmpegPath');
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
      title: 'VibeFox License Key',
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
    void vscode.window.showInformationMessage('VibeFox:License key 已保存');
    return trimmed;
  }

  private async clearLicenseKey(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
    void vscode.window.showInformationMessage('VibeFox:License key 已清除');
  }

  private async promptForApiKey(): Promise<void> {
    const config = this.readConfig();
    const provider = config.apiProvider;
    if (provider !== 'groq' && provider !== 'openai' && provider !== 'aliyun') {
      void vscode.window.showWarningMessage(`当前 API Provider 为「${provider}」，无需配置 API Key`);
      return;
    }

    const secretKeyName =
      provider === 'groq'
        ? 'vibefox.groqKey'
        : provider === 'openai'
        ? 'vibefox.openaiKey'
        : 'vibefox.aliyunKey';

    const providerTitle =
      provider === 'groq' ? 'Groq' : provider === 'openai' ? 'OpenAI' : '阿里云 DashScope';

    const input = await vscode.window.showInputBox({
      title: `VibeFox Set ${providerTitle} API Key`,
      prompt: `输入 ${providerTitle} API 密钥(仅存于 SecretStorage,不进设置文件)`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim().length === 0 ? '密钥不能为空' : undefined),
    });

    if (input === undefined) {
      return;
    }
    const trimmed = input.trim();
    await this.secrets.store(secretKeyName, trimmed);
    void vscode.window.showInformationMessage(`VibeFox:${providerTitle} API Key 已保存`);
  }

  private async clearApiKey(): Promise<void> {
    const config = this.readConfig();
    const provider = config.apiProvider;
    if (provider !== 'groq' && provider !== 'openai' && provider !== 'aliyun') {
      return;
    }

    const secretKeyName =
      provider === 'groq'
        ? 'vibefox.groqKey'
        : provider === 'openai'
        ? 'vibefox.openaiKey'
        : 'vibefox.aliyunKey';

    const providerTitle =
      provider === 'groq' ? 'Groq' : provider === 'openai' ? 'OpenAI' : '阿里云 DashScope';

    await this.secrets.delete(secretKeyName);
    void vscode.window.showInformationMessage(`VibeFox:${providerTitle} API Key 已清除`);
  }

  // ── Error fallback ────────────────────────────────────────

  private async reportTranscribeError(err: unknown): Promise<void> {
    if (err instanceof ApiError) {
      switch (err.kind) {
        case 'unauthorized': {
          const pick = await vscode.window.showErrorMessage(`VibeFox:授权失败 —— ${err.message}`, '重新设置密钥');
          if (pick === '重新设置密钥') {
            await this.secrets.delete(SECRET_KEY);
            await this.promptForLicenseKey();
          }
          return;
        }
        case 'payload-too-large':
          void vscode.window.showErrorMessage('VibeFox:录音过长被服务端拒收,请缩短后重试(或调低 vibefox.maxRecordSeconds)');
          return;
        case 'timeout':
        case 'network':
          void vscode.window.showErrorMessage(`VibeFox:${err.message},检查网络与 vibefox.endpoint`);
          return;
        case 'server':
          void vscode.window.showErrorMessage(`VibeFox:转写服务出错 —— ${err.message}`);
          return;
      }
    }
    if (err instanceof TextInsertionError || err instanceof RecorderStartError) {
      void vscode.window.showErrorMessage(`VibeFox:${err.message}`);
      return;
    }
    void vscode.window.showErrorMessage(`VibeFox:未知错误 —— ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Misc ───────────────────────────────────────────────────

  private readConfig(): VibeConfig {
    const cfg = vscode.workspace.getConfiguration('vibefox');
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
      apiProvider: cfg.get<string>('apiProvider', 'cloudflare'),
      customEndpoint: cfg.get<string>('customEndpoint', '').trim(),
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
