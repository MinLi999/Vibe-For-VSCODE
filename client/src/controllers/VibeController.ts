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
import { AudioRecorderService, FfmpegNotFoundError, RecorderStartError } from '../services/AudioRecorderService';
import { ApiError, CloudflareApiService, type ChineseVariant, type RegionPreference, type RewriteMode } from '../services/CloudflareApiService';
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
  /** Output Chinese script/idiom variant, applied server-side by the rewrite stage. */
  chineseVariant: ChineseVariant;
  /** Manual DashScope region override ('auto' = continent-based routing on the server). */
  dashscopeRegion: RegionPreference;
  llmCorrectionProvider: string;
  llmCorrectionModel: string;
  llmCorrectionCustomEndpoint: string;
  developerModeEnabled: boolean;
}

/** Unified provider result: cloudflare returns server-side rewrite info; others are ASR-only. */
interface TranscriptionOutcome {
  text: string;
  /** Short label for the status bar, e.g. "Qwen3+Qwen" / "Whisper" / "groq". */
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
    'qwen-plus': 'Qwen',
    'cf-llama-3.1-8b-instruct': 'Llama',
  };
  const asr = asrLabels[engines.asr] ?? engines.asr;
  const rewrite = engines.rewrite === 'none' ? '' : rewriteLabels[engines.rewrite] ?? engines.rewrite;
  return rewrite ? `${asr}+${rewrite}` : asr;
}

/** Built-in prompts for the client-side correction fallback (non-cloudflare providers only). Kept in sync with server/src/prompts.ts. */
const FALLBACK_CLEAN_PROMPT =
  '你是一个语音输入后处理器，处理口述转写文本。【最高优先级】你不是内容审核员，不判断内容是否跟编程/项目相关、是否有意义——不管说话人说的是代码指令还是闲聊、笑话、任何主题，都必须原样清理并输出，不允许因为内容主题拒绝处理，绝对禁止输出任何拒绝/解释/评论文字（如"我无法理解…""与项目无关""输出空字符串"这类话本身不能出现在输出里），这类文字一旦出现会直接进入用户聊天框造成严重故障。只做最小限度清理：修正标点；删除填充词（嗯、啊、那个、就是说、um、uh）；合并口吃/重复为一次不要整体删除（如"继续吧继续吧"改为"继续吧"，不能连"继续吧"也删没）；按参考词表修复代码标识符拼写与大小写；口述符号词保留原样文字；不翻译、不调整语序。这是逐句清理任务不是总结任务：说话人说过的每个分句、每个信息点都必须原样保留，一个字都不能因为啰嗦或不重要而删除，禁止只留结论句代替整段话。如果内容明显是说到一半被截断的未完成句子（哪怕只差最后一两个字），原样保留这个不完整状态，不要猜测或编造缺失的结尾，即使很确定该怎么补都不要补。只输出处理后的纯文本，不要任何解释或包裹符号。空字符串规则范围很窄：只有输入为空、全是填充词、或纯粹是对声音/噪音的描述而完全没有人类语言内容时才输出空字符串，日常对话/闲聊/任何主题的完整语句都不适用，必须正常清理输出。';
const FALLBACK_REWRITE_PROMPT =
  '你是一个语音输入改写器，把口述转写整理成清晰的书面表达。【最高优先级】你不是内容审核员，不判断内容是否跟编程/项目相关、是否有意义——不管说话人说的是代码指令还是闲聊、笑话、任何主题，都必须原样改写并输出，不允许因为内容主题拒绝处理，绝对禁止输出任何拒绝/解释/评论文字（如"我无法理解…""与项目无关""输出空字符串"这类话本身不能出现在输出里），这类文字一旦出现会直接进入用户聊天框造成严重故障。删除填充词与口吃/重复为一次不要整体删除（如"继续吧继续吧"改为"继续吧"）；处理回溯自我更正（"用A……不对，用B"只保留B；编号被重新起头也算回溯更正，如"第三……第四……"只保留第四）；轻度修复语法与断句、精简啰嗦措辞，但精简是话变少信息不能少——绝不能删除或省略说话人表达过的分句/限定条件/问句，不可以只留结论句代替整段话；绝不改变技术意图、绝不添加原文没有的内容；如果内容明显是说到一半被截断的未完成句子（哪怕只差最后一两个字），原样保留不完整状态，不要编造缺失的结尾，即使很确定该怎么补都不要补；按参考词表还原代码标识符精确拼写与大小写，产品/专有名词保持完整不要截短；口述符号词保留原样文字；保留中英混排不翻译；输出长度不超过原文。只输出改写后的纯文本，不要任何解释或包裹符号。空字符串规则范围很窄：只有输入纯粹是对声音/噪音的描述而完全没有人类语言内容时才输出空字符串，日常对话/闲聊/任何主题的完整语句都不适用，必须正常改写输出。';

