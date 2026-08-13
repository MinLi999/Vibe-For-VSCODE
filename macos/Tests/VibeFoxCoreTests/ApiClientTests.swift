import Foundation
import Testing
@testable import VibeFoxCore

/// Intercepts ApiClient's URLSession — no network. Static handler ⇒ tests must be serialized.
final class MockURLProtocol: URLProtocol {
    static var handler: ((URLRequest) -> (Int, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        guard let url = request.url, let handler = Self.handler else { return }
        let (status, data) = handler(request)
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
}

/// Every test anywhere in this test target that uses MockURLProtocol MUST live in this one
/// suite (as an extension, if declared in another file). `.serialized` only serializes tests
/// WITHIN a single suite — two different `@Suite(.serialized)` structs can still run
/// concurrently against each other, and since MockURLProtocol.handler is one shared static
/// closure, that race corrupts whichever test loses (see DirectProviderClientTests.swift's
/// extension for the BYOK network tests that share this suite for exactly that reason).
@Suite(.serialized)
struct MockedNetworkTests {
    private func client(status: Int, body: String) -> ApiClient {
        MockURLProtocol.handler = { _ in (status, Data(body.utf8)) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        return ApiClient(configuration: config)
    }

    private var request: TranscribeRequest {
        TranscribeRequest(audio: "QUJD", language: "auto", keywords: [], projectContext: nil,
                          rewriteMode: "clean", chineseVariant: "simplified-cn",
                          regionPreference: "auto", capturePeak: nil, appCategory: nil)
    }

    @Test func successDecodesV2Response() async throws {
        let api = client(status: 200, body: """
        {"text": "你好", "duration_ms": 1200, "rawText": "你好啊", "finalText": "你好",
         "tier": "quality", "engines": {"asr": "qwen3-asr-flash", "rewrite": "qwen-plus"},
         "timings": {"asr_ms": 800, "rewrite_ms": 300, "total_ms": 1200}}
        """)
        let result = try await api.transcribe(endpoint: "https://mock.test", licenseKey: "k", request: request)
        #expect(result.finalText == "你好")
        #expect(result.rawText == "你好啊")
        #expect(result.engines.asr == "qwen3-asr-flash")
    }

    @Test func statusCodesMapToTypedErrors() async {
        let cases: [(Int, (ApiError) -> Bool)] = [
            (401, { if case .unauthorized = $0 { return true }; return false }),
            (403, { if case .unauthorized = $0 { return true }; return false }),
            (413, { if case .payloadTooLarge = $0 { return true }; return false }),
            (429, { if case .rateLimited = $0 { return true }; return false }),
            (502, { if case .noSpeech = $0 { return true }; return false }),
        ]
        for (status, matches) in cases {
            let api = client(status: status, body: #"{"error": "x"}"#)
            do {
                _ = try await api.transcribe(endpoint: "https://mock.test", licenseKey: "k", request: request)
                Issue.record("\(status) should throw")
            } catch let error as ApiError {
                #expect(matches(error), "status \(status) mapped to \(error)")
            } catch {
                Issue.record("\(status) threw non-ApiError: \(error)")
            }
        }
    }

    @Test func serverErrorCarriesStatusAndMessage() async {
        let api = client(status: 500, body: #"{"error": "boom"}"#)
        do {
            _ = try await api.transcribe(endpoint: "https://mock.test", licenseKey: "k", request: request)
            Issue.record("should throw")
        } catch let ApiError.server(status, message) {
            #expect(status == 500)
            #expect(message == "boom")
        } catch {
            Issue.record("wrong error: \(error)")
        }
    }

    @Test func malformedSuccessBodyIsServerError() async {
        let api = client(status: 200, body: "not json at all")
        do {
            _ = try await api.transcribe(endpoint: "https://mock.test", licenseKey: "k", request: request)
            Issue.record("should throw")
        } catch let ApiError.server(status, _) {
            #expect(status == 200)
        } catch {
            Issue.record("wrong error: \(error)")
        }
    }

    @Test func requestCarriesAuthAndM4aFormat() async throws {
        var captured: URLRequest?
        MockURLProtocol.handler = { req in
            captured = req
            return (502, Data(#"{"error":"no speech"}"#.utf8))
        }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let api = ApiClient(configuration: config)
        _ = try? await api.transcribe(endpoint: "https://mock.test", licenseKey: "secret-key", request: request)
        let req = try #require(captured)
        #expect(req.value(forHTTPHeaderField: "Authorization") == "Bearer secret-key")
        #expect(req.url?.path == "/api/transcribe")
        // httpBody is consumed into a stream by URLSession; read it back via the stream.
        let bodyData = req.httpBody ?? (req.httpBodyStream.map { stream -> Data in
            stream.open()
            defer { stream.close() }
            var data = Data()
            let bufferSize = 4096
            let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
            defer { buffer.deallocate() }
            while stream.hasBytesAvailable {
                let read = stream.read(buffer, maxLength: bufferSize)
                if read <= 0 { break }
                data.append(buffer, count: read)
            }
            return data
        } ?? Data())
        let json = try #require(try JSONSerialization.jsonObject(with: bodyData) as? [String: Any])
        #expect(json["audioFormat"] as? String == "m4a")
    }
}
