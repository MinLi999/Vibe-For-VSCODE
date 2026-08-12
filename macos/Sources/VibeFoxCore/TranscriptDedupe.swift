import Foundation

/// Swift port of client/src/models/TranscriptDedupe.ts — trims text that echoes what the
/// current session already inserted (ASR conditioning echoes, rewrite-LLM repeats).
/// Deterministic last line of defense; behavior mirrors the TS original exactly.
public func dedupeAgainstSession(_ sessionTranscript: String, _ text: String) -> String {
    let prev = sessionTranscript
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if prev.isEmpty || t.isEmpty { return t }

    let strippable = CharacterSet(charactersIn: " \t\n\r。.,，、;；:：!！?？…~〜'\"'\u{2018}\u{2019}\u{201C}\u{201D}()（）-")
    func normalize(_ s: String) -> String {
        String(s.unicodeScalars.filter { !strippable.contains($0) })
    }

    let nPrev = normalize(prev)
    let nText = normalize(t)
    // The whole utterance is a re-emission of what was already inserted.
    if !nText.isEmpty && nPrev.hasSuffix(nText) { return "" }

    // Overlap trim: longest suffix of the inserted transcript that prefixes the new text
    // (>=8 chars so ordinary short word repeats aren't mistaken for echoes).
    let tChars = Array(t)
    let maxLen = min(prev.count, tChars.count)
    if maxLen >= 8 {
        for k in stride(from: maxLen, through: 8, by: -1) {
            let head = String(tChars[0..<k])
            if prev.hasSuffix(head) {
                var rest = String(tChars[k...])
                let leading = CharacterSet(charactersIn: " \t\n\r。.,，、;；:：!！?？…")
                while let first = rest.unicodeScalars.first, leading.contains(first) {
                    rest.removeFirst()
                }
                return rest
            }
        }
    }
    return t
}
