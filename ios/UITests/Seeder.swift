import Foundation

/// A second signed-in client for the UI tests: seeds data through the API and checks what the taps did.
/// It has its own cookies, so it never touches the app's session.
final class Seeder: @unchecked Sendable {
    let base: URL
    let session: URLSession
    /// Cookies by name, kept by hand: a fresh HTTPCookieStorage() doesn't store anything.
    private var cookies: [String: String] = [:]
    private let lock = NSLock()

    init(base: URL) {
        self.base = base
        let c = URLSessionConfiguration.ephemeral
        c.httpCookieStorage = nil
        c.httpShouldSetCookies = false
        c.timeoutIntervalForRequest = 300
        c.timeoutIntervalForResource = 600
        session = URLSession(configuration: c)
    }

    struct Failure: Error, CustomStringConvertible { let description: String }

    private func request(_ method: String, _ path: String, json: Any? = nil) -> URLRequest {
        var r = URLRequest(url: URL(string: path, relativeTo: base)!)
        r.httpMethod = method
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        r.setValue("en", forHTTPHeaderField: "Accept-Language")
        let jar = lock.withLock { cookies.map { "\($0.key)=\($0.value)" }.joined(separator: "; ") }
        if !jar.isEmpty { r.setValue(jar, forHTTPHeaderField: "Cookie") }
        if method != "GET" { r.setValue(base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")), forHTTPHeaderField: "Origin") }
        if let json {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try? JSONSerialization.data(withJSONObject: json)
        }
        return r
    }

    @discardableResult
    func call(_ method: String, _ path: String, json: Any? = nil) async throws -> [String: Any] {
        let (data, resp) = try await session.data(for: request(method, path, json: json))
        keep(resp)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard (200..<300).contains(code) else { throw Failure(description: "\(method) \(path) → \(code) \(obj["error"] ?? "")") }
        return obj
    }

    private func keep(_ resp: URLResponse) {
        guard let http = resp as? HTTPURLResponse, let url = http.url else { return }
        let fields = http.allHeaderFields.reduce(into: [String: String]()) { d, kv in
            if let k = kv.key as? String, let v = kv.value as? String { d[k] = v }
        }
        let got = HTTPCookie.cookies(withResponseHeaderFields: fields, for: url)
        lock.withLock { for c in got { cookies[c.name] = c.value } }
    }

    func signIn(email: String, password: String) async throws {
        try await call("POST", "/api/auth/login", json: ["email": email, "password": password])
    }

    // Suggestions

    struct PendingSuggestion { let id: String; let kind: String }

    func pendingSuggestions() async throws -> [PendingSuggestion] {
        let r = try await call("GET", "/api/suggestions?status=pending&limit=10")
        return (r["suggestions"] as? [[String: Any]] ?? []).compactMap { s in
            guard let id = s["id"] as? String, let k = s["kind"] as? String, s["status"] as? String == "pending" else { return nil }
            return PendingSuggestion(id: id, kind: k)
        }
    }

    func suggestionStatus(_ id: String) async throws -> String? {
        let r = try await call("GET", "/api/suggestions?status=all&limit=100")
        return (r["suggestions"] as? [[String: Any]] ?? []).first { $0["id"] as? String == id }?["status"] as? String
    }

    // Reminders

    func createReminder(title: String, dueIn seconds: TimeInterval) async throws -> String {
        let f = ISO8601DateFormatter()
        let r = try await call("POST", "/api/reminders", json: ["title": title, "dueAt": f.string(from: Date().addingTimeInterval(seconds))])
        guard let id = (r["reminder"] as? [String: Any])?["id"] as? String else { throw Failure(description: "no reminder id") }
        return id
    }

    func reminderDone(_ id: String) async throws -> Bool {
        let deadline = Date().addingTimeInterval(60)
        repeat {
            let r = try await call("GET", "/api/reminders?includeDone=true&limit=200")
            if let row = (r["reminders"] as? [[String: Any]] ?? []).first(where: { $0["id"] as? String == id }), row["done"] as? Bool == true { return true }
            try await Task.sleep(for: .seconds(2))
        } while Date() < deadline
        return false
    }

    // Chat

    /// Asks something the assistant answers with a reminder proposal; returns the conversation when one is pending.
    func chatWithProposal() async throws -> String? {
        let n = Int.random(in: 100...999)
        let q = "Please add a reminder for me: renew the library card (UI test \(n)) on Friday at 10:00. Just propose it."
        var req = request("POST", "/api/chat", json: ["question": q])
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        let (data, resp) = try await session.data(for: req)
        keep(resp)
        let text = String(decoding: data, as: UTF8.self)
        guard let range = text.range(of: #""conversationId":"([0-9a-f-]{36})""#, options: .regularExpression) else {
            throw Failure(description: "No conversation in the chat stream: \(text.prefix(300))")
        }
        let id = String(text[range].dropFirst(#""conversationId":""#.count).dropLast())
        let statuses = try await proposalStatuses(id)
        return statuses.contains("pending") || statuses.contains("queued") ? id : nil
    }

    func proposalStatuses(_ conversationId: String) async throws -> [String] {
        let r = try await call("GET", "/api/chat/\(conversationId)")
        let msgs = (r["conversation"] as? [String: Any])?["messages"] as? [[String: Any]] ?? []
        return msgs.flatMap { ($0["proposals"] as? [[String: Any]] ?? []).compactMap { $0["status"] as? String } }
    }

    // Change sets

    struct SetState { let status: String; let changes: [(id: String, seq: Int, included: Bool)] }

    func changeSet(_ id: String) async throws -> SetState {
        let r = try await call("GET", "/api/changes/\(id)")
        let c = r["changeSet"] as? [String: Any] ?? [:]
        let changes = (c["changes"] as? [[String: Any]] ?? []).map { ($0["id"] as? String ?? "", $0["seq"] as? Int ?? 0, $0["included"] as? Bool ?? true) }
        return SetState(status: c["status"] as? String ?? "", changes: changes.sorted { $0.1 < $1.1 }.map { (id: $0.0, seq: $0.1, included: $0.2) })
    }

    /// Uploads a short note; the read-through proposes a change set titled after the file. Waits for it.
    func changeSetFromUpload() async throws -> String {
        let n = Int.random(in: 1000...9999)
        let name = "ui-test-note-\(n).txt"
        let body = "Note from the UI test \(n). Karen Holm from the Lindholm Library runs the Saturday reading club for children. The reading club meets at the Lindholm Library at 10:00 on Saturdays."
        let boundary = "mg-\(UUID().uuidString)"
        var data = Data()
        data.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"visibility\"\r\n\r\nhousehold\r\n".utf8))
        data.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(name)\"\r\nContent-Type: text/plain\r\n\r\n".utf8))
        data.append(Data(body.utf8))
        data.append(Data("\r\n--\(boundary)--\r\n".utf8))
        var req = request("POST", "/api/library")
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        let (_, resp) = try await session.upload(for: req, from: data)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw Failure(description: "upload failed") }
        let deadline = Date().addingTimeInterval(420)
        repeat {
            let r = try await call("GET", "/api/changes?status=draft&limit=50")
            if let s = (r["changeSets"] as? [[String: Any]] ?? []).first(where: { ($0["title"] as? String ?? "").contains(name) }), let id = s["id"] as? String {
                return id
            }
            try await Task.sleep(for: .seconds(5))
        } while Date() < deadline
        throw Failure(description: "No change set was proposed for \(name)")
    }
}
