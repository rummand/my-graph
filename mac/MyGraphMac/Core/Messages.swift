import Foundation

/// Reading Messages (`~/Library/Messages/chat.db`), read-only, through SQLite. Only the conversations a person chose
/// are read; tapbacks and group events are left out. Cursor: the message ROWID.
struct MessagesReader {
    static var defaultPath: String { NSHomeDirectory() + "/Library/Messages/chat.db" }

    let db: SQLiteReader

    init(path: String = MessagesReader.defaultPath) throws {
        db = try SQLiteReader(path: path)
    }

    /// The conversations, newest first, without messages: id (chat.guid), name, participants, count, last message.
    func catalog(limit: Int = 500, nameOf: (String) -> String? = { _ in nil }) throws -> [ChatSummary] {
        let chats = try db.query("""
            SELECT c.ROWID AS rid, c.guid AS id, c.display_name AS name, COUNT(m.ROWID) AS n, MAX(m.date) AS last
            FROM chat c LEFT JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID LEFT JOIN message m ON m.ROWID = cmj.message_id
            GROUP BY c.ROWID ORDER BY (MAX(m.date) IS NULL), MAX(m.date) DESC LIMIT ?
            """, [Int64(limit)])
        var byChat: [Int64: [MessageParticipant]] = [:]
        for p in try db.query("SELECT chj.chat_id AS rid, h.id AS handle FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id") {
            guard let rid = p["rid"]?.int, let handle = p["handle"]?.string, !handle.isEmpty else { continue }
            var list = byChat[rid, default: []]
            if list.count < 30, !list.contains(where: { $0.handle == handle }) {
                list.append(MessageParticipant(handle: String(handle.prefix(320)), name: nameOf(handle).map { String($0.prefix(200)) }))
            }
            byChat[rid] = list
        }
        return chats.compactMap { c in
            guard let rid = c["rid"]?.int, let id = c["id"]?.string else { return nil }
            let parts = byChat[rid] ?? []
            var name = c["name"]?.string?.nilIfBlank
            if name == nil, parts.count == 1 { name = parts[0].name }
            let last = (c["last"]?.int).flatMap(AppleTime.messageDate).flatMap(AppleTime.iso)
            return ChatSummary(id: String(id.prefix(300)), name: name.map { String($0.prefix(300)) }, participants: parts,
                               count: Int(c["n"]?.int ?? 0), lastAt: last)
        }
    }

    func maxRowId() throws -> Int64 {
        try db.scalar("SELECT MAX(ROWID) FROM message").int ?? 0
    }