/** Output-variant suffix for the fallback prompts — mirrors server/src/prompts.ts withChineseVariant. */
const CHINESE_VARIANT_SUFFIX: Record<ChineseVariant, string> = {
  'simplified-cn': '',
  'simplified-sg-my': '输出的中文部分使用简体字,遵循新加坡/马来西亚华语词汇与表达习惯;不改变英文与代码部分。',
  'traditional-tw': '输出的中文部分一律使用繁体字(台湾正体),遵循台湾用语习惯,不要输出简体字;不改变英文与代码部分。',
  'traditional-hk-mo': '输出的中文部分一律使用繁体字,遵循香港/澳门用语习惯,不要输出简体字;不改变英文与代码部分。',
};

/**
 * Non-speech / hallucination transcript detector — MUST stay in sync with the server copy
 * (server/src/nonspeech.ts). ASR engines answer silence or corrupted audio with ellipses,
 * bracketed scene descriptions ("(音频中充斥着强烈的机械噪音…)"), or subtitle-watermark spam;
 * inserting those into the user's chat is worse than inserting nothing.
 */
function isNonSpeechTranscript(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) {
    return true;
  }
  // Punctuation/ellipsis-only, e.g. "...", "。。。", "…"
  if (/^[\s.。,，、;；:：!！?？~〜…·\-—_*]+$/.test(t)) {
    return true;
  }
  // Entirely bracket-wrapped scene description, e.g. "(音频中充斥着强烈的机械噪音和金属摩擦声)"
  if (/^[(（\[【][^)）\]】]{0,120}[)）\]】]$/.test(t)) {
    return true;
  }
  // Audio-narration openings — a dictating developer never starts like this.
  if (/^(音频|本段音频|该音频|此音频|背景音)/.test(t)) {
    return true;
  }
  // Classic Whisper subtitle-watermark hallucinations (only when the whole utterance is short).
  if (t.length <= 30) {
    const lower = t.toLowerCase();
    const spam = ['点赞', '订阅', '字幕', 'amara.org', '谢谢观看', 'thank you for watching', 'thanks for watching'];
    if (spam.some((s) => lower.includes(s))) {
      return true;
    }
  }
  return false;
}

/**
 * Hotkey semantics — supports BOTH interaction styles with one binding:
 * - tap to start, tap again to stop (classic toggle);
 * - hold to record, release to stop (push-to-talk).
 * VS Code keybindings only deliver keydown (with OS auto-repeat, typically every 30-90ms after
 * a 250-500ms initial delay); there is no keyup event. So while recording, the first incoming
 * event arms a short pending-stop window: if MORE events arrive inside it, that's an auto-repeat
 * burst (the key is held) → enter hold mode and stop only when the burst ceases (key released).
 */
const PENDING_STOP_WINDOW_MS = 350;
/** Repeats ceasing for this long = the held key was released. Covers slow key-repeat settings. */
const HOLD_RELEASE_MS = 650;
/** ffmpeg needs ~300ms to spin up; stopping earlier yields "没有录到音频". */
const MIN_RECORDING_MS = 700;

