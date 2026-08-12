import Foundation
import Security

/// License key storage in the login Keychain — same generic-password item (service "VibeFox",
/// account "license") the Electron build created via the `security` CLI, so an existing key
/// carries over. First read from the differently-signed native app may show one system
/// confirmation prompt; "Always Allow" ends that.
public enum KeychainStore {
    static let service = "VibeFox"
    static let account = "license"

    public static func getLicenseKey() -> String? {
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
              let key = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !key.isEmpty else {
            return nil
        }
        return key
    }

    @discardableResult
    public static func setLicenseKey(_ key: String) -> Bool {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let data = Data(key.utf8)
        let update = [kSecValueData as String: data]
        let updateStatus = SecItemUpdate(base as CFDictionary, update as CFDictionary)
        if updateStatus == errSecSuccess { return true }
        var add = base
        add[kSecValueData as String] = data
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    /// Re-creates the item so THIS app becomes its creator (creators are on the item's ACL
    /// automatically). The Electron-era item was created by the `security` CLI, so macOS asks
    /// for permission on every read until the user picks "Always Allow" — after one granted
    /// read we can rebuild the item and the prompts stop for good, whichever button was clicked.
    /// Deleting doesn't expose the secret, so the delete+add pair never prompts.
    public static func reclaimOwnership(_ key: String) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = Data(key.utf8)
        SecItemAdd(add as CFDictionary, nil)
    }

    @discardableResult
    public static func clearLicenseKey() -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}
