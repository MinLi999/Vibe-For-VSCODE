/**
 * Controller layer: the only layer that touches M/V/S simultaneously (02-STANDARDS §2).
 * Responsibilities: command/hotkey orchestration, recording state transitions, auth lifecycle
 * (SecretStorage), timeout auto-stop, error fallback (all user-facing actionable copy is assembled here).
 */
import * as vscode from 'vscode';

import { AudioState } from '../models/AudioState';
import { VocabularyModel, type ContextPayload } from '../models/VocabularyModel';
import { StatusBarViewer, REWRITE_MODE_LABELS } from '../viewer/StatusBarViewer';
import { TextInserter, TextInsertionError, type InsertTarget, type InsertOutcome } from '../viewer/TextInserter';
import { EditorContextViewer } from '../viewer/EditorContextViewer';
import { RewriteComparisonViewer } from '../viewer/RewriteComparisonViewer';
import { AudioRecorderService, FfmpegNotFoundError, RecorderStartError } from '../services/AudioRecorderService';
import { ApiError, CloudflareApiService, type RewriteMode } from '../services/CloudflareApiService';
import { WorkspaceContextService } from '../services/WorkspaceContextService';
import { SystemPasteService } from '../services/SystemPasteService';
import { KeybindingLookupService } from '../services/KeybindingLookupService';

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
  vadSilenceThreshold: number;
  vadAdaptiveThreshold: boolean;
  apiProvider: string;
  customEndpoint: string;
  rewriteMode: RewriteMode;
  /** Evaluation-only: shadow-run Qwen-Plus alongside Haiku, logged to the comparison Output Channel. */
  rewriteCompareEnabled: boolean;
  llmCorrectionProvider: string;
  llmCorrectionModel: string;
  llmCorrectionCustomEndpoint: string;
  developerModeEnabled: boolean;
}

/** Unified provider result: cloudflare returns server-side rewrite info; others are ASR-only. */
interface TranscriptionOutcome {
  text: string;
  /** Short label for the status bar, e.g. "Qwen3+Haiku" / "Whisper" / "groq". */
  engineLabel: string;
  totalMs: number;
  /** True when the server already ran the rewrite stage (skip client-side correction). */
  serverRewrote: boolean;
}

/** Maps server engine ids to compact status-bar labels. */
function engineLabelOf(engines: { asr: string; rewrite: string }): string {
  const asrLabels: Record<string, string> = {
    'qwen3-asr-flash': 'Qwen3',
    'cf-whisper-large-v3-turbo': 'Whisper',
  };
  const rewriteLabels: Record<string, string> = {
    'claude-haiku-4-5': 'Haiku',
    'cf-llama-3.1-8b-instruct': 'Llama',
  };
  const asr = asrLabels[engines.asr] ?? engines.asr;
  const rewrite = engines.rewrite === 'none' ? '' : rewriteLabels[engines.rewrite] ?? engines.rewrite;
  return rewrite ? `${asr}+${rewrite}` : asr;
}

/** Built-in prompts for the client-side correction fallback (non-cloudflare providers only). */
const FALLBACK_CLEAN_PROMPT =
  '你是一个语音输入后处理器，处理程序员的中英混合口述转写文本。只做最小限度清理：修正标点；删除填充词（嗯、啊、那个、就是说、um、uh）；合并口吃重复；按参考词表修复代码标识符拼写与大小写；口述符号词保留原样文字；不翻译、不增删内容、不调整语序。只输出处理后的纯文本，不要任何解释或包裹符号。';
const FALLBACK_REWRITE_PROMPT =
  '你是一个语音输入改写器，把程序员的中英混合口述转写整理成清晰指令：删除填充词与口吃重复；处理回溯自我更正（"用A……不对，用B"只保留B）；轻度修复语法与断句但绝不改变技术意图、绝不添加原文没有的内容；按参考词表还原代码标识符精确拼写与大小写；口述符号词保留原样文字；保留中英混排不翻译；输出长度不超过原文。只输出改写后的纯文本，不要任何解释或包裹符号。';

