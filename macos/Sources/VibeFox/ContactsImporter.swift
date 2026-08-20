import Contacts
import Foundation
import VibeFoxCore

/// Contacts → dictionary import. Everything stays local: names are read once, converted to
/// dictionary entries (source "contacts"), and the framework is never touched again until
/// the user explicitly re-imports. Requires the addressbook hardened-runtime entitlement
/// and NSContactsUsageDescription (both in scripts/).
enum ContactsImporter {
    /// Fetch + merge in one call; returns UI-ready feedback. The enumeration runs detached —
    /// CNContactStore is blocking I/O and has no business on the main actor.
    @MainActor
    static func importInto(_ model: AppModel) async -> String {
        let granted = (try? await CNContactStore().requestAccess(for: .contacts)) ?? false
        guard granted else {
            return "未获得通讯录权限:系统设置 → 隐私与安全性 → 通讯录 → 勾选 VibeFox。"
        }
        let words: [String]
        do {
            words = try await Task.detached(priority: .userInitiated) { () -> [String] in
                let keys = [
                    CNContactGivenNameKey, CNContactFamilyNameKey,
                    CNContactNicknameKey, CNContactOrganizationNameKey,
                ] as [CNKeyDescriptor]
                var candidates: [ContactWordExtractor.Candidate] = []
                let request = CNContactFetchRequest(keysToFetch: keys)
                try CNContactStore().enumerateContacts(with: request) { contact, _ in
                    candidates.append(ContactWordExtractor.Candidate(
                        given: contact.givenName,
                        family: contact.familyName,
                        nickname: contact.nickname,
                        organization: contact.organizationName
                    ))
                }
                return ContactWordExtractor.words(from: candidates)
            }.value
        } catch {
            return "读取通讯录失败:\(error.localizedDescription)"
        }
        let added = model.dictAddContacts(words: words)
        return added == 0
            ? "没有新增词条(\(words.count) 个候选都已在词库里)"
            : "已导入 \(added) 个人名/机构名(来源标记 👤,只存在本机词库)"
    }
}
