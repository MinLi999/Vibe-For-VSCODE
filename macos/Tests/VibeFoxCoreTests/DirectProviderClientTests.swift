import Foundation
import Testing
@testable import VibeFoxCore

// MARK: pure logic (no network)

@Test func whisperPromptCapsAtEightHundredBytesKeepingEarlyKeywords() {
    let short = DirectProviderClient.buildWhisperPrompt(keywords: ["useEffect", "DashScope"])
    #expect(short.contains("useEffect"))
    #expect(short.contains("DashScope"))
    #expect(short.hasPrefix("好的，我现在打开了项目"))

    // A huge keyword list must not blow the 800-byte budget; early entries win.
    let many = (0..<200).map { "关键字\($0)VeryLongIdentifierName" }
    let prompt = DirectProviderClient.buildWhisperPrompt(keywords: many)
    #expect(prompt.utf8.count <= 800)
    #expect(prompt.contains("关键字0VeryLongIdentifierName"))
    #expect(!prompt.contains("关键字199VeryLongIdentifierName"))
}

@Test func whisperPromptEmptyForNoKeywords() {
    #expect(DirectProviderClient.buildWhisperPrompt(keywords: []).isEmpty)
}

@Test func chatBaseURLPerProvider() {
    #expect(DirectProviderClient.chatBaseURL(for: "groq", customEndpoint: "") == "https://api.groq.com/openai/v1")
    #expect(DirectProviderClient.chatBaseURL(for: "openai", customEndpoint: "") == "https://api.openai.com/v1")
    #expect(DirectProviderClient.chatBaseURL(for: "aliyun", customEndpoint: "") == "https://dashscope.aliyuncs.com/compatible-mode/v1")
    #expect(DirectProviderClient.chatBaseURL(for: "custom", customEndpoint: "https://x.example.com") == "https://x.example.com")
    #expect(DirectProviderClient.chatBaseURL(for: "custom", customEndpoint: "") == nil) // No endpoint configured.
    #expect(DirectProviderClient.chatBaseURL(for: "cloudflare", customEndpoint: "") == nil) // Not a BYOK provider.
}

@Test func defaultRewriteModelPerProvider() {
    #expect(DirectProviderClient.defaultRewriteModel(for: "groq") == "llama-3.3-70b-versatile")
    #expect(DirectProviderClient.defaultRewriteModel(for: "openai") == "gpt-4o-mini")
    #expect(DirectProviderClient.defaultRewriteModel(for: "aliyun") == "qwen-turbo")
}

@Test func rewriteSystemPromptSelectsModeAndVariant() {
    let clean = RewritePrompts.systemPrompt(rewriteMode: "clean", chineseVariant: "simplified-cn")
    #expect(clean.hasPrefix(RewritePrompts.clean))
    let rewrite = RewritePrompts.systemPrompt(rewriteMode: "rewrite", chineseVariant: "traditional-tw")
    #expect(rewrite.hasPrefix(RewritePrompts.rewrite))
    // The instruction TEXT is simplified (matches server/src/prompts.ts's wording verbatim);
    // it instructs the model to output traditional characters, it isn't itself written in them.
    #expect(rewrite.contains("台湾正体")) // Traditional-TW suffix appended.
}

@Test func apiProviderWhitelistHealsUnknownValue() {
    var config = AppConfig.default
    config.apiProvider = "not-a-real-provider"
    config.normalize()
    #expect(config.apiProvider == "cloudflare")
    for valid in AppConfig.apiProviders {
        var c = AppConfig.default
        c.apiProvider = valid
        c.normalize()
        #expect(c.apiProvider == valid)
    }
}

// MARK: network paths (mock URLProtocol) — extends MockedNetworkTests (ApiClientTests.swift)
// so these run serialized against every other MockURLProtocol.handler user; see that suite's
// doc comment for why a second `@Suite(.serialized)` struct here would NOT be safe.

extension MockedNetworkTests {
    private func directClient(status: Int, body: String) -> DirectProviderClient {
        MockURLProtocol.handler = { _ in (status, Data(body.utf8)) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        return DirectProviderClient(configuration: config)
    }

    @Test func transcribeOpenAICompatibleParsesTextField() async throws {
        let client = directClient(status: 200, body: #"{"text": "你好世界"}"#)
        let text = try await client.transcribeGroq(apiKey: "k", audioBase64: "QUJD", language: "auto", keywords: [])
        #expect(text == "你好世界")
    }

    @Test func transcribeOpenAICompatibleThrowsOnErrorStatus() async {
        let client = directClient(status: 401, body: #"{"error": {"message": "invalid api key"}}"#)
        do {
            _ = try await client.transcribeOpenAI(apiKey: "bad", audioBase64: "QUJD", language: "auto", keywords: [])
            Issue.record("should throw")
        } catch let ApiError.server(status, message) {
            #expect(status == 401)
            #expect(message == "invalid api key")
        } catch {
            Issue.record("wrong error type: \(error)")
        }
    }

    @Test func transcribeCustomRoundTrips() async throws {
        var captured: URLRequest?
        MockURLProtocol.handler = { req in
            captured = req
            return (200, Data(#"{"text": "custom result"}"#.utf8))
        }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let client = DirectProviderClient(configuration: config)
        let text = try await client.transcribeCustom(endpoint: "https://mock.test/transcribe", audioBase64: "QUJD", language: "auto", keywords: ["Claude"])
        #expect(text == "custom result")
        #expect(captured?.value(forHTTPHeaderField: "Content-Type") == "application/json")
        // No Authorization header — custom endpoints handle their own auth.
        #expect(captured?.value(forHTTPHeaderField: "Authorization") == nil)
    }

    @Test func rewriteFallsBackToOriginalTextOnFailure() async {
        let client = directClient(status: 500, body: "server error")
        let result = await client.rewrite(baseURL: "https://mock.test", apiKey: "k", model: "m", text: "原文不变", keywords: [], systemPrompt: "sys")
        #expect(result == "原文不变") // Never blocks delivery on a broken BYOK rewrite.
    }

    @Test func rewriteReturnsChatCompletionContent() async {
        let client = directClient(status: 200, body: #"{"choices": [{"message": {"content": "改写后的文本"}}]}"#)
        let result = await client.rewrite(baseURL: "https://mock.test", apiKey: "k", model: "m", text: "原文", keywords: [], systemPrompt: "sys")
        #expect(result == "改写后的文本")
    }
}
