import Foundation

/// L2 of the three-layer dictionary: deterministic Chinese homophone correction, local and
/// zero-token. Catches the most typical Chinese ASR error — right pronunciation, wrong
/// characters — for dictionary words that didn't make the ≤40 ASR bias slots (L1) and that
/// L3's literal replacement can't reach because the misheard form was never seen before.
///
/// Safety model: a span is only rewritten when its pinyin (tones included, via the system's
/// CFStringTransform — no bundled data) EXACTLY equals a dictionary word's pinyin and the
/// characters differ. Tone-strict matching is deliberate: "true homophone" is precisely what
/// "读音对但字写错" means, and it keeps near-misses like 食品(shí pǐn)/视频(shì pín) apart.
/// Since the dictionary is the user's curated jargon (names, products, terms), rewriting a
/// same-pronunciation span into a curated word is almost always the intended fix.
public enum PhoneticCorrector {
    /// Precomputed lookup for one dictionary generation. Build once, reuse per delivery.
    public struct Map {
        /// Pinyin key → dictionary word. Ambiguous keys (two entries, same pronunciation)
        /// are dropped entirely — guessing between them would be wrong half the time.
        let byPinyin: [String: String]
        /// Every CJK dictionary word, so already-correct spans are never touched.
        let knownWords: Set<String>
        /// Window sizes worth trying (the distinct lengths of eligible words).
        let lengths: [Int]

        public init(entries: [DictionaryEntry]) {
            var map: [String: String] = [:]
            var ambiguous: Set<String> = []
            var words: Set<String> = []
            var lengthSet: Set<Int> = []
            for entry in entries {
                let word = entry.word
                guard (2...6).contains(word.count), word.allSatisfy(PhoneticCorrector.isCJK) else { continue }
                words.insert(word)
                lengthSet.insert(word.count)
                let key = PhoneticCorrector.pinyin(word)
                guard !key.isEmpty else { continue }
                if let existing = map[key], existing != word {
                    ambiguous.insert(key)
                } else {
                    map[key] = word
                }
            }
            for key in ambiguous { map.removeValue(forKey: key) }
            byPinyin = map
            knownWords = words
            // Longest first: 深度学习 must win over a shorter entry embedded in it.
            lengths = lengthSet.sorted(by: >)
        }

        public var isEmpty: Bool { byPinyin.isEmpty }
    }

    static func isCJK(_ ch: Character) -> Bool {
        guard let scalar = ch.unicodeScalars.first, ch.unicodeScalars.count == 1 else { return false }
        return (0x4E00...0x9FFF).contains(scalar.value) || (0x3400...0x4DBF).contains(scalar.value)
    }

    /// Mandarin pinyin with tone marks, lowercased. Both sides of every comparison go
    /// through this same transform, so the exact romanization details don't matter — only
    /// that identical pronunciations produce identical strings.
    static func pinyin(_ s: String) -> String {
        let m = NSMutableString(string: s)
        CFStringTransform(m, nil, kCFStringTransformMandarinLatin, false)
        return (m as String).lowercased()
    }

    /// Rewrites every non-overlapping CJK span whose pronunciation exactly matches a
    /// dictionary word (longest match first, left to right). Non-CJK text passes through
    /// untouched — English phonetics are a different problem, handled by L1/L3 and rewrite.
    public static func correct(_ text: String, map: Map) -> String {
        guard !map.isEmpty else { return text }
        var out = ""
        out.reserveCapacity(text.count)
        var run: [Character] = []

        func flushRun() {
            guard !run.isEmpty else { return }
            var i = 0
            while i < run.count {
                var replaced = false
                for length in map.lengths where i + length <= run.count {
                    let window = String(run[i..<(i + length)])
                    if map.knownWords.contains(window) {
                        // Already a dictionary word — emit as-is and jump past it.
                        out += window
                        i += length
                        replaced = true
                        break
                    }
                    if let word = map.byPinyin[pinyin(window)], word != window {
                        out += word
                        i += length
                        replaced = true
                        break
                    }
                }
                if !replaced {
                    out.append(run[i])
                    i += 1
                }
            }
            run.removeAll(keepingCapacity: true)
        }

        for ch in text {
            if isCJK(ch) {
                run.append(ch)
            } else {
                flushRun()
                out.append(ch)
            }
        }
        flushRun()
        return out
    }
}
