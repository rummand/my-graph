import Foundation

extension Notification.Name {
    /// The server said the session is gone (401). The app goes back to sign-in.
    static let mgSignedOut = Notification.Name("mg.signedOut")
    /// The server said a parent still has to approve this device.
    static let mgPendingApproval = Notification.Name("mg.pendingApproval")
}

/// Errors in plain words. Server messages are already written for people, so they are shown as they are.
enum APIError: LocalizedError, Equatable {
    case offline
    case timedOut
    case unauthorized(String?)
    case pendingApproval
    case forbidden(String?)
    case notFound(String?)
    case unavailable
    case tooMany(String?)
    case server(Int, String?)
    case badResponse

    var errorDescription: String? {
        switch self {
        case .offline: return String(localized: "You're offline. Check your connection and try again.")
        case .timedOut: return String(localized: "My Graph took too long to answer. Try again in a moment.")
        case .unauthorized(let m): return m ?? String(localized: "Please sign in again.")
        case .pendingApproval: return String(localized: "A parent needs to approve this device before you can use My Graph here.")
        case .forbidden(let m): return m ?? String(localized: "You don't have access to this.")
        case .notFound(let m): return m ?? String(localized: "This isn't here any more.")
        case .unavailable: return String(localized: "The assistant can't be reached right now. Everything else still works.")
        case .tooMany(let m): return m ?? String(localized: "Too many attempts. Wait a few minutes and try again.")
        case .server(_, let m): return m ?? String(localized: "Something went wrong on our side. Please try again.")
        case .badResponse: return String(localized: "My Graph sent something this app doesn't understand. Try updating the app.")
        }
    }

    var isOffline: Bool { self == .offline || self == .timedOut }
}

extension Error {
    /// What to show a person for any error.
    var plainMessage: String {
        if let e = self as? APIError { return e.errorDescription ?? "" }
        if self is DecodingError { return APIError.badResponse.errorDescription ?? "" }
        if (self as NSError).domain == NSURLErrorDomain { return APIError.offline.errorDescription ?? "" }
        return String(localized: "Something went wrong. Please try again.")
    }

    var isOffline: Bool {
        if let e = self as? APIError { return e.isOffline }
        return (self as NSError).domain == NSURLErrorDomain
    }

    var isCancellation: Bool {
        if self is CancellationError { return true }
        let ns = self as NSError
        return ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled
    }
}

/// Any JSON object the caller doesn't need (`{ ok: true }`).
struct Empty: Decodable {}

/// The HTTP client for My Graph's own API. Uses the shared cookie storage (the session cookie), sends `Origin` on
/// every state-changing request (the server's CSRF check) and maps errors to plain words.
final class API: @unchecked Sendable {
    static let shared = API()

    /// The share extension sets this to false: it must not overwrite the app's saved cookies (graph choice).
    var persistsCookies = true

    let session: URLSession

    init() {
        let config = URLSessionConfiguration.default
        config.httpCookieStorage = .shared
        config.httpShouldSetCookies = true
        config.httpCookieAcceptPolicy = .always
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 60
        config.waitsForConnectivity = false
        session = URLSession(configuration: config)
    }

