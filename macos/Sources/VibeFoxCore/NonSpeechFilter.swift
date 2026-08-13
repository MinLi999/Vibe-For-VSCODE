import Foundation

/// Swift port of server/src/nonspeech.ts (and its client TS copy). The Worker already runs
/// this filtering server-side; BYOK calls the ASR provider directly, so it needs its own copy
/// to catch the same failure modes (silence hallucinations, the 2026-07-12 context-echo
/// incident, the trailing-嗯 filler bug) without a server in the loop to do it for it.
public enum NonSpeechFilter {
    private static let punctuationOnly = try! Regex(#"^[\s.。,，、;；:：!！?？~〜…·\-—_*]+$"#)
    private static let bracketedDescription = try! Regex(#"^[(（\[【][^)）\]】]{0,120}[)）\]】]$"#)
    private static let audioNarration = try! Regex(#"^(音频|本段音频|该音频|此音频|背景音)"#)
    private static let fillerToken = try! Regex(#"^(嗯+|呃+|啊+|哦+|噢+|唔+|呣+|哈+|嘛+|h+m+|u+m+|u+h+|e+m+|e+r+|m+|mhm+|emm+|hmm+)$"#)
        .ignoresCase()
    private static let fillerSplit = try! Regex(#"[\s.。,，、;；:：!！?？~〜…·\-—_*]+"#)
    private static let subtitleSpam = ["点赞", "订阅", "字幕", "amara.org", "谢谢观看", "thank you for watching", "thanks for watching"]

    private static func isFillerOnly(_ t: String) -> Bool {
        let tokens = t.split(separator: fillerSplit).map(String.init).filter { !$0.isEmpty }
        return !tokens.isEmpty && tokens.allSatisfy { $0.wholeMatch(of: fillerToken) != nil }
    }

    /// Empty / punctuation-only / bracketed scene descriptions / audio narration prefixes /
    /// filler-only utterances (the trailing-段 "嗯" hallucination) / short subtitle-watermark
    /// spam. Utterances where fillers accompany real content (e.g. "嗯，好的，开始吧") pass.
    public static func isNonSpeechTranscript(_ text: String) -> Bool {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return true }
        if t.wholeMatch(of: punctuationOnly) != nil { return true }
        if t.wholeMatch(of: bracketedDescription) != nil { return true }
        if t.firstMatch(of: audioNarration) != nil { return true }
        if t.count <= 30 && isFillerOnly(t) { return true }
        if t.count <= 30 {
            let lower = t.lowercased()
            if subtitleSpam.contains(where: { lower.contains($0) }) { return true }
        }
        return false
    }

    /// Guard for ASR context-biasing (keywords fed to Qwen3-ASR's system message / Whisper's
    /// prompt field): on near-silent audio the model can read the injected vocabulary back out
    /// as the "transcription" instead of actually transcribing (the 2026-07-12 incident). Flags
    /// a transcript that is essentially nothing but the injected words. Short utterances are
    /// exempted — real dictated keywords carry connective words around them, and a transcript
    /// this short is never a full-vocabulary echo, so flagging it risks false positives.
    public static func isContextEcho(_ text: String, contextWords: [String]) -> Bool {
        guard !contextWords.isEmpty else { return false }
        let normalized = normalize(text)
        guard normalized.count >= 12 else { return false }
        var residual = normalized
        // Longest-first so "Cloudflare Workers" is consumed before "Cloudflare" leaves a stub.
        let words = contextWords.map(normalize).filter { !$0.isEmpty }.sorted { $0.count > $1.count }
        for word in words {
            residual = residual.replacingOccurrences(of: word, with: "")
        }
        guard !normalized.isEmpty else { return false }
        return Double(residual.count) / Double(normalized.count) < 0.2
    }

    /// Lowercases and strips whitespace/punctuation/symbols — mirrors `/[\s\p{P}\p{S}]+/gu`.
    private static func normalize(_ s: String) -> String {
        var result = ""
        for scalar in s.lowercased().unicodeScalars {
            if scalar.properties.isWhitespace { continue }
            switch scalar.properties.generalCategory {
            case .connectorPunctuation, .dashPunctuation, .openPunctuation, .closePunctuation,
                 .initialPunctuation, .finalPunctuation, .otherPunctuation,
                 .mathSymbol, .currencySymbol, .modifierSymbol, .otherSymbol:
                continue
            default:
                result.unicodeScalars.append(scalar)
            }
        }
        return result
    }
}
