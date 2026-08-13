import Foundation

/// config.json — the SAME file, same schema, as the Electron build (users can switch builds
/// freely). Unknown/missing fields heal to defaults on load; the merged file is written back
/// so users always have a complete document to hand-edit.
///
/// Note: `ffmpegPath`/`audioDevice` are Electron-era fields the native build no longer uses
/// (AVAudioEngine replaces ffmpeg); they are preserved for round-trip compatibility.
public struct AppConfig: Codable, Equatable {
    public var endpoint: String
    /// Electron accelerator string (e.g. "Command+Alt+Z") — format kept for file compatibility;
    /// see Hotkey.parse for the native mapping.
    public var hotkey: String
    public var language: String
    public var maxRecordSeconds: Int
    public var ffmpegPath: String
    public var audioDevice: String
    public var vadEnabled: Bool
    public var vadSilenceMs: Int
    public var vadMinDurationMs: Int
    public var vadSilenceThreshold: Int
    public var vadAdaptiveThreshold: Bool
    public var rewriteMode: String
    public var chineseVariant: String
    public var dashscopeRegion: String
    public var restoreClipboard: Bool
    public var streamingMode: Bool
    public var onboardingDone: Bool
    public var vocabulary: [String]
    public var projectContext: String
    /// "cloudflare" (default: the hosted/self-hosted Worker at `endpoint`) or a direct BYOK
    /// provider ("groq" | "openai" | "aliyun" | "custom") that skips the Worker entirely —
    /// see DirectProviderClient.swift. Mirrors the VS Code extension's `vibefox.apiProvider`.
    public var apiProvider: String
    /// Required for `custom` (transcription POST endpoint); optional override base URL for
    /// `aliyun` (empty = dashscope.aliyuncs.com default). Unused by other providers.
    public var customEndpoint: String
    /// Optional model override for the BYOK rewrite (clean/rewrite) chat-completions call.
    /// Empty = each provider's built-in default model.
    public var llmCorrectionModel: String

    // Custom domain (api.vibefox.app) bound 2026-08-13; the workers.dev URL keeps routing to
    // the same Worker indefinitely (server/wrangler.jsonc keeps workers_dev:true) so this
    // switch doesn't strand anyone still pointed at the old default.
    public static let officialHostedEndpoint = "https://api.vibefox.app"
    /// Pre-custom-domain default, still materialized in existing installs' config.json.
    static let legacyHostedEndpoint = "https://vibe-voice-worker.presley-us.workers.dev"

    public static let rewriteModes = ["off", "clean", "rewrite"]
    public static let chineseVariants = ["simplified-cn", "simplified-sg-my", "traditional-tw", "traditional-hk-mo"]
    public static let regions = ["auto", "apac", "us"]
    public static let apiProviders = ["cloudflare", "groq", "openai", "aliyun", "custom"]

    /// Accelerators macOS reserves as system shortcuts (registration "succeeds" but never fires).
    public static let reservedHotkeys: Set<String> = [
        "Control+Space", "Control+Alt+Space", "Command+Space",
        "Command+Alt+Space", "Control+Command+Space", "Control+Shift+Space",
    ]

    public static let `default` = AppConfig(
        endpoint: officialHostedEndpoint,
        hotkey: "Command+Alt+Z",
        language: "auto",
        maxRecordSeconds: 120,
        ffmpegPath: "",
        audioDevice: "",
        vadEnabled: true,
        vadSilenceMs: 1200,
        vadMinDurationMs: 3000,
        vadSilenceThreshold: 350,
        vadAdaptiveThreshold: true,
        rewriteMode: "clean",
        chineseVariant: "simplified-cn",
        dashscopeRegion: "auto",
        restoreClipboard: true,
        streamingMode: false,
        onboardingDone: false,
        apiProvider: "cloudflare",
        customEndpoint: "",
        llmCorrectionModel: "",
        vocabulary: [
            "Claude Code", "Claude", "Anthropic", "Cloudflare", "Cloudflare Workers",
            "DashScope", "Qwen", "VibeFox", "GitHub", "Vercel", "Supabase",
            "TypeScript", "JavaScript", "Python", "Node.js", "React", "Next.js",
            "Vite", "Tailwind CSS", "Electron", "Docker", "PostgreSQL", "Redis",
            "JSON", "Markdown", "API", "npm", "webhook", "endpoint",
        ],
        projectContext: "用户是程序员,正在用语音向 AI 编程助手(如 Claude Code)口述编程指令。"
            + "内容为中英混杂的技术表达,包含大量代码标识符、函数名、文件名、命令行、产品与技术专有名词。"
    )

