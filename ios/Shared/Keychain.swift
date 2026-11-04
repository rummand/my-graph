import Foundation
import Security

/// Small generic-password store in the App Group's keychain access group, so the share extension and the widget can
/// read what the app saved. Items are readable after first unlock (background refresh and the widget run locked).
enum Keychain {
    private static let service = "app.mygraph.session"

    private static func base(_ key: String, group: Bool) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        if group { q[kSecAttrAccessGroup as String] = AppGroup.id }
        return q
    }

    static func get(_ key: String) -> Data? {
        for group in [true, false] {
            var q = base(key, group: group)
            q[kSecReturnData as String] = true
            q[kSecMatchLimit as String] = kSecMatchLimitOne
            var out: AnyObject?
            let status = SecItemCopyMatching(q as CFDictionary, &out)
            if status == errSecSuccess, let d = out as? Data { return d }
            if status != errSecMissingEntitlement && status != errSecItemNotFound { break }
        }
        return nil
    }

    @discardableResult
    static func set(_ data: Data?, for key: String) -> Bool {
        for group in [true, false] {
            let q = base(key, group: group)
            let delStatus = SecItemDelete(q as CFDictionary)
            if delStatus == errSecMissingEntitlement { continue }
            guard let data else { return true }
            var add = q
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            let status = SecItemAdd(add as CFDictionary, nil)
            if status == errSecSuccess {
                #if DEBUG
                print("[debug] keychain saved \(group ? "in the shared App Group" : "in this app only")")
                #endif
                return true
            }
            if status != errSecMissingEntitlement { return false }
        }
        return false
    }
}