export class VibeController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private autoStopTimer: ReturnType<typeof setTimeout> | null = null;
  /** Session transcript window for cross-segment conditioning; only the last 300 chars are ever sent. */
  private sessionTranscript: string = '';
  private vadSegmentsTranscribedCount: number = 0;
  /** Per-recording-session caches: context payload and config are computed ONCE per session, not per VAD segment. */
  private sessionContext: Promise<ContextPayload> | null = null;
  private sessionConfig: VibeConfig | null = null;
  /** Session stats accumulated across VAD segments for the consolidated end-of-session feedback. */
  private sessionChars = 0;
  private sessionProcessingMs = 0;
  private sessionEngineLabel = '';
  private readonly sessionErrors: string[] = [];

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
    private readonly systemPaste: SystemPasteService,
    private readonly keybindingLookup: KeybindingLookupService,
    private readonly rewriteComparison: RewriteComparisonViewer,
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
      vscode.commands.registerCommand('vibefox.diagnoseAudio', () => this.diagnoseAudio()),
      vscode.commands.registerCommand('vibefox.selectRewriteMode', () => this.selectRewriteMode()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('vibefox.rewriteMode')) {
          this.statusBar.setRewriteMode(this.readConfig().rewriteMode);
        }
      }),
    );
    void this.migrateLegacySettings(context);
    this.statusBar.setRewriteMode(this.readConfig().rewriteMode);
  }

  /**
   * One-time migration of the deprecated llmCorrection* settings to rewriteMode:
   * an explicit llmCorrectionEnabled=true meant today's 'clean'; explicit false means 'off'.
   * Unset users get the new default ('clean') automatically — the flagship experience.
   */
  private async migrateLegacySettings(context: vscode.ExtensionContext): Promise<void> {
    const MIGRATION_FLAG = 'vibefox.migratedRewriteModeV2';
    if (context.globalState.get<boolean>(MIGRATION_FLAG) === true) {
      return;
    }
    const cfg = vscode.workspace.getConfiguration('vibefox');
    const inspected = cfg.inspect<boolean>('llmCorrectionEnabled');
    const explicit = inspected?.globalValue ?? inspected?.workspaceValue ?? inspected?.workspaceFolderValue;
    if (explicit !== undefined) {
      await cfg.update('rewriteMode', explicit ? 'clean' : 'off', vscode.ConfigurationTarget.Global);
    }
    await context.globalState.update(MIGRATION_FLAG, true);
  }

  /** QuickPick to switch the rewrite mode (also reachable from the status-bar tooltip link). */
  private async selectRewriteMode(): Promise<void> {
    const current = this.readConfig().rewriteMode;
    const items: Array<vscode.QuickPickItem & { mode: RewriteMode }> = [
      { mode: 'off', label: REWRITE_MODE_LABELS['off'] ?? 'off', description: '原样输出转写结果,不做任何处理' },
      { mode: 'clean', label: REWRITE_MODE_LABELS['clean'] ?? 'clean', description: '去填充词、修标点、按项目词表校正标识符(推荐)' },
      { mode: 'rewrite', label: REWRITE_MODE_LABELS['rewrite'] ?? 'rewrite', description: '在清理基础上折叠口误自纠、轻度重组语句' },
    ];
    for (const item of items) {
      if (item.mode === current) {
        item.picked = true;
        item.label = `$(check) ${item.label}`;
      }
    }
    const pick = await vscode.window.showQuickPick(items, { title: 'VibeFox 改写模式', placeHolder: '选择语音转写后的文本处理方式' });
    if (pick !== undefined) {
      await vscode.workspace.getConfiguration('vibefox').update('rewriteMode', pick.mode, vscode.ConfigurationTarget.Global);
      this.statusBar.setRewriteMode(pick.mode);
    }
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
    this.sessionTranscript = '';
    this.vadSegmentsTranscribedCount = 0;
    this.sessionChars = 0;
    this.sessionProcessingMs = 0;
    this.sessionEngineLabel = '';
    this.sessionErrors.length = 0;
    // Context payload + config are frozen per session (VAD segments reuse them instead of
    // re-scanning the workspace and re-reading config on every silence split).
    this.sessionConfig = config;
    this.sessionContext = config.contextHint
      ? this.buildSessionContext()
      : Promise.resolve({ keywords: [], projectContext: '' });
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
          vadSilenceThreshold: config.vadSilenceThreshold,
          vadAdaptiveThreshold: config.vadAdaptiveThreshold,
          onSegment: config.vadEnabled ? (segmentMp3) => void this.handleVadSegment(segmentMp3) : undefined,
          onSegmentError: (error) => this.sessionErrors.push(error.message),
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
      const config = this.sessionConfig ?? this.readConfig();
      let audioBase64 = '';
      if (config.vadEnabled && finalMp3 !== null) {
        audioBase64 = finalMp3.toString('base64');
      } else {
        if (!this.audioState.hasAudio()) {
          // In VAD mode, it is normal that the final segment is empty if silence split occurred right before stop.
          if (config.vadEnabled && this.vadSegmentsTranscribedCount > 0) {
            this.finishSession(config);
            return;
          }
          throw new RecorderStartError(
            `没有录到音频，请检查麦克风权限与输入设备${process.platform === 'darwin' ? '(macOS:系统设置 → 隐私与安全性 → 麦克风,允许 VS Code/Antigravity)' : ''}`
          );
        }
        audioBase64 = this.audioState.toBase64();
      }

      const context = await this.currentSessionContext(config);
      const { finalText, engineLabel, totalMs } = await this.processUtterance(config, audioBase64, context);

      if (finalText.trim().length > 0) {
        this.sessionTranscript = (this.sessionTranscript + ' ' + finalText).trim();
        this.sessionChars += finalText.length;
        this.sessionProcessingMs += totalMs;
        this.sessionEngineLabel = engineLabel;
        const outcome = await this.insertWithPaste(finalText, config.insertTarget);
        this.audioState.completeWithText(finalText);
        this.finishSession(config);
        if (outcome.via === 'clipboard' || outcome.via === 'chat') {
          void vscode.window.showInformationMessage('VibeFox:转写结果已复制到剪贴板,如果聊天框未自动填入,可直接粘贴(⌘V / Ctrl+V)');
        }
      } else {
        // Trailing segment turned out to be silence — normal end of a VAD session.
        this.audioState.reset();
        this.finishSession(config);
      }
    } catch (err) {
      this.audioState.reset();

      const config = this.sessionConfig ?? this.readConfig();
      if (config.vadEnabled && this.vadSegmentsTranscribedCount > 0) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (
          errMsg.includes('no text') ||
          errMsg.includes('silent') ||
          errMsg.includes('empty') ||
          errMsg.includes('502')
        ) {
          // Silent trailing audio is a normal way for a VAD session to end.
          this.finishSession(config);
          return;
        }
      }

      this.statusBar.flashResult('error', '转写失败');
      await this.reportTranscribeError(err);
      this.flushSessionErrors();
    }
  }

  /** Session-end feedback: one consolidated stats flash + at most one error summary toast. */
  private finishSession(config: VibeConfig): void {
    const segments = this.vadSegmentsTranscribedCount + (this.sessionChars > 0 && !config.vadEnabled ? 1 : 0);
    if (this.sessionChars > 0) {
      this.statusBar.flashResultWithStats({
        chars: this.sessionChars,
        segments: Math.max(1, segments),
        engineLabel: this.sessionEngineLabel || config.apiProvider,
        totalMs: this.sessionProcessingMs / Math.max(1, segments),
      });
    } else {
      this.statusBar.showIdle();
    }
    this.flushSessionErrors();
  }

  /** Reports accumulated per-segment failures as ONE summary toast instead of one per segment. */
  private flushSessionErrors(): void {
    if (this.sessionErrors.length === 0) {
      return;
    }
    const unique = [...new Set(this.sessionErrors)];
    const count = this.sessionErrors.length;
    this.sessionErrors.length = 0;
    void vscode.window.showErrorMessage(
      `VibeFox:本次录音有 ${count} 段转写失败 —— ${unique[0]}${unique.length > 1 ? ` 等 ${unique.length} 类错误` : ''}`,
    );
  }

  /** Shared per-utterance pipeline: provider transcription (+server rewrite) → client fallback rewrite → dev-mode rules. */
  private async processUtterance(
    config: VibeConfig,
    audioBase64: string,
    context: ContextPayload,
  ): Promise<{ finalText: string; engineLabel: string; totalMs: number }> {
    const started = Date.now();
    const outcome = await this.transcribeWithProvider(config, audioBase64, context);

    let finalText = outcome.text;
    if (!outcome.serverRewrote && config.rewriteMode !== 'off') {
      finalText = await this.correctTextWithProvider(config, finalText, context.keywords);
    }
    if (config.developerModeEnabled) {
      finalText = this.applyDeveloperModeRules(finalText);
    }
    return { finalText, engineLabel: outcome.engineLabel, totalMs: outcome.totalMs || Date.now() - started };
  }

  /** Insert via the viewer, then honor its needsSystemPaste hint (process spawning is Controller/Service territory). */
  private async insertWithPaste(text: string, target: InsertTarget): Promise<InsertOutcome> {
    const outcome = await this.inserter.insert(text, target);
    if (outcome.via === 'chat' && outcome.needsSystemPaste) {
      await this.systemPaste.simulatePaste();
    }
    return outcome;
  }

  private async currentSessionContext(config: VibeConfig): Promise<ContextPayload> {
    if (this.sessionContext !== null) {
      return this.sessionContext;
    }
    return config.contextHint ? this.buildSessionContext() : { keywords: [], projectContext: '' };
  }

  private async handleVadSegment(segmentMp3: Buffer): Promise<void> {
    const config = this.sessionConfig ?? this.readConfig();
    try {
      const context = await this.currentSessionContext(config);
      const { finalText, engineLabel, totalMs } = await this.processUtterance(config, segmentMp3.toString('base64'), context);

      if (finalText.trim().length > 0) {
        this.sessionTranscript = (this.sessionTranscript + ' ' + finalText).trim();
        this.vadSegmentsTranscribedCount++;
        this.sessionChars += finalText.length;
        this.sessionProcessingMs += totalMs;
        this.sessionEngineLabel = engineLabel;
        // No per-segment toast — progress lives in the status bar; one consolidated summary at session end.
        await this.insertWithPaste(finalText, config.insertTarget);
      }
    } catch (err) {
      console.error('[VibeFox VAD Segment ASR Error]', err);
      this.sessionErrors.push(err instanceof Error ? err.message : String(err));
    }
  }

  private async transcribeWithProvider(
    config: VibeConfig,
    audioBase64: string,
    context: ContextPayload,
  ): Promise<TranscriptionOutcome> {
    const provider = config.apiProvider;
    const previousTranscript = this.sessionTranscript.slice(-300) || undefined;
    const keywords = context.keywords;
    const started = Date.now();

    if (provider === 'cloudflare') {
      const licenseKey = await this.secrets.get(SECRET_KEY);
      if (licenseKey === undefined) {
        throw new ApiError('unauthorized', 'License key 已被清除,请重新设置');
      }
      const result = await this.api.transcribe(config.endpoint, licenseKey, {
        audio: audioBase64,
        language: config.language,
        keywords,
        projectContext: context.projectContext || undefined,
        previousTranscript,
        rewriteMode: config.rewriteMode,
        compareRewrite: config.rewriteCompareEnabled,
      });
      if (config.rewriteCompareEnabled && result.rewriteComparison) {
        this.rewriteComparison.log({
          rawText: result.rawText,
          primaryEngine: result.engines.rewrite,
          primaryText: result.finalText,
          primaryMs: result.timings.rewrite_ms,
          qwenText: result.rewriteComparison.qwenText,
          qwenMs: result.rewriteComparison.qwenMs,
          qwenError: result.rewriteComparison.qwenError,
        });
      }
      return {
        text: result.finalText,
        engineLabel: engineLabelOf(result.engines),
        totalMs: result.timings.total_ms,
        // The Worker owns the whole rewrite chain (including its fallbacks) on this path.
        serverRewrote: true,
      };
    }

    let text: string;
    if (provider === 'groq') {
      const apiKey = await this.secrets.get('vibefox.groqKey');
      if (apiKey === undefined) {
        throw new ApiError('unauthorized', 'Groq API Key 未设置，请运行「VibeFox: Set API Key」进行设置');
      }
      text = await this.api.transcribeGroq(apiKey, audioBase64, config.language, keywords, previousTranscript);
    } else if (provider === 'openai') {
      const apiKey = await this.secrets.get('vibefox.openaiKey');
      if (apiKey === undefined) {
        throw new ApiError('unauthorized', 'OpenAI API Key 未设置，请运行「VibeFox: Set API Key」进行设置');
      }
      text = await this.api.transcribeOpenAI(apiKey, audioBase64, config.language, keywords, previousTranscript);
    } else if (provider === 'aliyun') {
      const apiKey = await this.secrets.get('vibefox.aliyunKey');
      if (apiKey === undefined) {
        throw new ApiError('unauthorized', '阿里云 API Key 未设置，请运行「VibeFox: Set API Key」进行设置');
      }
      text = await this.api.transcribeAliyun(config.endpoint, apiKey, audioBase64, config.language, keywords, previousTranscript);
    } else if (provider === 'custom') {
      if (!config.customEndpoint) {
        throw new Error('自定义服务地址 (vibefox.customEndpoint) 未配置');
      }
      text = await this.api.transcribeCustom(config.customEndpoint, audioBase64, config.language, keywords, previousTranscript);
    } else {
      throw new Error(`不支持的 API Provider: ${provider}`);
    }
    return { text, engineLabel: provider, totalMs: Date.now() - started, serverRewrote: false };
  }

  /**
   * Client-side rewrite for non-cloudflare providers (the Worker path rewrites server-side).
   * Prompts are built-in per rewriteMode; a legacy llmCorrectionProvider of 'cloudflare' falls
   * back to the active provider's chat endpoint instead of silently skipping correction.
   */
  private async correctTextWithProvider(
    config: VibeConfig,
    text: string,
    keywords: string[]
  ): Promise<string> {
    let provider = config.llmCorrectionProvider === 'auto' ? config.apiProvider : config.llmCorrectionProvider;
    if (provider === 'cloudflare') {
      if (config.apiProvider === 'cloudflare') {
        return text;
      }
      provider = config.apiProvider;
    }

    const systemPrompt = config.rewriteMode === 'rewrite' ? FALLBACK_REWRITE_PROMPT : FALLBACK_CLEAN_PROMPT;

    if (provider === 'groq') {
      const apiKey = await this.secrets.get('vibefox.groqKey');
      if (apiKey === undefined) {
        throw new Error('Groq API Key 未设置，无法进行 LLM 后处理');
      }
      const model = config.llmCorrectionModel || 'llama-3.3-70b-versatile';
      return this.api.llmCorrectOpenAICompatible('https://api.groq.com/openai/v1', apiKey, model, text, keywords, systemPrompt);
    } else if (provider === 'openai') {
      const apiKey = await this.secrets.get('vibefox.openaiKey');
      if (apiKey === undefined) {
        throw new Error('OpenAI API Key 未设置，无法进行 LLM 后处理');
      }
      const model = config.llmCorrectionModel || 'gpt-4o-mini';
      return this.api.llmCorrectOpenAICompatible('https://api.openai.com/v1', apiKey, model, text, keywords, systemPrompt);
    } else if (provider === 'aliyun') {
      const apiKey = await this.secrets.get('vibefox.aliyunKey');
      if (apiKey === undefined) {
        throw new Error('阿里云 API Key 未设置，无法进行 LLM 后处理');
      }
      const model = config.llmCorrectionModel || 'qwen-turbo';
      return this.api.llmCorrectOpenAICompatible('https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey, model, text, keywords, systemPrompt);
    } else if (provider === 'custom') {
      const endpoint = config.llmCorrectionCustomEndpoint || config.customEndpoint;
      if (!endpoint) {
        throw new Error('自定义 LLM 后处理端点未配置');
      }
      return this.api.llmCorrectOpenAICompatible(endpoint, '', config.llmCorrectionModel, text, keywords, systemPrompt);
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
        `VibeFox:正在终端执行「${installCommand}」,完成后再按 ${this.keybindingLookup.getActiveKeybinding()} 即可录音`,
      );
    } else if (pick === '手动指定路径') {
      void vscode.commands.executeCommand('workbench.action.openSettings', 'vibefox.ffmpegPath');
    }
  }

  /** Viewer takes a text snapshot → Model builds the two-tier payload. Called ONCE per recording session. */
  private async buildSessionContext(): Promise<ContextPayload> {
    const snapshot = await this.editorContext.snapshot();
    const workspaceKeywords = this.workspaceContext.getWorkspaceKeywords();
    return this.vocabulary.buildPayload(snapshot, workspaceKeywords);
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
        case 'rate-limited':
          void vscode.window.showErrorMessage('VibeFox:请求过于频繁,已被服务端限流,请稍候数十秒再试');
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
      vadSilenceThreshold: getWithFallback<number>('vadSilenceThreshold', 350),
      vadAdaptiveThreshold: getWithFallback<boolean>('vadAdaptiveThreshold', true),
      apiProvider: getWithFallback<string>('apiProvider', 'cloudflare'),
      customEndpoint: getWithFallback<string>('customEndpoint', '').trim(),
      rewriteMode: getWithFallback<RewriteMode>('rewriteMode', 'clean'),
      rewriteCompareEnabled: getWithFallback<boolean>('rewriteCompareEnabled', false),
      llmCorrectionProvider: getWithFallback<string>('llmCorrectionProvider', 'auto'),
      llmCorrectionModel: getWithFallback<string>('llmCorrectionModel', ''),
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
    result = result.replace(/\b(?:dot|点|\.)\s*(ts|js|json|py|css|html|md|tsx|jsx|sh|yaml|yml|rs|go|c|cpp|h|txt|log)\b/gi, (match, ext) => {
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

  private async diagnoseAudio(): Promise<void> {
    const config = this.readConfig();
    const pick = await vscode.window.showInformationMessage(
      `VibeFox 将开始 3 秒钟的麦克风测试，请准备好对着麦克风持续大声说话。是否开始？`,
      '开始测试',
      '取消'
    );
    if (pick !== '开始测试') {
      return;
    }

    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.text = '$(mic) 正在测试中，请持续大声说话...';
    statusBarItem.show();

    try {
      // Low-level capture lives in the recorder service (cross-platform args included).
      const { averageAmplitude: average } = await this.recorder.captureSample(config.ffmpegPath, config.audioDevice, 3);

      if (average < 100) {
        await vscode.window.showWarningMessage(
          `诊断结果：麦克风输入信号极弱（平均音量仅为 ${average}，近乎静音）。\n` +
          `这通常是由于 macOS 权限缓存未更新或选错设备所致。请尝试使用 Cmd+Q 彻底退出并重启 IDE，或在终端中使用 'antigravity .' 命令启动 IDE。`
        );
      } else {
        await vscode.window.showInformationMessage(
          `诊断结果：麦克风工作正常！平均音量为 ${average}，已成功捕获音频数据！`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await vscode.window.showErrorMessage(`诊断失败：${msg}`);
    } finally {
      statusBarItem.dispose();
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
