import Foundation

/// Server-Sent Events parsing (same rules as src/lib/mux/sse.ts): events split across chunks, CRLF/CR/LF line endings,
/// multi-line `data:` fields, `:` comments, and a final event without a trailing blank line (`flush`).
struct SSEEvent: Equatable {
    var event: String
    var data: String
}

struct SSEParser {
    private var line = [UInt8]()
    private var data = [String]()
    private var event = ""
    private var sawField = false
    private var lastWasCR = false

    /// Feeds one byte; returns an event when a blank line completes it.
    mutating func push(_ byte: UInt8) -> SSEEvent? {
        if byte == 0x0A && lastWasCR { lastWasCR = false; return nil } // the \n of \r\n
        lastWasCR = byte == 0x0D
        if byte == 0x0A || byte == 0x0D {
            let text = String(decoding: line, as: UTF8.self)
            line.removeAll(keepingCapacity: true)
            return take(text)
        }
        line.append(byte)
        return nil
    }

    mutating func flush() -> SSEEvent? {
        if !line.isEmpty {
            let text = String(decoding: line, as: UTF8.self)
            line.removeAll()
            if let e = take(text) { return e }
        }
        return dispatch()
    }

    private mutating func take(_ text: String) -> SSEEvent? {
        if text.isEmpty { return dispatch() }
        if text.hasPrefix(":") { return nil }
        let field: Substring, value: Substring
        if let i = text.firstIndex(of: ":") {
            field = text[..<i]
            var v = text[text.index(after: i)...]
            if v.hasPrefix(" ") { v = v.dropFirst() }
            value = v
        } else {
            field = Substring(text); value = ""
        }
        switch field {
        case "event": event = String(value); sawField = true
        case "data": data.append(String(value)); sawField = true
        default: break
        }
        return nil
    }

    private mutating func dispatch() -> SSEEvent? {
        defer { data.removeAll(); event = ""; sawField = false }
        guard sawField, !data.isEmpty else { return nil }
        return SSEEvent(event: event.isEmpty ? "message" : event, data: data.joined(separator: "\n"))
    }
}

extension API {
    /// POSTs JSON and yields the answer's server-sent events as they arrive.
    func events(_ path: String, json: [String: Any]) -> AsyncThrowingStream<SSEEvent, Error> {
        var req = request("POST", path, json: json)
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        req.timeoutInterval = 300
        let session = self.session
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let (bytes, resp) = try await session.bytes(for: req)
                    guard let http = resp as? HTTPURLResponse else { throw APIError.badResponse }
                    CookieVault.persist()
                    if !(200..<300).contains(http.statusCode) {
                        var body = Data()
                        for try await b in bytes { body.append(b); if body.count > 65_536 { break } }
                        throw self.mapError(status: http.statusCode, data: body)
                    }
                    var parser = SSEParser()
                    for try await b in bytes {
                        if let e = parser.push(b) { continuation.yield(e) }
                    }
                    if let e = parser.flush() { continuation.yield(e) }
                    continuation.finish()
                } catch {
                    if error.isCancellation { continuation.finish(throwing: CancellationError()); return }
                    if error is APIError { continuation.finish(throwing: error); return }
                    continuation.finish(throwing: APIError.offline)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
