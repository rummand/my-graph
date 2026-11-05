import Foundation

/// The Mac app's own door on the server (`/api/connections/mac/*`, see docs/mac-app-api.md).
///
/// - Signing in uses the person's session (cookies, like the iPhone app): `POST /device` gives this Mac a bearer
///   token, kept in the Keychain.
/// - Everything the app does in the background (settings, batches, uploads, outbox, status) uses only that token, on
///   a session without cookies, so a signed-out browser session never stops syncing and the token never travels with
///   a cookie.
final class MacAPI: @unchecked Sendable {
    static let shared = MacAPI()

    enum Failure: LocalizedError, Equatable {
        /// No token, or the server no longer knows it (401): sign in again.
        case unpaired(String?)
        /// The server turned this source off (409 `macSourceOff:<source>`, `macWriteBackOff`, `macFolderNotChosen`).
        case switchedOff(String?)
        /// Paused on the web (409 `macPaused`).
        case paused
        /// Too many batches: wait this long (429).
        case wait(TimeInterval, String?)
        case tooLarge(String?)
        case forbidden(String?)
        case notFound(String?)
        case server(Int, String?)
        case offline
        case badResponse

        var errorDescription: String? {
            switch self {
            case .unpaired(let m): return m ?? L("This Mac isn't signed in to My Graph any more. Sign in again in Settings.")
            case .switchedOff(let m): return m ?? L("This source is turned off in My Graph.")
            case .paused: return L("This Mac is paused in My Graph. Resume it on the web (Connections, My Graph for Mac).")
            case .wait(_, let m): return m ?? L("My Graph asked to slow down. The app tries again by itself.")
            case .tooLarge(let m): return m ?? L("That batch was too large for My Graph.")
            case .forbidden(let m): return m ?? L("You can only look at this graph, so nothing can be added to it from this Mac.")
            case .notFound(let m): return m ?? L("This server doesn't have My Graph for Mac yet. Update My Graph on the server.")
            case .server(_, let m): return m ?? L("Something went wrong on the server. The app tries again later.")
            case .offline: return L("The server can't be reached. The app tries again when you're online.")
            case .badResponse: return L("The server sent something this app doesn't understand. Try updating the app.")
            }
        }

        /// Problems a retry won't fix: the person has to do something.
        var needsPerson: Bool {
            switch self {
            case .unpaired, .forbidden, .paused: return true
            default: return false
            }
        }
    }

    let session: URLSession
    var tokenProvider: () -> String? = { MacToken.load() }

    init() {
        let c = URLSessionConfiguration.ephemeral
        c.httpCookieStorage = nil
        c.httpShouldSetCookies = false
        c.httpCookieAcceptPolicy = .never
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.timeoutIntervalForRequest = 120
        c.waitsForConnectivity = false
        session = URLSession(configuration: c)
    }

    var base: URL { ServerConfig.current }

    // MARK: Signing this Mac in (session)

    struct DeviceAnswer: Decodable {
        struct Graph: Decodable { let id: String; let name: String?; let kind: String? }
        let token: String
        let connectionId: String?
        let graph: Graph?
    }

    static var appVersion: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0" }

    /// Exchanges the signed-in session for this Mac's token (`POST /api/connections/mac/device`, session cookie, in
    /// the session's current graph). One connection per person per graph: this replaces an older token.
    func registerDevice(name: String) async throws -> DeviceAnswer {
        let body: [String: Any] = ["deviceName": String(name.prefix(200)), "appVersion": Self.appVersion]
        let (data, _) = try await API.shared.send(API.shared.request("POST", "/api/connections/mac/device", json: body))
        return try API.shared.decode(DeviceAnswer.self, from: data)
    }

    /// Forgets this Mac's token here. (On the server the connection stays, so the web keeps its history; it can be
    /// disconnected there, and signing in again replaces the token.)
    func forgetDevice() async {
        MacToken.save(nil)
    }

    // MARK: Background calls (bearer token)

    func request(_ method: String, _ path: String, query: [String: String?] = [:]) throws -> URLRequest {
        guard let token = tokenProvider() else { throw Failure.unpaired(nil) }
        var r = URLRequest(url: API.shared.url(path, query: query))
        r.httpMethod = method
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        r.setValue(AppLanguage.acceptLanguage, forHTTPHeaderField: "Accept-Language")
        r.setValue("MyGraphMac/\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0")", forHTTPHeaderField: "User-Agent")
        return r
    }