    var base: URL { ServerConfig.current }

    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { dec in
            let c = try dec.singleValueContainer()
            let s = try c.decode(String.self)
            if let date = ISODate.parse(s) { return date }
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "Not a date")
        }
        return d
    }()

    func url(_ path: String, query: [String: String?] = [:]) -> URL {
        var c = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        c.path = path.hasPrefix("/") ? path : "/" + path
        let items = query.compactMap { k, v in v.map { URLQueryItem(name: k, value: $0) } }.sorted { $0.name < $1.name }
        c.queryItems = items.isEmpty ? nil : items
        return c.url!
    }

    func request(_ method: String, _ path: String, query: [String: String?] = [:], json: [String: Any]? = nil) -> URLRequest {
        var r = URLRequest(url: url(path, query: query))
        r.httpMethod = method
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        r.setValue(AppLanguage.acceptLanguage, forHTTPHeaderField: "Accept-Language")
        if method != "GET" && method != "HEAD" { r.setValue(ServerConfig.origin, forHTTPHeaderField: "Origin") }
        if let json {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try? JSONSerialization.data(withJSONObject: json)
        }
        return r
    }

    /// Sends a request and returns the body of a 2xx answer, or throws an APIError.
    func send(_ req: URLRequest, quietAuth: Bool = false) async throws -> (Data, HTTPURLResponse) {
        let data: Data, resp: URLResponse
        do {
            (data, resp) = try await session.data(for: req)
        } catch {
            if error.isCancellation { throw CancellationError() }
            let code = (error as NSError).code
            if code == NSURLErrorTimedOut { throw APIError.timedOut }
            throw APIError.offline
        }
        guard let http = resp as? HTTPURLResponse else { throw APIError.badResponse }
        if persistsCookies { CookieVault.persist() }
        if (200..<300).contains(http.statusCode) { return (data, http) }
        throw mapError(status: http.statusCode, data: data, quietAuth: quietAuth)
    }

    func mapError(status: Int, data: Data, quietAuth: Bool = false) -> APIError {
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let message = obj?["error"] as? String
        switch status {
        case 401:
            if !quietAuth { NotificationCenter.default.post(name: .mgSignedOut, object: message) }
            return .unauthorized(message)
        case 403:
            if obj?["pending"] as? Bool == true {
                if !quietAuth { NotificationCenter.default.post(name: .mgPendingApproval, object: nil) }
                return .pendingApproval
            }
            return .forbidden(message)
        case 404: return .notFound(message)
        case 429: return .tooMany(message)
        case 502, 503, 504:
            if obj?["code"] as? String == "mux_unavailable" { return .unavailable }
            return .server(status, message ?? String(localized: "My Graph isn't answering right now. Try again in a moment."))
        default: return .server(status, message)
        }
    }

    func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do { return try API.decoder.decode(T.self, from: data) } catch {
            #if DEBUG
            print("[api] decode \(T.self) failed: \(error)")
            #endif
            throw APIError.badResponse
        }
    }

    func get<T: Decodable>(_ path: String, query: [String: String?] = [:], as type: T.Type = T.self) async throws -> T {
        let (data, _) = try await send(request("GET", path, query: query))
        return try decode(T.self, from: data)
    }

    func call<T: Decodable>(_ method: String, _ path: String, json: [String: Any]? = [:], as type: T.Type = T.self) async throws -> T {
        let (data, _) = try await send(request(method, path, json: json))
        return try decode(T.self, from: data)
    }

    @discardableResult
    func post(_ path: String, json: [String: Any]? = [:]) async throws -> Data {
        try await send(request("POST", path, json: json)).0
    }

    /// Raw bytes of a file (`/api/files/:id`), after the server's access check.
    func fileData(_ sourceId: String) async throws -> (Data, String?) {
        let (data, http) = try await send(request("GET", "/api/files/\(sourceId)"))
        return (data, http.value(forHTTPHeaderField: "Content-Type"))
    }

    /// Uploads files to the library of the current graph (multipart, field `file`).
    func upload(_ files: [UploadFile], visibility: String) async throws -> UploadResponse {
        let boundary = "mg-\(UUID().uuidString)"
        var body = Data()
        func add(_ s: String) { body.append(Data(s.utf8)) }
        add("--\(boundary)\r\nContent-Disposition: form-data; name=\"visibility\"\r\n\r\n\(visibility)\r\n")
        for f in files {
            let name = f.filename.replacingOccurrences(of: "\"", with: "'")
            add("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(name)\"\r\nContent-Type: \(f.mime)\r\n\r\n")
            body.append(f.data)
            add("\r\n")
        }
        add("--\(boundary)--\r\n")
        var r = request("POST", "/api/library")
        r.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        r.timeoutInterval = 300
        let data: Data, resp: URLResponse
        do {
            (data, resp) = try await session.upload(for: r, from: body)
        } catch {
            if error.isCancellation { throw CancellationError() }
            throw APIError.offline
        }
        guard let http = resp as? HTTPURLResponse else { throw APIError.badResponse }
        if persistsCookies { CookieVault.persist() }
        // A partly failed upload still answers 201 with per-file errors; a total failure answers 4xx with results.
        if let out = try? API.decoder.decode(UploadResponse.self, from: data), out.results?.isEmpty == false { return out }
        if (200..<300).contains(http.statusCode) { return try decode(UploadResponse.self, from: data) }
        throw mapError(status: http.statusCode, data: data)
    }
}
