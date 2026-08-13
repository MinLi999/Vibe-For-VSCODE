import Foundation

/// BYOK transcription + rewrite: calls a provider's API directly, bypassing the Cloudflare
/// Worker entirely. Ported line-for-line from client/src/services/CloudflareApiService.ts's
/// transcribeGroq/transcribeOpenAI/transcribeAliyun/transcribeCustom + the client's built-in
/// fallback clean/rewrite prompts (server/src/prompts.ts is private — these prompts are the
/// same "safe" fallback the VS Code extension ships for non-Cloudflare providers).
public final class DirectProviderClient {
    private let session: URLSession

    public init(configuration: URLSessionConfiguration = .ephemeral) {
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = 60
        session = URLSession(configuration: configuration)
    }

    // MARK: transcription

    public func transcribeGroq(apiKey: String, audioBase64: String, language: String, keywords: [String]) async throws -> String {
        try await transcribeOpenAICompatible(
            url: "https://api.groq.com/openai/v1/audio/transcriptions",
            apiKey: apiKey, model: "whisper-large-v3", audioBase64: audioBase64, language: language, keywords: keywords
        )
    }

    public func transcribeOpenAI(apiKey: String, audioBase64: String, language: String, keywords: [String]) async throws -> String {
        try await transcribeOpenAICompatible(
            url: "https://api.openai.com/v1/audio/transcriptions",
            apiKey: apiKey, model: "whisper-1", audioBase64: audioBase64, language: language, keywords: keywords
        )
    }

    /// Whisper multipart upload shared by Groq and OpenAI. `keywords` become Whisper's
    /// `prompt` field framed as preceding transcript text (Whisper treats prompt as context,
    /// not instructions) — capped at 800 UTF-8 bytes, same budget as the server's Whisper path.
    private func transcribeOpenAICompatible(url: String, apiKey: String, model: String, audioBase64: String, language: String, keywords: [String]) async throws -> String {
        guard let audio = Data(base64Encoded: audioBase64) else {
            throw ApiError.network("音频编码无效")
        }
        let boundary = "vibefox-\(UUID().uuidString)"
        var body = Data()
        func appendField(_ name: String, _ value: String) {
            body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n")
        }
        body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio.m4a\"\r\nContent-Type: audio/mp4\r\n\r\n")
        body.append(audio)
        body.append("\r\n")
        appendField("model", model)
        // 'auto' = omit the field so Whisper self-detects (mixed zh/en dictation).
        if language != "auto" && !language.isEmpty {
            appendField("language", language)
        }
        appendField("temperature", "0")
        let prompt = Self.buildWhisperPrompt(keywords: keywords)
        if !prompt.isEmpty {
            appendField("prompt", prompt)
        }
        body.append("--\(boundary)--\r\n")

        var request = URLRequest(url: URL(string: url)!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = body

        let (data, response) = try await perform(request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw ApiError.server((response as? HTTPURLResponse)?.statusCode ?? 0, Self.errorDetail(data))
        }
        guard let text = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["text"] as? String else {
            throw ApiError.server(200, "转写响应中没有包含 text 字段")
        }
        return text
    }

    static func buildWhisperPrompt(keywords: [String]) -> String {
        guard !keywords.isEmpty else { return "" }
        let prefix = "好的，我现在打开了项目。刚才看了一下代码，里面用到了 "
        let suffix = " 这些。现在我要开始说一下修改思路。"
        let maxBytes = 800
        var keywordsPart = ""
        for (i, word) in keywords.enumerated() {
            let sep = i == 0 ? "" : "、"
            let candidate = keywordsPart + sep + word
            if (prefix + candidate + suffix).utf8.count > maxBytes { break }
            keywordsPart = candidate
        }
        return keywordsPart.isEmpty ? "" : prefix + keywordsPart + suffix
    }