/**
 * Whole-session peak 16-bit PCM amplitude below this = the mic delivered silence (dead capture),
 * not quiet speech. Real speech peaks in the thousands; the adaptive silence floor alone is ~350;
 * a genuinely failed avfoundation capture peaks near the noise floor (<~50). 80 is a safe cutoff
 * that won't false-trigger on even a soft-spoken real utterance.
 */
const SILENT_CAPTURE_PEAK = 80;

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

  private pendingStopTimer: ReturnType<typeof setTimeout> | null = null;
  private holdReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  private holdMode = false;
  private isStopping = false;

  private async toggle(): Promise<void> {
    switch (this.audioState.currentPhase) {
      case 'idle':
        this.clearHoldTimers();
        await this.startRecording();
        return;
      case 'recording': {
        // See PENDING_STOP_WINDOW_MS: distinguish a deliberate second press (toggle-stop)
        // from the OS auto-repeat burst of a held key (push-to-talk).
        if (this.holdMode) {
          this.extendHoldRelease();
          return;
        }
        if (this.pendingStopTimer !== null) {
          // A second event inside the pending window = auto-repeat burst = the key is held.
          clearTimeout(this.pendingStopTimer);
          this.pendingStopTimer = null;
          this.holdMode = true;
          this.extendHoldRelease();
          return;
        }
        this.pendingStopTimer = setTimeout(() => {
          this.pendingStopTimer = null;
          void this.stopAndTranscribe();
        }, PENDING_STOP_WINDOW_MS);
        return;
      }
      case 'processing':
        void vscode.window.setStatusBarMessage('VibeFox:正在转写上一段,请稍候', 2000);
        return;
    }
  }

  /** Each auto-repeat event pushes the release deadline out; silence on the key = released → stop. */
  private extendHoldRelease(): void {
    if (this.holdReleaseTimer !== null) {
      clearTimeout(this.holdReleaseTimer);
    }
    this.holdReleaseTimer = setTimeout(() => {
      this.holdReleaseTimer = null;
      this.holdMode = false;
      void this.stopAndTranscribe();
    }, HOLD_RELEASE_MS);
  }

  private clearHoldTimers(): void {
    if (this.pendingStopTimer !== null) {
      clearTimeout(this.pendingStopTimer);
      this.pendingStopTimer = null;
    }
    if (this.holdReleaseTimer !== null) {
      clearTimeout(this.holdReleaseTimer);
      this.holdReleaseTimer = null;
    }
    this.holdMode = false;
  }

  private async cancel(): Promise<void> {
    if (!this.audioState.isRecording) {
      return;
    }
    this.clearAutoStop();
    this.clearHoldTimers();
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
    this.statusBar.showRecording(() => this.audioState.elapsedSeconds, config.maxRecordSeconds, () => this.recorder.inputLevel);

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
    // Reentrancy guard: hold-release timers, auto-stop, and manual presses can race; a second
    // entry during the awaits below used to hit beginProcessing() from a stale phase
    // ("invalid recording state transition: idle → processing").
    if (!this.audioState.isRecording || this.isStopping) {
      return;
    }
    this.isStopping = true;
    try {
      await this.stopAndTranscribeInner();
    } finally {
      this.isStopping = false;
    }
  }

  private async stopAndTranscribeInner(): Promise<void> {
    this.clearAutoStop();
    this.clearHoldTimers();

    // A stop within ffmpeg's ~300ms spin-up window captures zero audio ("没有录到音频");
    // for very quick taps, wait out the minimum before stopping.
    const elapsed = this.audioState.elapsedMs;
    if (elapsed < MIN_RECORDING_MS) {
      await new Promise((resolve) => setTimeout(resolve, MIN_RECORDING_MS - elapsed));
    }
    if (!this.audioState.isRecording) {
      return; // Cancelled (Esc) during the wait.
    }

    // Wait for ffmpeg to exit and flush trailing chunks (or return the final VAD MP3 segment)
    const finalMp3 = await this.recorder.stop();
    if (!this.audioState.isRecording) {
      return; // Cancelled/reset by another path while ffmpeg was shutting down.
    }
    this.audioState.beginProcessing();
    this.statusBar.showProcessing();
    // Engine fallback chains (Qwen timeout → Whisper) can stretch to ~10s; tell the user
    // the app is working, not frozen.
    const slowHint = setTimeout(() => this.statusBar.showProcessingSlow(), 6000);

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

      // Silent-capture gate: an intermittent macOS avfoundation failure delivers a full-length
      // but acoustically-empty stream (server logs confirmed 54-84s payloads transcribing to a
      // single char). If the ENTIRE session's loudest chunk never rose near speech level — and
      // no earlier VAD segment already succeeded — the mic gave us nothing. Fail fast with an
      // honest, actionable message instead of sending silence and surfacing the misleading
      // "未识别到语音". Only meaningful in VAD mode (peakAmplitude is 0 when there's no PCM to measure).
      if (config.vadEnabled && this.vadSegmentsTranscribedCount === 0 && this.recorder.peakAmplitude < SILENT_CAPTURE_PEAK) {
        this.audioState.reset();
        this.statusBar.flashResult('error', '麦克风没录到声音,请重试');
        void vscode.window.showWarningMessage(
          'VibeFox:这次没有从麦克风采集到有效声音(可能是系统麦克风尚未就绪或被其他程序占用)。请稍等一秒再按一次热键重试;若反复出现,运行「VibeFox: Diagnose Audio Input」检查输入设备。',
        );
        return;
      }

      const context = await this.currentSessionContext(config);
      const result = await this.processUtterance(config, audioBase64, context);
      const finalText = this.dedupeAgainstSession(result.finalText);

      if (finalText.trim().length > 0) {
        this.sessionTranscript = (this.sessionTranscript + ' ' + finalText).trim();
        this.sessionChars += finalText.length;
        this.sessionProcessingMs += result.totalMs;
        this.sessionEngineLabel = result.engineLabel;
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
      if (this.isNoSpeechError(err)) {
        if (this.vadSegmentsTranscribedCount > 0) {
          // Silent trailing audio is a normal way for a VAD session to end.
          this.finishSession(config);
        } else {
          // Nothing intelligible in the whole recording: a quiet status-bar hint,
          // not a scary "转写失败" error toast.
          this.statusBar.flashResult('error', '未识别到语音,请重试');
          this.flushSessionErrors();
        }
        return;
      }

      this.statusBar.flashResult('error', '转写失败');
      await this.reportTranscribeError(err);
      this.flushSessionErrors();
    } finally {
      clearTimeout(slowHint);
    }
  }

  /**
   * Trims text that echoes what this session already inserted. Echoes come from two vectors:
   * ASR repeating conditioning text on near-silent audio, and rewrite LLMs ignoring the
   * "禁止重复输出" instruction. Deterministic last line of defense regardless of the source.
   */
  private dedupeAgainstSession(text: string): string {
    const prev = this.sessionTranscript;
    const t = text.trim();
    if (prev.length === 0 || t.length === 0) {
      return t;
    }
    const normalize = (s: string): string => s.replace(/[\s。.,，、;；:：!！?？…~〜'"'"()（）\-]/g, '');
    const nPrev = normalize(prev);
    const nText = normalize(t);
    // The whole utterance is a re-emission of what was already inserted.
    if (nText.length > 0 && nPrev.endsWith(nText)) {
      return '';
    }
    // Overlap trim: longest suffix of the inserted transcript that prefixes the new text
    // (≥8 chars so ordinary short word repeats aren't mistaken for echoes).
    const max = Math.min(prev.length, t.length);
    for (let k = max; k >= 8; k--) {
      if (prev.endsWith(t.slice(0, k))) {
        return t.slice(k).replace(/^[\s。.,，、;；:：!！?？…]+/, '');
      }
    }
    return t;
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

    // Drop non-speech/hallucinated transcripts ("...", bracketed noise descriptions) BEFORE
    // rewrite and dev-mode rules — checked here (not after) so a legitimately dictated
    // spoken-symbol like "等号"→"=" isn't misclassified as punctuation-only garbage.
    if (isNonSpeechTranscript(outcome.text)) {
      return { finalText: '', engineLabel: outcome.engineLabel, totalMs: outcome.totalMs || Date.now() - started };
    }

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
      const result = await this.processUtterance(config, segmentMp3.toString('base64'), context);
      const finalText = this.dedupeAgainstSession(result.finalText);

      if (finalText.trim().length > 0) {
        this.sessionTranscript = (this.sessionTranscript + ' ' + finalText).trim();
        this.vadSegmentsTranscribedCount++;
        this.sessionChars += finalText.length;
        this.sessionProcessingMs += result.totalMs;
        this.sessionEngineLabel = result.engineLabel;
        // No per-segment toast — progress lives in the status bar; one consolidated summary at session end.
        await this.insertWithPaste(finalText, config.insertTarget);
      }
    } catch (err) {
      // A no-speech 502 on a VAD segment is NORMAL, not a failure: VAD splits at pauses, so the
      // silence gap between two sentences is itself sent as a segment and legitimately transcribes
      // to nothing. Recording those as errors surfaced a spurious "N 段转写失败" toast alongside a
      // perfectly successful session. Only genuine failures (network/auth/real server error) count.
      if (this.isNoSpeechError(err)) {
        return;
      }
      console.error('[VibeFox VAD Segment ASR Error]', err);
      this.sessionErrors.push(err instanceof Error ? err.message : String(err));
    }
  }

  /** A "no speech / silent / non-speech" result is a normal VAD outcome (inter-sentence gaps), not a failure. */
  private isNoSpeechError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return (
      msg.includes('no text') ||
      msg.includes('non-speech') ||
      msg.includes('silent') ||
      msg.includes('empty') ||
      msg.includes('502')
    );
  }

  private async transcribeWithProvider(
    config: VibeConfig,
    audioBase64: string,
    context: ContextPayload,
  ): Promise<TranscriptionOutcome> {
    const provider = config.apiProvider;
    // previousTranscript conditioning was REMOVED from every prompt vector: Whisper echoes its
    // initial_prompt back on near-silent audio, and rewrite LLMs occasionally re-emit the
    // "上一段" reference — both produced verbatim duplicated sentences in the inserted text.
    // The session transcript now lives client-side only, for dedupeAgainstSession.
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
        rewriteMode: config.rewriteMode,
        chineseVariant: config.chineseVariant,
        regionPreference: config.dashscopeRegion,
      });
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
      text = await this.api.transcribeGroq(apiKey, audioBase64, config.language, keywords);
    } else if (provider === 'openai') {
      const apiKey = await this.secrets.get('vibefox.openaiKey');
      if (apiKey === undefined) {
        throw new ApiError('unauthorized', 'OpenAI API Key 未设置，请运行「VibeFox: Set API Key」进行设置');
      }
      text = await this.api.transcribeOpenAI(apiKey, audioBase64, config.language, keywords);
    } else if (provider === 'aliyun') {
      const apiKey = await this.secrets.get('vibefox.aliyunKey');
      if (apiKey === undefined) {
        throw new ApiError('unauthorized', '阿里云 API Key 未设置，请运行「VibeFox: Set API Key」进行设置');
      }
      text = await this.api.transcribeAliyun(config.endpoint, apiKey, audioBase64, config.language, keywords);
    } else if (provider === 'custom') {
      if (!config.customEndpoint) {
        throw new Error('自定义服务地址 (vibefox.customEndpoint) 未配置');
      }
      text = await this.api.transcribeCustom(config.customEndpoint, audioBase64, config.language, keywords);
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

    const systemPrompt =
      (config.rewriteMode === 'rewrite' ? FALLBACK_REWRITE_PROMPT : FALLBACK_CLEAN_PROMPT) +
      CHINESE_VARIANT_SUFFIX[config.chineseVariant];

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
      chineseVariant: getWithFallback<ChineseVariant>('chineseVariant', 'simplified-cn'),
      dashscopeRegion: getWithFallback<RegionPreference>('dashscopeRegion', 'auto'),
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
