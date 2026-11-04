import Foundation

/// The App Group shared by the app, the share extension and the widget.
/// Its identifier comes from Info.plist (`MGAppGroup`, set from the `APP_GROUP` build setting in project.yml).
enum AppGroup {
    static let id: String = (Bundle.main.object(forInfoDictionaryKey: "MGAppGroup") as? String) ?? "group.app.mygraph.ios"

    static var defaults: UserDefaults { UserDefaults(suiteName: id) ?? .standard }

    /// The shared container, or this process's caches folder when the group isn't available (unsigned builds).
    static var containerURL: URL {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: id)
            ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    }
}

/// Which My Graph server the app talks to.
enum ServerConfig {
    static let production = URL(string: "https://web-production-1858e.up.railway.app")!
    static let local = URL(string: "http://localhost:3917")!
    private static let key = "serverURL"

    static var current: URL {
        get {
            if let s = AppGroup.defaults.string(forKey: key), let u = URL(string: s), u.scheme != nil, u.host != nil { return u }
            return production
        }
        set { AppGroup.defaults.set(normalized(newValue).absoluteString, forKey: key) }
    }

    /// `scheme://host[:port]`: what the server compares the `Origin` header with.
    static var origin: String { origin(of: current) }

    static func origin(of url: URL) -> String {
        var s = "\(url.scheme ?? "https")://\(url.host ?? "")"
        if let p = url.port { s += ":\(p)" }
        return s
    }

    static func normalized(_ url: URL) -> URL {
        URL(string: origin(of: url)) ?? url
    }

    /// Parses what a person typed ("mygraph.example.com", "http://localhost:3917") into a server URL.
    static func parse(_ text: String) -> URL? {
        var t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return nil }
        if !t.contains("://") { t = "https://" + t }
        guard let u = URL(string: t), let scheme = u.scheme?.lowercased(), ["http", "https"].contains(scheme), let host = u.host, !host.isEmpty else { return nil }
        return normalized(u)
    }

    static var isLocal: Bool { current.host == "localhost" || current.host == "127.0.0.1" }
}
