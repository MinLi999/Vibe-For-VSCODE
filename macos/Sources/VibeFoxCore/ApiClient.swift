import Foundation

/// Protocol v2 client for the Cloudflare Worker (same wire format as the TS clients).
public struct TranscribeRequest: Encodable {
    public var audio: String
    /// Native build uploads AAC (macOS has no MP3 encoder); server maps the MIME for Qwen.
    public var audioFormat = "m4a"
    public var language: String
    public var keywords: [String]
    public var projectContext: String?
    public var rewriteMode: String
    public var chineseVariant: String
    public var regionPreference: String
    public var capturePeak: Int?
    public var appCategory: String?

    public init(audio: String, language: String, keywords: [String], projectContext: String?,
                rewriteMode: String, chineseVariant: String, regionPreference: String,
                capturePeak: Int?, appCategory: String?) {
        self.audio = audio
        self.language = language
        self.keywords = keywords
        self.projectContext = projectContext
        self.rewriteMode = rewriteMode
        self.chineseVariant = chineseVariant
        self.regionPreference = regionPreference
        self.capturePeak = capturePeak
        self.appCategory = appCategory
    }
}

public struct TranscribeResult: Decodable {
    public var rawText: String
    public var finalText: String
    public var tier: String
    public var engines: Engines
    public var timings: Timings
    /// Downgrade reason codes when a server-side engine fell back (e.g. "dashscope_timeout",
    /// "dashscope_empty_result") — the key evidence when hunting intermittent quality drops.
    public var fallback: Fallback?

    public struct Engines: Decodable {
        public var asr: String
        public var rewrite: String
    }

    public struct Timings: Decodable {
        public var total_ms: Int
    }

    public struct Fallback: Decodable {
        public var asr: String?
        public var rewrite: String?
    }
}

public enum ApiError: Error, LocalizedError {
    /// 401/403 — invalid or missing license key.
    case unauthorized
    /// 413 — recording too long for the tier's payload cap.
    case payloadTooLarge
    /// 429 — per-key rate limit.
    case rateLimited
    /// 502 — the ASR heard no speech (a NORMAL outcome for silence, not a failure).
    case noSpeech
    case server(Int, String)
    case network(String)
    /// Request timeout (distinct from a generic network failure — matches the VS Code
    /// extension's ApiErrorKind, used by BYOK direct-provider calls).
    case timeout(String)

    public var errorDescription: String? {
        switch self {
        case .unauthorized: return "License Key 无效或已失效,请重新设置。"
        case .payloadTooLarge: return "录音过长,超出当前档位的载荷上限。"
        case .rateLimited: return "请求过于频繁,请稍候几秒再试。"
        case .noSpeech: return "未识别到语音,请重试。"
        case .server(let status, let message): return "服务端错误(\(status)):\(message)"
        case .network(let message): return "网络错误:\(message)"
        case .timeout(let message): return "请求超时:\(message)"
        }
    }

    /// Short machine-readable code for diagnostics and pending-audio entries.
    public var reasonCode: String {
        switch self {
        case .unauthorized: return "unauthorized"
        case .payloadTooLarge: return "payload_too_large"
        case .rateLimited: return "rate_limited"
        case .noSpeech: return "no_speech"
        case .timeout: return "timeout"
        case .network: return "network"
        case .server(let status, _): return "server_\(status)"
        }
    }

    /// Whether re-sending the SAME audio can plausibly succeed. Auth/payload failures won't
    /// improve; transient transport/engine failures will. `no_speech` is the special case this
    /// whole classification exists for: high capture peak = real audio the engines misread
    /// (retryable); low peak = it genuinely was silence (don't burn a retry).
    public func isRetryable(capturePeak: Int) -> Bool {
        switch self {
        case .timeout, .network, .rateLimited, .server:
            return true
        case .noSpeech:
            return capturePeak > 1000
        case .unauthorized, .payloadTooLarge:
            return false
        }
    }
}

public final class ApiClient {
    private let session: URLSession

    /// `configuration` is injectable so tests can register a mock URLProtocol.
    public init(configuration: URLSessionConfiguration = .ephemeral) {
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = 60
        session = URLSession(configuration: configuration)
    }

    public func transcribe(endpoint: String, licenseKey: String, request body: TranscribeRequest) async throws -> TranscribeResult {
        guard let url = URL(string: endpoint + "/api/transcribe") else {
            throw ApiError.network("无效的服务地址:\(endpoint)")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(licenseKey)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONEncoder().encode(body)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw ApiError.network(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else {
            throw ApiError.network("非 HTTP 响应")
        }
        switch http.statusCode {
        case 200:
            do {
                return try JSONDecoder().decode(TranscribeResult.self, from: data)
            } catch {
                throw ApiError.server(200, "响应格式异常")
            }
        case 401, 403:
            throw ApiError.unauthorized
        case 413:
            throw ApiError.payloadTooLarge
        case 429:
            throw ApiError.rateLimited
        case 502:
            throw ApiError.noSpeech
        default:
            let message = (try? JSONDecoder().decode([String: String].self, from: data))?["error"] ?? ""
            throw ApiError.server(http.statusCode, message)
        }
    }
}
