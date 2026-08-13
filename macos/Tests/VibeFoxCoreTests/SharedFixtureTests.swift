import Foundation
import Testing
@testable import VibeFoxCore

/// Cross-implementation contract tests: the SAME fixture files that server/src (TS original)
/// and client/src (TS copy) run against. This is the professional answer to this repo's
/// special risk — three hand-synced ports of the same logic (TS server / TS client / Swift):
/// a behavioral divergence now fails a suite instead of shipping silently.
/// Fixtures live at <repo>/shared/fixtures/, resolved relative to this source file.
private func fixtureURL(_ name: String) -> URL {
    URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // -> Tests/VibeFoxCoreTests/
        .deletingLastPathComponent() // -> Tests/
        .deletingLastPathComponent() // -> macos/
        .deletingLastPathComponent() // -> repo root
        .appendingPathComponent("shared/fixtures/\(name)")
}

private struct NonSpeechFixtures: Decodable {
    struct TranscriptCase: Decodable {
        let text: String
        let expect: Bool
        let why: String
    }

    struct EchoCase: Decodable {
        let text: String
        let words: [String]
        let expect: Bool
        let why: String
    }

    let isNonSpeechTranscript: [TranscriptCase]
    let isContextEcho: [EchoCase]
}

private struct DedupeFixtures: Decodable {
    struct Case: Decodable {
        let prev: String
        let text: String
        let expect: String
        let why: String
    }

    let cases: [Case]
}

@Test func nonSpeechFilterAgreesWithEverySharedCase() throws {
    let data = try Data(contentsOf: fixtureURL("nonspeech-cases.json"))
    let fixtures = try JSONDecoder().decode(NonSpeechFixtures.self, from: data)
    #expect(fixtures.isNonSpeechTranscript.count >= 20) // The file went missing/empty? Fail loudly.
    for c in fixtures.isNonSpeechTranscript {
        #expect(NonSpeechFilter.isNonSpeechTranscript(c.text) == c.expect, "\(c.why): \(c.text)")
    }
}

@Test func contextEchoAgreesWithEverySharedCase() throws {
    let data = try Data(contentsOf: fixtureURL("nonspeech-cases.json"))
    let fixtures = try JSONDecoder().decode(NonSpeechFixtures.self, from: data)
    #expect(fixtures.isContextEcho.count >= 5)
    for c in fixtures.isContextEcho {
        #expect(NonSpeechFilter.isContextEcho(c.text, contextWords: c.words) == c.expect, "\(c.why): \(c.text)")
    }
}

@Test func dedupeAgreesWithEverySharedCase() throws {
    let data = try Data(contentsOf: fixtureURL("dedupe-cases.json"))
    let fixtures = try JSONDecoder().decode(DedupeFixtures.self, from: data)
    #expect(fixtures.cases.count >= 6)
    for c in fixtures.cases {
        #expect(dedupeAgainstSession(c.prev, c.text) == c.expect, "\(c.why): \(c.text)")
    }
}

// MARK: dedupe property fuzz (Swift-only supplement to the shared cases)

private struct Lcg2 {
    var state: UInt64
    mutating func next(_ bound: Int) -> Int {
        state = state &* 6364136223846793005 &+ 1442695040888963407
        return Int(state >> 33) % bound
    }
}

@Test func dedupeFuzzConstructedOverlapsAlwaysTrim() {
    // Property: for ANY session tail S and continuation C, dedupe(prev: X+S, text: S+C) with
    // |S| >= 8 must return C (modulo leading-punctuation trimming, avoided here by 汉字-only
    // alphabets). Deterministic seed — a failure reproduces exactly.
    var rng = Lcg2(state: 20260813)
    let alphabet = Array("的一是在不了有和人这中大为上个国我以要他时来用们")
    func randomHan(_ length: Int, _ rng: inout Lcg2) -> String {
        String((0..<length).map { _ in alphabet[rng.next(alphabet.count)] })
    }
    for _ in 0..<200 {
        let head = randomHan(3 + rng.next(10), &rng)
        let overlap = randomHan(8 + rng.next(8), &rng)
        let continuation = randomHan(4 + rng.next(10), &rng)
        let result = dedupeAgainstSession(head + overlap, overlap + continuation)
        // The overlap must be consumed; the continuation must survive intact. (Exact equality
        // isn't guaranteed — a longer suffix of prev may also prefix the text — but the result
        // must always be a suffix of the continuation and never contain the full overlap.)
        #expect(continuation.hasSuffix(result), "head=\(head) overlap=\(overlap) cont=\(continuation) got=\(result)")
        #expect(!result.contains(overlap) || overlap.count < 8)
    }
}