    /// Lenient decode: every missing/mistyped field falls back to its default.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = AppConfig.default
        // `try?` over decodeIfPresent yields a doubly-optional value; flatten both layers.
        func field<T: Decodable>(_ key: CodingKeys, _ fallback: T) -> T {
            ((try? c.decodeIfPresent(T.self, forKey: key)) ?? nil) ?? fallback
        }
        endpoint = field(.endpoint, d.endpoint)
        hotkey = field(.hotkey, d.hotkey)
        language = field(.language, d.language)
        maxRecordSeconds = field(.maxRecordSeconds, d.maxRecordSeconds)
        ffmpegPath = field(.ffmpegPath, d.ffmpegPath)
        audioDevice = field(.audioDevice, d.audioDevice)
        vadEnabled = field(.vadEnabled, d.vadEnabled)
        vadSilenceMs = field(.vadSilenceMs, d.vadSilenceMs)
        vadMinDurationMs = field(.vadMinDurationMs, d.vadMinDurationMs)
        vadSilenceThreshold = field(.vadSilenceThreshold, d.vadSilenceThreshold)
        vadAdaptiveThreshold = field(.vadAdaptiveThreshold, d.vadAdaptiveThreshold)
        rewriteMode = field(.rewriteMode, d.rewriteMode)
        chineseVariant = field(.chineseVariant, d.chineseVariant)
        dashscopeRegion = field(.dashscopeRegion, d.dashscopeRegion)
        restoreClipboard = field(.restoreClipboard, d.restoreClipboard)
        streamingMode = field(.streamingMode, d.streamingMode)
        onboardingDone = field(.onboardingDone, d.onboardingDone)
        apiProvider = field(.apiProvider, d.apiProvider)
        customEndpoint = field(.customEndpoint, d.customEndpoint)
        llmCorrectionModel = field(.llmCorrectionModel, d.llmCorrectionModel)
        vocabulary = field(.vocabulary, d.vocabulary)
        projectContext = field(.projectContext, d.projectContext)
        normalize()
    }

    public init(
        endpoint: String, hotkey: String, language: String, maxRecordSeconds: Int,
        ffmpegPath: String, audioDevice: String, vadEnabled: Bool, vadSilenceMs: Int,
        vadMinDurationMs: Int, vadSilenceThreshold: Int, vadAdaptiveThreshold: Bool,
        rewriteMode: String, chineseVariant: String, dashscopeRegion: String,
        restoreClipboard: Bool, streamingMode: Bool, onboardingDone: Bool,
        apiProvider: String, customEndpoint: String, llmCorrectionModel: String,
        vocabulary: [String], projectContext: String
    ) {
        self.endpoint = endpoint
        self.hotkey = hotkey
        self.language = language
        self.maxRecordSeconds = maxRecordSeconds
        self.ffmpegPath = ffmpegPath
        self.audioDevice = audioDevice
        self.vadEnabled = vadEnabled
        self.vadSilenceMs = vadSilenceMs
        self.vadMinDurationMs = vadMinDurationMs
        self.vadSilenceThreshold = vadSilenceThreshold
        self.vadAdaptiveThreshold = vadAdaptiveThreshold
        self.rewriteMode = rewriteMode
        self.chineseVariant = chineseVariant
        self.dashscopeRegion = dashscopeRegion
        self.restoreClipboard = restoreClipboard
        self.streamingMode = streamingMode
        self.onboardingDone = onboardingDone
        self.apiProvider = apiProvider
        self.customEndpoint = customEndpoint
        self.llmCorrectionModel = llmCorrectionModel
        self.vocabulary = vocabulary
        self.projectContext = projectContext
    }

    /// Migrations + clamps shared with the Electron loader: reserved-hotkey auto-heal,
    /// the historical `zh` default → `auto`, record-length bounds, enum whitelists.
    public mutating func normalize() {
        maxRecordSeconds = min(600, max(3, maxRecordSeconds))
        if AppConfig.reservedHotkeys.contains(hotkey) { hotkey = AppConfig.default.hotkey }
        if language == "zh" { language = "auto" }
        if !AppConfig.rewriteModes.contains(rewriteMode) { rewriteMode = AppConfig.default.rewriteMode }
        if !AppConfig.chineseVariants.contains(chineseVariant) { chineseVariant = AppConfig.default.chineseVariant }
        if !AppConfig.regions.contains(dashscopeRegion) { dashscopeRegion = AppConfig.default.dashscopeRegion }
        if !AppConfig.apiProviders.contains(apiProvider) { apiProvider = AppConfig.default.apiProvider }
        endpoint = endpoint.trimmingCharacters(in: .whitespaces)
        while endpoint.hasSuffix("/") { endpoint.removeLast() }
        if endpoint.isEmpty { endpoint = AppConfig.officialHostedEndpoint }
        // Auto-migrate the pre-custom-domain default (a constant change alone never reaches
        // installs whose config.json already has the old URL materialized on disk).
        if endpoint == AppConfig.legacyHostedEndpoint { endpoint = AppConfig.officialHostedEndpoint }
    }
}

public enum ConfigStore {
    public static func load(from dir: URL = AppPaths.userDataDir) -> AppConfig {
        var config: AppConfig
        if let data = try? Data(contentsOf: dir.appendingPathComponent("config.json")),
           let decoded = try? JSONDecoder().decode(AppConfig.self, from: data) {
            config = decoded
        } else {
            config = .default
        }
        config.normalize()
        save(config, to: dir) // Materialize the complete, migrated document (same behavior as Electron).
        return config
    }

    public static func save(_ config: AppConfig, to dir: URL = AppPaths.userDataDir) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        if let data = try? encoder.encode(config), let json = String(data: data, encoding: .utf8) {
            try? (json + "\n").write(to: dir.appendingPathComponent("config.json"), atomically: true, encoding: .utf8)
        }
    }
}
