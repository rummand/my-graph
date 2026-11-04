import Foundation

/// The session lives in HTTPCookieStorage like a browser's; this mirrors My Graph's own cookies into the Keychain so
/// they survive restarts and reach the share extension and widget. Cookie values are never logged.
enum CookieVault {
    static let session = "mg_session"
    static let device = "mg_device"
    static let graph = "mg_graph"
    static let names: Set<String> = [session, device, graph]

    private struct Stored: Codable {
        var name: String, value: String, domain: String, path: String
        var expires: Date?, secure: Bool, httpOnly: Bool
    }

    private static func key(for server: URL) -> String { "cookies:\(ServerConfig.origin(of: server))" }

    /// Copies My Graph's cookies for `server` from the cookie storage into the Keychain.
    static func persist(server: URL = ServerConfig.current, storage: HTTPCookieStorage = .shared) {
        let cookies = (storage.cookies(for: server) ?? []).filter { names.contains($0.name) }
        let stored = cookies.map {
            Stored(name: $0.name, value: $0.value, domain: $0.domain, path: $0.path, expires: $0.expiresDate,
                   secure: $0.isSecure, httpOnly: $0.isHTTPOnly)
        }
        let data = try? JSONEncoder().encode(stored)
        let k = key(for: server)
        if lastSaved[k] == data { return }
        if Keychain.set(data, for: k) { lastSaved[k] = data }
    }

    nonisolated(unsafe) private static var lastSaved: [String: Data?] = [:]

    /// Puts the saved cookies back into the cookie storage (on launch, and in the extension and widget).
    static func restore(server: URL = ServerConfig.current, storage: HTTPCookieStorage = .shared) {
        guard let data = Keychain.get(key(for: server)), let stored = try? JSONDecoder().decode([Stored].self, from: data) else { return }
        for s in stored {
            if let e = s.expires, e < Date() { continue }
            var props: [HTTPCookiePropertyKey: Any] = [
                .name: s.name, .value: s.value, .domain: s.domain, .path: s.path,
            ]
            if let e = s.expires { props[.expires] = e }
            if s.secure { props[.secure] = "TRUE" }
            if s.httpOnly { props[HTTPCookiePropertyKey("HttpOnly")] = "TRUE" }
            if let c = HTTPCookie(properties: props) { storage.setCookie(c) }
        }
    }

    static func value(_ name: String, server: URL = ServerConfig.current, storage: HTTPCookieStorage = .shared) -> String? {
        storage.cookies(for: server)?.first(where: { $0.name == name })?.value
    }

    static var hasSession: Bool {
        if let v = value(session), !v.isEmpty { return true }
        return false
    }

    /// Sets a cookie for this process only (the share extension picks a graph without switching the app's).
    static func setLocal(_ name: String, _ value: String, server: URL = ServerConfig.current, storage: HTTPCookieStorage = .shared) {
        var props: [HTTPCookiePropertyKey: Any] = [.name: name, .value: value, .domain: server.host ?? "", .path: "/"]
        if server.scheme == "https" { props[.secure] = "TRUE" }
        if let c = HTTPCookie(properties: props) { storage.setCookie(c) }
    }

    /// Signs out locally. The device cookie is kept, so a parent doesn't have to approve this phone again.
    static func clearSession(server: URL = ServerConfig.current, storage: HTTPCookieStorage = .shared) {
        for c in storage.cookies(for: server) ?? [] where c.name == session || c.name == graph { storage.deleteCookie(c) }
        persist(server: server, storage: storage)
    }
}
