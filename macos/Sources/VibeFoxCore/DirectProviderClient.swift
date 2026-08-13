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

    /// Alibaba Cloud DashScope paraformer-v2: async submit -> poll -> fetch transcript JSON.
    /// `baseEndpoint` empty uses the public DashScope domain; non-empty overrides it (e.g. a
    /// region-specific or proxied domain), matching the VS Code extension's `aliyun` provider.
    public func transcribeAliyun(baseEndpoint: String, apiKey: String, audioBase64: String, language: String) async throws -> String {
        var baseDomain = baseEndpoint.trimmingCharacters(in: .whitespaces)
        if baseDomain.isEmpty { baseDomain = "https://dashscope.aliyuncs.com" }
        while baseDomain.hasSuffix("/") { baseDomain.removeLast() }
        baseDomain = baseDomain.replacingOccurrences(of: "/compatible-mode/v1", with: "")
        if baseDomain.hasSuffix("/api/v1") { baseDomain.removeLast(7) }

        var submitRequest = URLRequest(url: URL(string: "\(baseDomain)/api/v1/services/audio/asr/transcription")!)
        submitRequest.httpMethod = "POST"
        submitRequest.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        submitRequest.setValue("enable", forHTTPHeaderField: "X-DashScope-Async")
        submitRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // paraformer-v2 has no 'auto' hint value; 'zh' covers zh/en code-switching here.
        let languageHint = (language == "auto" || language.isEmpty) ? "zh" : language
        submitRequest.httpBody = try JSONSerialization.data(withJSONObject: [
            "model": "paraformer-v2",
            "input": ["file_urls": ["data:audio/mp4;base64,\(audioBase64)"]],
            "parameters": ["language_hints": [languageHint]],
        ])

        let (submitData, submitResponse) = try await perform(submitRequest)
        guard (submitResponse as? HTTPURLResponse)?.statusCode == 200 else {
            throw ApiError.server((submitResponse as? HTTPURLResponse)?.statusCode ?? 0, "提交转写任务失败: \(Self.errorDetail(submitData))")
        }
        guard let taskId = (Self.jsonObject(submitData)?["output"] as? [String: Any])?["task_id"] as? String else {
            throw ApiError.server(200, "未获取到转写任务 ID")
        }

        let taskURL = URL(string: "\(baseDomain)/api/v1/tasks/\(taskId)")!
        var resultURLString: String?
        for _ in 0..<40 { // 40 * 200ms = 8s max poll window (matches the client's budget).
            try await Task.sleep(nanoseconds: 200_000_000)
            var pollRequest = URLRequest(url: taskURL)
            pollRequest.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
            guard let (pollData, pollResponse) = try? await perform(pollRequest),
                  (pollResponse as? HTTPURLResponse)?.statusCode == 200,
                  let output = Self.jsonObject(pollData)?["output"] as? [String: Any] else {
                continue // Transient poll failure — try again on the next tick.
            }
            let status = output["task_status"] as? String ?? "PENDING"
            if status == "SUCCEEDED" {
                let results = output["results"] as? [[String: Any]] ?? []
                resultURLString = results.first?["transcription_url"] as? String
                break
            } else if status == "FAILED" {
                throw ApiError.server(200, "转写任务失败: \(output["message"] as? String ?? "未知错误")")
            }
        }
        guard let resultURLString, let resultURL = URL(string: resultURLString) else {
            throw ApiError.timeout("转写任务处理超时,请重试")
        }

        let (resultData, resultResponse) = try await perform(URLRequest(url: resultURL))
        guard (resultResponse as? HTTPURLResponse)?.statusCode == 200 else {
            throw ApiError.server((resultResponse as? HTTPURLResponse)?.statusCode ?? 0, "获取转写文件失败")
        }
        let transcripts = (Self.jsonObject(resultData)?["transcripts"] as? [[String: Any]]) ?? []
        let text = transcripts
            .flatMap { ($0["sentences"] as? [[String: Any]]) ?? [] }
            .compactMap { $0["text"] as? String }
            .joined(separator: " ")
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

    /// Provider defaults matching the VS Code extension's built-in fallback models.
    public static func defaultRewriteModel(for provider: String) -> String {
        switch provider {
        case "groq": return "llama-3.3-70b-versatile"
        case "openai": return "gpt-4o-mini"
        case "aliyun": return "qwen-turbo"
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
    public func rewrite(baseURL: String, apiKey: String, model: String, text: String, keywords: [String], systemPrompt: String) async -> String {
        var trimmedBase = baseURL.trimmingCharacters(in: .whitespaces)
        while trimmedBase.hasSuffix("/") { trimmedBase.removeLast() }
        guard let url = URL(string: "\(trimmedBase)/chat/completions") else {
            return text
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
                ["role": "user", "content": "参考代码词表：\(keywords.joined(separator: ", "))\n\n待转写文本：\(text)"],
            ],
            "temperature": 0,
        ]) else {
            return text
        }
        request.httpBody = body

        guard let (data, response) = try? await perform(request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let choices = Self.jsonObject(data)?["choices"] as? [[String: Any]],
              let message = choices.first?["message"] as? [String: Any],
              let content = (message["content"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !content.isEmpty else {
            return text
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
