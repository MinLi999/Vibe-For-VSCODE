import Foundation

/// Turns raw contact fields into dictionary-worthy words. Pure logic — the Contacts
/// framework fetch (permissions, CNContactStore) lives in the app layer; this part is
/// deterministic and tested. Names are exactly the vocabulary ASR keeps mishearing, and
/// they never leave the machine: imported entries join the local dictionary like any other.
public enum ContactWordExtractor {
    public struct Candidate: Equatable {
        public let given: String
        public let family: String
        public let nickname: String
        public let organization: String

        public init(given: String?, family: String?, nickname: String? = nil, organization: String? = nil) {
            self.given = (given ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            self.family = (family ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            self.nickname = (nickname ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            self.organization = (organization ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }

    /// Deduped words across all candidates, insertion-ordered. Per contact: the full name
    /// (family+given joined without a space when both sides are CJK — 张伟, not 张 伟 —
    /// otherwise "given family"), the nickname, and the organization.
    public static func words(from candidates: [Candidate]) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        func add(_ raw: String) {
            let word = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            // Single characters bias nothing useful and pollute the ≤40 ASR slots.
            guard word.count >= 2, word.count <= 64 else { return }
            guard seen.insert(word.lowercased()).inserted else { return }
            out.append(word)
        }
        for c in candidates {
            add(fullName(given: c.given, family: c.family))
            add(c.nickname)
            add(c.organization)
        }
        return out
    }

    static func fullName(given: String, family: String) -> String {
        guard !given.isEmpty else { return family }
        guard !family.isEmpty else { return given }
        let bothCJK = given.allSatisfy(PhoneticCorrector.isCJK) && family.allSatisfy(PhoneticCorrector.isCJK)
        // Chinese convention: family first, no space. Everything else: "given family".
        return bothCJK ? family + given : given + " " + family
    }
}
