import Foundation
import Security

/// The Mac's Keychain store, with the same two calls the shared CookieVault uses (`get`, `set`). Items are in the
/// login keychain under "app.mygraph.mac", readable after first unlock.
///
/// Debug builds started with `-MGFileSecrets` keep them in a 0600 file in Application Support instead: an ad hoc signed
/// build changes its signature on every build, and the login keychain then asks the person before each read.
enum Keychain {
    private static let service = "app.mygraph.mac"

    static var usesFile: Bool {
        #if DEBUG
        return ProcessInfo.processInfo.arguments.contains("-MGFileSecrets")
        #else
        return false
        #endif
    }

    private static func base(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
    }

    static func get(_ key: String) -> Data? {
        if usesFile { return FileSecrets.get(key) }
        var q = base(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
    }

    @discardableResult
    static func set(_ data: Data?, for key: String) -> Bool {
        if usesFile { return FileSecrets.set(data, for: key) }
        let q = base(key)
        guard let data else { SecItemDelete(q as CFDictionary); return true }
        let update = SecItemUpdate(q as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecSuccess { return true }
        var add = q
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        add[kSecAttrLabel as String] = "My Graph (\(key.hasPrefix("cookies:") ? "sign-in" : "this Mac"))"
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }
}

/// Debug-only secrets file (see Keychain).
private enum FileSecrets {
    static var url: URL { StateStore.defaultDirectory.appendingPathComponent("debug-secrets.json") }
    static func all() -> [String: Data] {
        (try? Data(contentsOf: url)).flatMap { try? JSONDecoder().decode([String: Data].self, from: $0) } ?? [:]
    }
    static func get(_ key: String) -> Data? { all()[key] }
    static func set(_ data: Data?, for key: String) -> Bool {
        var a = all()
        a[key] = data
        guard let out = try? JSONEncoder().encode(a) else { return false }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        do { try out.write(to: url, options: .atomic) } catch { return false }
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        return true
    }
}

/// This Mac's bearer token for background sync (`POST /api/connections/mac/device`), per server.
enum MacToken {
    private static func key(_ server: URL = ServerConfig.current) -> String { "device:\(ServerConfig.origin(of: server))" }

    static func load() -> String? {
        Keychain.get(key()).flatMap { String(data: $0, encoding: .utf8) }
    }

    static func save(_ token: String?) {
        Keychain.set(token.map { Data($0.utf8) }, for: key())
    }
}
