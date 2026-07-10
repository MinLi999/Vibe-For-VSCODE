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
  const appDirs = ['Antigravity IDE', 'Cursor', 'Code', 'Code - Insiders', 'VSCodium'];

  for (const appDir of appDirs) {
    try {
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
      if (fs.existsSync(keybindingsPath)) {
        const content = fs.readFileSync(keybindingsPath, 'utf8');
        const cleanContent = content.replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, '$1');
        const bindings = JSON.parse(cleanContent);
        if (Array.isArray(bindings)) {
          const match = bindings.find((b: any) => b.command === 'vibefox.toggleRecording');
          if (match && typeof match.key === 'string') {
            return match.key.split('+').map((part: string) => part.trim().charAt(0).toUpperCase() + part.trim().slice(1)).join('+');
          }
        }
      }
    } catch (err) {
      // Continue searching in other app dirs
    }
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
  llmCorrectionEnabled: boolean;
  llmCorrectionProvider: string;
  llmCorrectionModel: string;
  llmCorrectionPrompt: string;
  llmCorrectionCustomEndpoint: string;
  developerModeEnabled: boolean;
}

export class VibeController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private autoStopTimer: ReturnType<typeof setTimeout> | null = null;
  private lastVadTranscript: string = '';

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
    this.lastVadTranscript = '';
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
      const text = await this.transcribeWithProvider(config, audioBase64, keywords, this.lastVadTranscript);

      let finalText = text;
      if (config.llmCorrectionEnabled) {
        finalText = await this.correctTextWithProvider(config, text, keywords);
      }

      if (config.developerModeEnabled) {
        finalText = this.applyDeveloperModeRules(finalText);
      }

      if (finalText.trim().length > 0) {
        this.lastVadTranscript = (this.lastVadTranscript + ' ' + finalText).trim();
      }

      const outcome = await this.inserter.insert(finalText, config.insertTarget);
      this.audioState.completeWithText(finalText);
      this.statusBar.flashResult('ok', `已插入 ${finalText.length} 字`);
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
      const text = await this.transcribeWithProvider(config, segmentMp3.toString('base64'), keywords, this.lastVadTranscript);

      let finalText = text;
      if (config.llmCorrectionEnabled) {
        finalText = await this.correctTextWithProvider(config, text, keywords);
      }

      if (config.developerModeEnabled) {
        finalText = this.applyDeveloperModeRules(finalText);
      }

      if (finalText.trim().length > 0) {
        this.lastVadTranscript = (this.lastVadTranscript + ' ' + finalText).trim();
        void vscode.window.showInformationMessage(`VibeFox 识别成功: [${finalText}]`);
        await this.inserter.insert(finalText, config.insertTarget);
      }
    } catch (err) {
      console.error('[VibeFox VAD Segment ASR Error]', err);
      void vscode.window.showErrorMessage(`VibeFox 语音转写错误: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async transcribeWithProvider(
    config: VibeConfig,
    audioBase64: string,
    keywords: string[],
    previousTranscript?: string
  ): Promise<string> {
    const provider = config.apiProvider;
    if (provider === 'cloudflare') {
      const licenseKey = await this.secrets.get(SECRET_KEY);
      if (licenseKey === undefined) {
        throw new ApiError('unauthorized', 'License key 已被清除,请重新设置');
      }
      const useLlmCorrection = config.llmCorrectionEnabled && (config.llmCorrectionProvider === 'auto' || config.llmCorrectionProvider === 'cloudflare');
      const result = await this.api.transcribe(config.endpoint, licenseKey, {
        audio: audioBase64,
        language: config.language,
        keywords,
        previousTranscript,
        llmCorrect: useLlmCorrection,
        llmPrompt: config.llmCorrectionPrompt,
        llmModel: config.llmCorrectionModel
      });
      return result.text;
    } else if (provider === 'groq') {
      const apiKey = await this.secrets.get('vibefox.groqKey');
      if (apiKey === undefined) {
        throw new ApiError('unauthorized', 'Groq API Key 未设置，请运行「VibeFox: Set API Key」进行设置');
      }
      return this.api.transcribeGroq(apiKey, audioBase64, config.language, keywords, previousTranscript);
    } else if (provider === 'openai') {
      const apiKey = await this.secrets.get('vibefox.openaiKey');
      if (apiKey === undefined) {
        throw new ApiError('unauthorized', 'OpenAI API Key 未设置，请运行「VibeFox: Set API Key」进行设置');
      }
      return this.api.transcribeOpenAI(apiKey, audioBase64, config.language, keywords, previousTranscript);
    } else if (provider === 'aliyun') {
      const apiKey = await this.secrets.get('vibefox.aliyunKey');
      if (apiKey === undefined) {
        throw new ApiError('unauthorized', '阿里云 API Key 未设置，请运行「VibeFox: Set API Key」进行设置');
      }
      return this.api.transcribeAliyun(config.endpoint, apiKey, audioBase64, config.language, keywords, previousTranscript);
    } else if (provider === 'custom') {
      if (!config.customEndpoint) {
        throw new Error('自定义服务地址 (vibefox.customEndpoint) 未配置');
      }
      return this.api.transcribeCustom(config.customEndpoint, audioBase64, config.language, keywords, previousTranscript);
    }
    throw new Error(`不支持的 API Provider: ${provider}`);
  }

  private async correctTextWithProvider(
    config: VibeConfig,
    text: string,
    keywords: string[]
  ): Promise<string> {
    const provider = config.llmCorrectionProvider === 'auto' ? config.apiProvider : config.llmCorrectionProvider;

    // If both transcription and correction use cloudflare, it was already corrected server-side, so skip.
    if (provider === 'cloudflare' && config.apiProvider === 'cloudflare') {
      return text;
    }

    if (provider === 'groq') {
      const apiKey = await this.secrets.get('vibefox.groqKey');
      if (apiKey === undefined) {
        throw new Error('Groq API Key 未设置，无法进行 LLM 后处理');
      }
      const model = config.llmCorrectionModel || 'llama-3.3-70b-versatile';
      return this.api.llmCorrectOpenAICompatible('https://api.groq.com/openai/v1', apiKey, model, text, keywords, config.llmCorrectionPrompt);
    } else if (provider === 'openai') {
      const apiKey = await this.secrets.get('vibefox.openaiKey');
      if (apiKey === undefined) {
        throw new Error('OpenAI API Key 未设置，无法进行 LLM 后处理');
      }
      const model = config.llmCorrectionModel || 'gpt-4o-mini';
      return this.api.llmCorrectOpenAICompatible('https://api.openai.com/v1', apiKey, model, text, keywords, config.llmCorrectionPrompt);
    } else if (provider === 'aliyun') {
      const apiKey = await this.secrets.get('vibefox.aliyunKey');
      if (apiKey === undefined) {
        throw new Error('阿里云 API Key 未设置，无法进行 LLM 后处理');
      }
      const model = config.llmCorrectionModel || 'qwen-turbo';
      return this.api.llmCorrectOpenAICompatible('https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey, model, text, keywords, config.llmCorrectionPrompt);
    } else if (provider === 'custom') {
      const endpoint = config.llmCorrectionCustomEndpoint || config.customEndpoint;
      if (!endpoint) {
        throw new Error('自定义 LLM 后处理端点未配置');
      }
      return this.api.llmCorrectOpenAICompatible(endpoint, '', config.llmCorrectionModel, text, keywords, config.llmCorrectionPrompt);
    }
    
    return text;
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
    const cfgFox = vscode.workspace.getConfiguration('vibefox');
    const cfgVibe = vscode.workspace.getConfiguration('vibe');

    const getWithFallback = <T>(key: string, defaultValue: T): T => {
      const inspectFox = cfgFox.inspect<T>(key);
      const hasFoxCustom = inspectFox && (
        inspectFox.globalValue !== undefined ||
        inspectFox.workspaceValue !== undefined ||
        inspectFox.workspaceFolderValue !== undefined
      );
      if (hasFoxCustom) {
        return cfgFox.get<T>(key, defaultValue);
      }
      return cfgVibe.get<T>(key, defaultValue);
    };

    return {
      endpoint: getWithFallback<string>('endpoint', '').trim(),
      language: getWithFallback<string>('language', 'zh'),
      maxRecordSeconds: getWithFallback<number>('maxRecordSeconds', 25),
      insertTarget: getWithFallback<InsertTarget>('insertTarget', 'auto'),
      ffmpegPath: getWithFallback<string>('ffmpegPath', '').trim(),
      audioDevice: getWithFallback<string>('audioDevice', '').trim(),
      contextHint: getWithFallback<boolean>('contextHint', true),
      vadEnabled: getWithFallback<boolean>('vadEnabled', true),
      vadSilenceMs: getWithFallback<number>('vadSilenceMs', 1200),
      vadMinDurationMs: getWithFallback<number>('vadMinDurationMs', 3000),
      apiProvider: getWithFallback<string>('apiProvider', 'cloudflare'),
      customEndpoint: getWithFallback<string>('customEndpoint', '').trim(),
      llmCorrectionEnabled: getWithFallback<boolean>('llmCorrectionEnabled', false),
      llmCorrectionProvider: getWithFallback<string>('llmCorrectionProvider', 'auto'),
      llmCorrectionModel: getWithFallback<string>('llmCorrectionModel', ''),
      llmCorrectionPrompt: getWithFallback<string>(
        'llmCorrectionPrompt',
        '你是一个编程语音转文字后处理器。用户用中文口述编程意图。请修正转写文本中的错误标点符号（在语气停顿处补充逗号、句号），修复代码标识符拼写错误（参考词表中的名字进行匹配替换，保证拼写和大小写完全一致），并去除口语填充词（如：啊、嗯、那个、就是说）。不要改变用户原意，直接输出修正后的文本，不要带有任何解释、问候或Markdown包裹符号。'
      ),
      llmCorrectionCustomEndpoint: getWithFallback<string>('llmCorrectionCustomEndpoint', '').trim(),
      developerModeEnabled: getWithFallback<boolean>('developerModeEnabled', true),
    };
  }

  private clearAutoStop(): void {
    if (this.autoStopTimer !== null) {
      clearTimeout(this.autoStopTimer);
      this.autoStopTimer = null;
    }
  }

  private applyDeveloperModeRules(text: string): string {
    let result = text;

    // 1. File extensions: "dot ts" / "dian ts" -> ".ts" (case-insensitive, optional spaces)
    result = result.replace(/\b(?:dot|点|\\.)\s*(ts|js|json|py|css|html|md|tsx|jsx|sh|yaml|yml|rs|go|c|cpp|h|txt|log)\b/gi, (match, ext) => {
      return `.${ext.toLowerCase()}`;
    });

    // Helper to extract words and convert casing
    const toCamelCase = (str: string): string => {
      const words = str.split(/\s+/).filter(Boolean);
      const firstWord = words[0];
      if (firstWord === undefined) return '';
      return firstWord.toLowerCase() + words.slice(1).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
    };

    const toPascalCase = (str: string): string => {
      const words = str.split(/\s+/).filter(Boolean);
      return words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
    };

    const toSnakeCase = (str: string): string => {
      const words = str.split(/\s+/).filter(Boolean);
      return words.map(w => w.toLowerCase()).join('_');
    };

    const toKebabCase = (str: string): string => {
      const words = str.split(/\s+/).filter(Boolean);
      return words.map(w => w.toLowerCase()).join('-');
    };

    // 2. Case conversions
    // Matches patterns like "camel case auth middleware" or Chinese spoken casing prefixes
    result = result.replace(/(?:camel\s*case|驼峰(?:命名)?|小驼峰)\s*([a-zA-Z0-9_]+(?:\s+[a-zA-Z0-9_]+)*)/gi, (match, target) => {
      return toCamelCase(target);
    });

    result = result.replace(/(?:pascal\s*case|大驼峰|帕斯卡(?:命名)?)\s*([a-zA-Z0-9_]+(?:\s+[a-zA-Z0-9_]+)*)/gi, (match, target) => {
      return toPascalCase(target);
    });

    result = result.replace(/(?:snake\s*case|下划线(?:命名)?|蛇形(?:命名)?)\s*([a-zA-Z0-9_]+(?:\s+[a-zA-Z0-9_]+)*)/gi, (match, target) => {
      return toSnakeCase(target);
    });

    result = result.replace(/(?:kebab\s*case|中划线(?:命名)?|短横线(?:命名)?|脊柱(?:命名)?)\s*([a-zA-Z0-9_]+(?:\s+[a-zA-Z0-9_]+)*)/gi, (match, target) => {
      return toKebabCase(target);
    });

    // 3. Spoken punctuation conversions
    const punctuationMap: [RegExp, string][] = [
      [/双等号/g, '=='],
      [/三等号/g, '==='],
      [/等号/g, '='],
      [/大于等于/g, '>='],
      [/小于等于/g, '<='],
      [/大于/g, '>'],
      [/小于/g, '<'],
      [/加号/g, '+'],
      [/减号/g, '-'],
      [/乘号/g, '*'],
      [/除号/g, '/'],
      [/左括号/g, '('],
      [/右括号/g, ')'],
      [/左大括号|左花括号/g, '{'],
      [/右大括号|右花括号/g, '}'],
      [/左中括号|左方括号/g, '['],
      [/右中括号|右方括号/g, ']'],
      [/单引号/g, "'"],
      [/双引号/g, '"'],
      [/反引号/g, '`'],
      [/分号/g, ';'],
      [/冒号/g, ':'],
      [/斜杠/g, '/'],
      [/反斜杠/g, '\\']
    ];

    for (const [regex, replacement] of punctuationMap) {
      result = result.replace(regex, replacement);
    }

    return result;
  }

  dispose(): void {
    this.clearAutoStop();
    void this.recorder.cancel();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
