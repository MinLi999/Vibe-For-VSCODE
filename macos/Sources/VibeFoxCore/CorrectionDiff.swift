import Foundation

/// Extracts (misheard → corrected) word pairs from a user's manual fix of a transcript —
/// the input side of dictionary auto-learning ("手改回学"). The user edits a history entry
/// into what they actually said; each replaced span becomes a learnable pair that feeds
/// L1 (ASR bias), the rewrite keyword list, and L2 (homophone correction).
public enum CorrectionDiff {
    public struct Pair: Equatable {
        public let from: String
        public let to: String
    }

    /// Tokens: identifier-ish runs ([A-Za-z0-9_'-]+) as one token, each CJK char its own
    /// token, every other char (punctuation, space) its own token. Separators stay in the
    /// stream so they anchor the LCS and keep unrelated edits from merging into one pair.
    static func tokenize(_ s: String) -> [String] {
        var tokens: [String] = []
        var word = ""
        func flushWord() {
            if !word.isEmpty { tokens.append(word); word = "" }
        }
        for ch in s {
            if ch.isLetter && !PhoneticCorrector.isCJK(ch) || ch.isNumber || ch == "_" || ch == "'" || ch == "-" {
                word.append(ch)
            } else {
                flushWord()
                tokens.append(String(ch))
            }
        }
        flushWord()
        return tokens
    }

    /// LCS-based diff; consecutive delete+insert runs between two matches form one pair.
    /// Insert-only runs (words added) and delete-only runs (words removed) teach nothing
    /// about mishearing, so they are skipped.
    public static func learnedPairs(original: String, corrected: String) -> [Pair] {
        let a = tokenize(original)
        let b = tokenize(corrected)
        guard !a.isEmpty, !b.isEmpty, a != b else { return [] }
        // Guard against pathological input: LCS is O(n*m) and history entries are short.
        guard a.count * b.count <= 400_000 else { return [] }

        var lcs = [[Int]](repeating: [Int](repeating: 0, count: b.count + 1), count: a.count + 1)
        for i in stride(from: a.count - 1, through: 0, by: -1) {
            for j in stride(from: b.count - 1, through: 0, by: -1) {
                lcs[i][j] = a[i] == b[j] ? lcs[i + 1][j + 1] + 1 : max(lcs[i + 1][j], lcs[i][j + 1])
            }
        }

        var pairs: [Pair] = []
        var fromRun = "", toRun = ""
        func flushRun() {
            let from = fromRun.trimmingCharacters(in: .whitespacesAndNewlines)
            let to = toRun.trimmingCharacters(in: .whitespacesAndNewlines)
            fromRun = ""; toRun = ""
            guard !from.isEmpty, !to.isEmpty, from != to else { return }
            guard to.count <= 30, from.count <= 30 else { return } // A rewrite, not a word fix.
            // Pure punctuation/digit "corrections" aren't vocabulary.
            guard to.contains(where: { $0.isLetter }) else { return }
            pairs.append(Pair(from: from, to: to))
        }

        var i = 0, j = 0
        while i < a.count && j < b.count {
            if a[i] == b[j] {
                flushRun()
                i += 1; j += 1
            } else if lcs[i + 1][j] >= lcs[i][j + 1] {
                fromRun += a[i]; i += 1
            } else {
                toRun += b[j]; j += 1
            }
        }
        while i < a.count { fromRun += a[i]; i += 1 }
        while j < b.count { toRun += b[j]; j += 1 }
        flushRun()
        return Array(pairs.prefix(8)) // Sanity cap; a real correction touches a few words.
    }
}
