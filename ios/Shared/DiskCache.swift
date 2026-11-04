import Foundation

/// A simple JSON cache on disk (App Group container), so Today and People still show when offline.
/// Entries are per server and per graph; signing out clears them.
enum DiskCache {
    private static var dir: URL {
        let d = AppGroup.containerURL.appendingPathComponent("Cache", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    private static func file(_ key: String) -> URL {
        let host = ServerConfig.current.host ?? "server"
        let safe = "\(host)-\(key)".replacingOccurrences(of: "[^A-Za-z0-9._-]", with: "_", options: .regularExpression)
        return dir.appendingPathComponent(safe + ".json")
    }

    struct Entry<T: Codable>: Codable { let savedAt: Date; let value: T }

    static func save<T: Codable>(_ value: T, as key: String) {
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .iso8601
        guard let data = try? enc.encode(Entry(savedAt: Date(), value: value)) else { return }
        try? data.write(to: file(key), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    static func load<T: Codable>(_ type: T.Type, key: String) -> Entry<T>? {
        guard let data = try? Data(contentsOf: file(key)) else { return nil }
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .iso8601
        return try? dec.decode(Entry<T>.self, from: data)
    }

    static func clear() {
        try? FileManager.default.removeItem(at: dir)
    }
}
