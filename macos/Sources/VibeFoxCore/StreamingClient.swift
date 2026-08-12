import Foundation

/// Native client for the Worker's /api/realtime WebSocket proxy (docs/04-STREAMING.md).
/// Wire protocol mirrors client/src/services/CloudflareApiService.openTranscriptionStream:
/// the license key travels as the second Sec-WebSocket-Protocol entry ("vibefox.v1, <key>"),
/// NEVER in the URL; upstream frames are a JSON "start", raw binary PCM16 chunks, and a JSON
/// "finish"; downstream events are ready / partial / segment / done / error.
public final class StreamingClient: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    public struct StartOptions: Encodable {
        public var type = "start"
        public var rewriteMode: String
        public var chineseVariant: String?
        public var appCategory: String?
        public var keywords: [String]
        public var language: String?
        public var vadSilenceMs: Int?

        public init(rewriteMode: String, chineseVariant: String?, appCategory: String?,
                    keywords: [String], language: String?, vadSilenceMs: Int?) {
            self.rewriteMode = rewriteMode
            self.chineseVariant = chineseVariant
            self.appCategory = appCategory
            self.keywords = keywords
            self.language = language
            self.vadSilenceMs = vadSilenceMs
        }
    }

    public enum Event: Sendable {
        case ready
        case partial(String)
        /// One finalized utterance: server-side non-speech filter + rewrite already applied.
        case segment(rawText: String, finalText: String)
        case done
        case error(String)
    }

    private let options: StartOptions
    /// Events are delivered on the main queue. `error` and `done` each fire at most once.
    private let onEvent: @Sendable (Event) -> Void

    private var session: URLSession!
    private var task: URLSessionWebSocketTask?
    private let stateQueue = DispatchQueue(label: "vibefox.streaming.state")
    private var opened = false
    private var failed = false
    private var finished = false
    private var pending: [Data] = []

    public init(endpoint: String, licenseKey: String, options: StartOptions, onEvent: @escaping @Sendable (Event) -> Void) throws {
        self.options = options
        self.onEvent = onEvent
        super.init()

        let base = endpoint.replacingOccurrences(of: "http", with: "ws", options: .anchored)
        guard let url = URL(string: base + "/api/realtime") else {
            throw ApiError.network("无效的服务地址:\(endpoint)")
        }
        session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
        let wsTask = session.webSocketTask(with: url, protocols: ["vibefox.v1", licenseKey])
        task = wsTask
        wsTask.resume()
        receiveLoop()
    }

    // MARK: outbound

    /// Queues a raw PCM16/16k mono chunk (buffered until the handshake completes).
    public func sendAudio(_ chunk: Data) {
        stateQueue.async { [weak self] in
            guard let self, !self.failed, !self.finished else { return }
            if self.opened {
                self.task?.send(.data(chunk)) { _ in /* Failures surface via the receive loop. */ }
            } else {
                self.pending.append(chunk)
            }
        }
    }

    /// Signals end of speech; the server flushes remaining segments then emits done.
    public func finish() {
        stateQueue.async { [weak self] in
            guard let self, self.opened, !self.failed, !self.finished else { return }
            self.task?.send(.string(#"{"type":"finish"}"#)) { _ in }
        }
    }

    /// Deliberate abort — no more events after this.
    public func close() {
        stateQueue.async { [weak self] in
            guard let self else { return }
            self.finished = true
            self.task?.cancel(with: .normalClosure, reason: nil)
            self.session.invalidateAndCancel()
        }
    }

    // MARK: inbound

    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        stateQueue.async { [weak self] in
            guard let self, !self.failed, !self.finished else { return }
            self.opened = true
            if let start = try? JSONEncoder().encode(self.options), let json = String(data: start, encoding: .utf8) {
                webSocketTask.send(.string(json)) { _ in }
            }
            for chunk in self.pending {
                webSocketTask.send(.data(chunk)) { _ in }
            }
            self.pending = []
        }
    }

    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                           didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        fail("流式转写连接中断")
    }

    private func receiveLoop() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure:
                self.fail("流式转写连接失败")
            case .success(let message):
                if case .string(let text) = message {
                    self.handle(text)
                }
                self.receiveLoop()
            }
        }
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let msg = try? JSONDecoder().decode(ServerFrame.self, from: data) else { return }
        switch msg.type {
        case "ready":
            emit(.ready)
        case "partial":
            emit(.partial(msg.text ?? ""))
        case "segment":
            emit(.segment(rawText: msg.rawText ?? "", finalText: msg.finalText ?? msg.rawText ?? ""))
        case "done":
            stateQueue.async { [weak self] in self?.finished = true }
            emit(.done)
        case "error":
            fail(msg.message ?? "流式转写服务端错误")
        default:
            break
        }
    }

    private func fail(_ message: String) {
        stateQueue.async { [weak self] in
            guard let self, !self.failed, !self.finished else { return }
            self.failed = true
            self.task?.cancel(with: .normalClosure, reason: nil)
            self.emit(.error(message))
        }
    }

    private func emit(_ event: Event) {
        let onEvent = onEvent
        DispatchQueue.main.async { onEvent(event) }
    }
}

private struct ServerFrame: Decodable {
    var type: String
    var text: String?
    var rawText: String?
    var finalText: String?
    var message: String?
}