    /// Messages of `chats` with from < ROWID <= to (and not before `since`), in ROWID order, a page at a time.
    /// Returns how many were read; `onMessage(chatId, rowId, message)`.
    @discardableResult
    func read(chats: [String], fromRowId: Int64, toRowId: Int64, since: Date?, pageSize: Int = 2000,
              onMessage: (String, Int64, MessageItem) throws -> Void) throws -> Int {
        guard !chats.isEmpty, fromRowId < toRowId else { return 0 }
        let placeholders = Array(repeating: "?", count: chats.count).joined(separator: ",")
        let cols = db.columns("message")
        let assoc = cols.contains("associated_message_type") ? "AND COALESCE(m.associated_message_type, 0) = 0" : ""
        let item = cols.contains("item_type") ? "AND COALESCE(m.item_type, 0) = 0" : ""
        let body = cols.contains("attributedBody") ? "m.attributedBody" : "NULL"
        var from = fromRowId
        var n = 0
        while from < toRowId {
            var params: [Any?] = [from, toRowId]
            params.append(contentsOf: chats.map { $0 as Any? })
            var sinceSQL = ""
            if let since { sinceSQL = "AND m.date >= ?"; params.append(AppleTime.nanoseconds(since)) }
            params.append(Int64(pageSize))
            let rows = try db.query("""
                SELECT m.ROWID AS rowid, m.guid AS guid, m.text AS text, \(body) AS body, m.date AS date, m.is_from_me AS me,
                       h.id AS handle, c.guid AS chat, m.cache_has_attachments AS att
                FROM message m JOIN chat_message_join cmj ON cmj.message_id = m.ROWID JOIN chat c ON c.ROWID = cmj.chat_id
                LEFT JOIN handle h ON h.ROWID = m.handle_id
                WHERE m.ROWID > ? AND m.ROWID <= ? AND c.guid IN (\(placeholders)) \(sinceSQL) \(assoc) \(item)
                ORDER BY m.ROWID LIMIT ?
                """, params)
            if rows.isEmpty { break }
            let withAtt = rows.filter { $0["att"]?.int == 1 }.compactMap { $0["rowid"]?.int }
            var atts: [Int64: [MessageAttachment]] = [:]
            if !withAtt.isEmpty {
                let ph = Array(repeating: "?", count: withAtt.count).joined(separator: ",")
                for a in try db.query("""
                    SELECT maj.message_id AS mid, a.transfer_name AS tn, a.filename AS fn, a.mime_type AS mime
                    FROM message_attachment_join maj JOIN attachment a ON a.ROWID = maj.attachment_id WHERE maj.message_id IN (\(ph))
                    """, withAtt.map { $0 as Any? }) {
                    guard let mid = a["mid"]?.int else { continue }
                    let raw = a["tn"]?.string ?? a["fn"]?.string ?? "attachment"
                    let name = String((raw as NSString).lastPathComponent.prefix(300))
                    if atts[mid, default: []].count < 50 {
                        atts[mid, default: []].append(MessageAttachment(filename: name, mime: a["mime"]?.string.map { String($0.prefix(100)) }))
                    }
                }
            }
            for r in rows {
                guard let rowId = r["rowid"]?.int else { continue }
                from = max(from, rowId)
                guard let date = (r["date"]?.int).flatMap(AppleTime.messageDate), let at = AppleTime.iso(date) else { continue }
                let raw = r["text"]?.string?.nilIfBlank ?? AttributedBody.text(r["body"]?.data)
                let text = AttributedBody.clean(raw)
                let attachments = atts[rowId] ?? []
                if text.isEmpty && attachments.isEmpty { continue }
                let who = r["me"]?.int == 1 ? "me" : String((r["handle"]?.string ?? "unknown").prefix(320))
                let id = String((r["guid"]?.string ?? String(rowId)).prefix(300))
                try onMessage(r["chat"]?.string ?? "", rowId, MessageItem(id: id, at: at, from: who, text: text, attachments: attachments))
                n += 1
            }
            if rows.count < pageSize { break }
        }
        return n
    }
}

/// Groups messages (in ROWID order) into imessage batches under `maxBytes`, each a contiguous ROWID range.
struct MessageBatcher {
    struct Batch: Equatable {
        var data: IMessageData
        var firstRowId: Int64
        var lastRowId: Int64
        var count: Int
    }

    let maxBytes: Int
    let maxMessages: Int
    let meta: (String) -> (name: String?, participants: [MessageParticipant])

    private var chats: [String: MessageChat] = [:]
    private var order: [String] = []
    private var size = 16
    private var count = 0
    private var first: Int64?
    private var last: Int64 = 0

    init(maxBytes: Int = PhoneImportKit.maxBatchBytes, maxMessages: Int = 50_000,
         meta: @escaping (String) -> (name: String?, participants: [MessageParticipant])) {
        self.maxBytes = maxBytes; self.maxMessages = maxMessages; self.meta = meta
    }

    private static func bytes<T: Encodable>(_ v: T) -> Int { (try? PhoneImportKit.encoder.encode(v).count) ?? 0 }

    /// Adds one message; returns a finished batch when this one didn't fit (the message starts the next batch).
    mutating func add(chat: String, rowId: Int64, message: MessageItem) -> Batch? {
        let isNew = chats[chat] == nil
        let m = meta(chat)
        let head = isNew ? Self.bytes(MessageChat(id: chat, name: m.name, participants: m.participants, messages: [])) + 1 : 0
        let add = Self.bytes(message) + 1 + head
        var done: Batch?
        if count > 0, size + add > maxBytes || count >= maxMessages || (isNew && chats.count >= 5000) {
            done = flush()
            _ = self.add(chat: chat, rowId: rowId, message: message)
            return done
        }
        if isNew {
            chats[chat] = MessageChat(id: chat, name: m.name, participants: m.participants, messages: [])
            order.append(chat)
        }
        chats[chat]!.messages.append(message)
        size += add
        count += 1
        if first == nil { first = rowId }
        last = rowId
        return done
    }

    mutating func flush() -> Batch? {
        defer { chats = [:]; order = []; size = 16; count = 0; first = nil; last = 0 }
        guard count > 0, let first else { return nil }
        return Batch(data: IMessageData(chats: order.compactMap { chats[$0] }), firstRowId: first, lastRowId: last, count: count)
    }
}