    @discardableResult
    func send(_ method: String, _ path: String, query: [String: String?] = [:], json: Data? = nil, timeout: TimeInterval = 120) async throws -> Data {
        var r = try request(method, path, query: query)
        r.timeoutInterval = timeout
        if let json {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = json
        }
        return try await perform(r)
    }

    func perform(_ r: URLRequest) async throws -> Data {
        let data: Data, resp: URLResponse
        do { (data, resp) = try await session.data(for: r) } catch {
            if error.isCancellation { throw CancellationError() }
            throw Failure.offline
        }
        guard let http = resp as? HTTPURLResponse else { throw Failure.badResponse }
        if (200..<300).contains(http.statusCode) { return data }
        throw Self.failure(status: http.statusCode, data: data, retryAfter: http.value(forHTTPHeaderField: "Retry-After"))
    }

    static func failure(status: Int, data: Data, retryAfter: String?) -> Failure {
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let msg = obj?["error"] as? String
        let code = obj?["code"] as? String ?? ""
        switch status {
        case 401: return .unpaired(code == "macUnpaired" ? L("This Mac was signed out of My Graph (maybe it was signed in again elsewhere, or the helper was paired). Sign in again in Settings.") : msg)
        case 403:
            if code == "notMember" { return .forbidden(L("You're no longer a member of the graph this Mac sends to. Sign in again and choose another graph.")) }
            if code == "readOnly" { return .forbidden(L("You can only look at this graph now, so nothing can be added to it from this Mac.")) }
            return .forbidden(msg)
        case 404: return .notFound(msg)
        case 409:
            if code == "macPaused" { return .paused }
            if code.hasPrefix("macSourceOff") { return .switchedOff(L("This source was turned off in My Graph.")) }
            if code == "macFolderNotChosen" { return .switchedOff(L("This folder isn't chosen in My Graph any more. Add it again in Settings.")) }
            if code == "macWriteBackOff" { return .switchedOff(L("Writing back to this Mac is turned off.")) }
            return .switchedOff(msg)
        case 410: return .unpaired(msg)
        case 415: return .server(415, msg)
        case 413: return .tooLarge(msg)
        case 429:
            let secs = retryAfter.flatMap(TimeInterval.init) ?? (obj?["retryAfterSec"] as? Double) ?? 120
            return .wait(max(5, secs), msg)
        default: return .server(status, msg)
        }
    }

