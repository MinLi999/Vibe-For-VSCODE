import Foundation
import Security

/// Provider API keys stored in the login Keychain — one generic-password item per account,
/// service "VibeFox". License key uses account "license" (same item the Electron build
/// created via the `security` CLI, so an existing key carries over — first read from the
/// differently-signed native app may show one system confirmation prompt; "Always Allow"
/// ends that). BYOK provider keys (Groq/OpenAI/Aliyun) are separate accounts, never mixed
/// with the license key or with each other.
public enum KeychainStore {
    static let service = "VibeFox"

    // MARK: generic per-account storage

    public static func getSecret(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let value = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else {
            return nil
        }
        return value
    }

    @discardableResult
    public static func setSecret(_ value: String, account: String) -> Bool {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let data = Data(value.utf8)
        let update = [kSecValueData as String: data]
        let updateStatus = SecItemUpdate(base as CFDictionary, update as CFDictionary)
        if updateStatus == errSecSuccess { return true }
        var add = base
        add[kSecValueData as String] = data
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    @discardableResult
    public static func clearSecret(account: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }

    // MARK: license key (account "license")

    static let licenseAccount = "license"

    public static func getLicenseKey() -> String? { getSecret(account: licenseAccount) }

    @discardableResult
    public static func setLicenseKey(_ key: String) -> Bool { setSecret(key, account: licenseAccount) }

    @discardableResult
    public static func clearLicenseKey() -> Bool { clearSecret(account: licenseAccount) }

    /// Re-creates the item so THIS app becomes its creator (creators are on the item's ACL
    /// automatically). The Electron-era item was created by the `security` CLI, so macOS asks
    /// for permission on every read until the user picks "Always Allow" — after one granted
    /// read we can rebuild the item and the prompts stop for good, whichever button was clicked.
    /// Deleting doesn't expose the secret, so the delete+add pair never prompts.
    public static func reclaimOwnership(_ key: String) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: licenseAccount,
        ]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = Data(key.utf8)
        SecItemAdd(add as CFDictionary, nil)
    }

    // MARK: BYOK provider keys (accounts "groqKey" / "openaiKey" / "aliyunKey")

    /// Keychain account name for a direct-provider API key, or nil for providers that don't
    /// need one (cloudflare uses the license key; custom endpoints are typically keyless).
    public static func providerKeyAccount(for provider: String) -> String? {
        switch provider {
        case "groq": return "groqKey"
        case "openai": return "openaiKey"
        case "aliyun": return "aliyunKey"
        default: return nil
        }
    }
}