    /// Qwen3-ASR-Flash via DashScope's synchronous multimodal-generation endpoint — the SAME
    /// engine and endpoint the Worker's quality tier uses (server/src/engines/qwenAsr.ts),
    /// called directly with the user's own key instead of through the Worker. No fallback to
    /// a weaker engine: `qwen3-asr-flash` is confirmed available on the domestic
    /// `dashscope.aliyuncs.com` domain (help.aliyun.com/zh/model-studio/qwen-asr-api-reference),
    /// so mainland users reach it without crossing the Worker or the international routing at
    /// all — this is the whole point of BYOK for mainland reachability.
    /// `baseEndpoint` empty uses the public domestic domain; non-empty overrides it.
    /// `contextWords` bias recognition via a system message (same mechanism as the Worker);
    /// callers MUST run the result through NonSpeechFilter.isContextEcho before trusting it.
    public func transcribeAliyun(baseEndpoint: String, apiKey: String, audioBase64: String, language: String, contextWords: [String] = []) async throws -> String {
        var baseDomain = baseEndpoint.trimmingCharacters(in: .whitespaces)
        if baseDomain.isEmpty { baseDomain = "https://dashscope.aliyuncs.com" }
        while baseDomain.hasSuffix("/") { baseDomain.removeLast() }
        baseDomain = baseDomain.replacingOccurrences(of: "/compatible-mode/v1", with: "")
        if baseDomain.hasSuffix("/api/v1") { baseDomain.removeLast(7) }

        var request = URLRequest(url: URL(string: "\(baseDomain)/api/v1/services/aigc/multimodal-generation/generation")!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let context = contextWords.joined(separator: ", ")
        var messages: [[String: Any]] = []
        if !context.isEmpty {
            messages.append(["role": "system", "content": [["text": context]]])
        }
        messages.append(["role": "user", "content": [["audio": "data:audio/mp4;base64,\(audioBase64)"]]])
        var asrOptions: [String: Any] = ["enable_itn": true]
        if language != "auto" && !language.isEmpty {
            asrOptions["language"] = language
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "model": "qwen3-asr-flash",
            "input": ["messages": messages],
            "parameters": ["asr_options": asrOptions],
        ])

        let (data, response) = try await perform(request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw ApiError.server((response as? HTTPURLResponse)?.statusCode ?? 0, Self.errorDetail(data))
        }
        guard let output = Self.jsonObject(data)?["output"] as? [String: Any],
              let choices = output["choices"] as? [[String: Any]],
              let content = choices.first?["message"] as? [String: Any],
              let items = content["content"] as? [[String: Any]],
              let text = items.compactMap({ $0["text"] as? String }).first else {
            throw ApiError.server(200, "转写响应格式异常")
        }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Custom self-hosted endpoint: POST {audio, language, keywords} -> {text}.
    public func transcribeCustom(endpoint: String, audioBase64: String, language: String, keywords: [String]) async throws -> String {
        var trimmed = endpoint.trimmingCharacters(in: .whitespaces)
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        guard let url = URL(string: trimmed) else {
            throw ApiError.network("无效的自定义服务地址:\(endpoint)")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["audio": audioBase64, "language": language, "keywords": keywords])

        let (data, response) = try await perform(request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw ApiError.server((response as? HTTPURLResponse)?.statusCode ?? 0, "HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)")
        }
        guard let text = Self.jsonObject(data)?["text"] as? String else {
            throw ApiError.server(200, "自定义服务返回中缺少 text 字段")
        }
        return text
    }

    // MARK: rewrite (clean/rewrite for non-Cloudflare providers)

    /// Default rewrite model per provider. aliyun matches the hosted Worker's quality-tier
    /// engine (qwen-plus, server/wrangler.jsonc QWEN_REWRITE_MODEL) — BYOK aliyun promises
    /// "same quality as hosted", and the old qwen-turbo default quietly broke that promise.
    public static func defaultRewriteModel(for provider: String) -> String {
        switch provider {
        case "groq": return "llama-3.3-70b-versatile"
        case "openai": return "gpt-4o-mini"
        case "aliyun": return "qwen-plus"
        default: return ""
        }
    }

    public static func chatBaseURL(for provider: String, customEndpoint: String) -> String? {
        switch provider {
        case "groq": return "https://api.groq.com/openai/v1"
        case "openai": return "https://api.openai.com/v1"
        case "aliyun": return "https://dashscope.aliyuncs.com/compatible-mode/v1"
        case "custom": return customEndpoint.isEmpty ? nil : customEndpoint
        default: return nil
        }
    }

    /// OpenAI-compatible /chat/completions rewrite call. On any failure this returns the
    /// ORIGINAL text unchanged (matches the client's behavior: a broken BYOK rewrite must
    /// never block delivery of the raw transcription).
    /// `userMessage` is pre-built by the caller (RewritePrompts.buildUserMessage) so this stays
    /// a thin transport — it never constructs prompt content itself. Returns `fallbackText`
    /// (the raw transcription) on ANY failure so a broken BYOK rewrite never blocks delivery.
    public func rewrite(baseURL: String, apiKey: String, model: String, userMessage: String, systemPrompt: String, fallbackText: String) async -> String {
        var trimmedBase = baseURL.trimmingCharacters(in: .whitespaces)
        while trimmedBase.hasSuffix("/") { trimmedBase.removeLast() }
        guard let url = URL(string: "\(trimmedBase)/chat/completions") else {
            return fallbackText
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if !apiKey.isEmpty {
            request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        }
        guard let body = try? JSONSerialization.data(withJSONObject: [
            "model": model,
            "messages": [
                ["role": "system", "content": systemPrompt],
                ["role": "user", "content": userMessage],
            ],
            "temperature": 0,
        ]) else {
            return fallbackText
        }
        request.httpBody = body

        guard let (data, response) = try? await perform(request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let choices = Self.jsonObject(data)?["choices"] as? [[String: Any]],
              let message = choices.first?["message"] as? [String: Any],
              let content = (message["content"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !content.isEmpty else {
            return fallbackText
        }
        return content
    }

    // MARK: shared helpers

    private func perform(_ request: URLRequest) async throws -> (Data, URLResponse) {
        do {
            return try await session.data(for: request)
        } catch {
            if (error as NSError).code == NSURLErrorTimedOut {
                throw ApiError.timeout("请求超时")
            }
            throw ApiError.network(error.localizedDescription)
        }
    }

    private static func jsonObject(_ data: Data) -> [String: Any]? {
        try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    private static func errorDetail(_ data: Data) -> String {
        if let obj = jsonObject(data) {
            if let message = obj["message"] as? String { return message }
            if let err = obj["error"] as? [String: Any], let message = err["message"] as? String { return message }
        }
        return "unknown error"
    }
}

extension Data {
    mutating func append(_ string: String) {
        if let d = string.data(using: .utf8) { append(d) }
    }
}