    func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do { return try API.decoder.decode(T.self, from: data) } catch {
            #if DEBUG
            print("[mac api] decode \(T.self) failed: \(error)")
            #endif
            throw Failure.badResponse
        }
    }

    // MARK: Settings

    func settings() async throws -> MacSettings {
        MacSettings(json: try await send("GET", "/api/connections/mac/settings"))
    }

    /// Turns sources on or off (and other choices) on the server; answers with the new settings.
    func updateSettings(_ patch: [String: Any]) async throws -> MacSettings {
        let body = try JSONSerialization.data(withJSONObject: patch)
        return MacSettings(json: try await send("PUT", "/api/connections/mac/settings", json: body))
    }

    /// Tells the server which conversations and Notes folders this Mac can see (names only, no messages or notes),
    /// so the person can choose there too.
    func sendCatalog(chats: [ChatSummary], folders: [(name: String, count: Int)], canRead: [String: Bool]) async throws -> MacSettings {
        struct Folder: Encodable { let name: String; let count: Int }
        struct Body: Encodable {
            let device: String; let chats: [ChatSummary]; let folders: [Folder]; let canRead: [String: Bool]
        }
        let body = Body(device: DeviceName.current, chats: Array(chats.prefix(500)),
                        folders: folders.prefix(200).map { Folder(name: String($0.name.prefix(300)), count: $0.count) },
                        canRead: canRead.filter { ["messages", "notes"].contains($0.key) })
        return MacSettings(json: try await send("POST", "/api/connections/mac/catalog", json: PhoneImportKit.encoder.encode(body)))
    }

    // MARK: Batches and files

    struct BatchAnswer: Decodable {
        let sourceId: String?
        let duplicate: Bool?
        let kept: Int?
        let dropped: Int?
    }

    func importBatch<D: Encodable>(_ importer: MacImporter, _ batch: MacBatch<D>) async throws -> BatchAnswer {
        let body = try PhoneImportKit.encoder.encode(batch)
        let data = try await send("POST", "/api/connections/mac/import/\(importer.rawValue)", json: body, timeout: 300)
        return (try? decode(BatchAnswer.self, data)) ?? BatchAnswer(sourceId: nil, duplicate: nil, kept: nil, dropped: nil)
    }

    struct UploadAnswer: Decodable {
        let sourceId: String?
        /// new | version | unchanged | duplicate
        let outcome: String?
        let revision: Int?
        let title: String?
        let sameAs: String?
    }

    /// One file from a watched folder or Voice Memos (`multipart/form-data`: file, fileId, relPath, modifiedAt,
    /// folderLabel). The server keeps versions per fileId and skips identical bytes.
    func upload(file: URL, fileId: String, relPath: String, modifiedAt: Date, folderLabel: String, source: SourceID) async throws -> UploadAnswer {
        precondition(source == .folders || source == .voiceMemos)
        let boundary = "mgmac-\(UUID().uuidString)"
        let name = file.lastPathComponent.replacingOccurrences(of: "\"", with: "'")
        let mime = MimeType.of(file)
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("mg-upload-\(UUID().uuidString)")
        FileManager.default.createFile(atPath: tmp.path, contents: nil)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let out = try FileHandle(forWritingTo: tmp)
        func field(_ k: String, _ v: String) {
            out.write(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(k)\"\r\n\r\n\(v)\r\n".utf8))
        }
        field("fileId", fileId)
        field("relPath", String(relPath.prefix(1000)))
        field("modifiedAt", AppleTime.iso(modifiedAt) ?? "")
        field("folderLabel", String(folderLabel.prefix(200)))
        field("source", source.serverKey)
        out.write(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(name)\"\r\nContent-Type: \(mime)\r\n\r\n".utf8))
        let input = try FileHandle(forReadingFrom: file)
        while let chunk = try input.read(upToCount: 1 << 20), !chunk.isEmpty { out.write(chunk) }
        try input.close()
        out.write(Data("\r\n--\(boundary)--\r\n".utf8))
        try out.close()

        var r = try request("POST", "/api/connections/mac/upload")
        r.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        r.timeoutInterval = 600
        let data: Data, resp: URLResponse
        do { (data, resp) = try await session.upload(for: r, fromFile: tmp) } catch {
            if error.isCancellation { throw CancellationError() }
            throw Failure.offline
        }
        guard let http = resp as? HTTPURLResponse else { throw Failure.badResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw Self.failure(status: http.statusCode, data: data, retryAfter: http.value(forHTTPHeaderField: "Retry-After"))
        }
        return (try? decode(UploadAnswer.self, data)) ?? UploadAnswer(sourceId: nil, outcome: nil, revision: nil, title: nil, sameAs: nil)
    }

    // MARK: Write-back

    struct OutboxPage: Decodable {
        let items: [OutboxWire]
        let cursor: String?
    }

    /// What My Graph wants on this Mac (`GET /outbox?since=`): everything live without a cursor, else what changed.
    func outbox(since: String?) async throws -> (items: [OutboxItem], cursor: String?) {
        let data = try await send("GET", "/api/connections/mac/outbox", query: ["since": since])
        let page = try decode(OutboxPage.self, data)
        return (page.items.map(\.item), page.cursor)
    }

    /// The person ticked a My Graph reminder done in Reminders (`POST /outbox/ack`). The only write the Mac makes.
    func ackDone(reminderId: String) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["id": reminderId, "kind": "reminder", "done": true])
        try await send("POST", "/api/connections/mac/outbox/ack", json: body)
    }

    // MARK: Status

    func status() async throws -> MacStatus {
        MacStatus(json: try await send("GET", "/api/connections/mac/status", timeout: 30))
    }
}

enum DeviceName {
    static var current: String {
        let n = Host.current().localizedName ?? ProcessInfo.processInfo.hostName
        return String(n.replacingOccurrences(of: ".local", with: "").prefix(80))
    }
}
