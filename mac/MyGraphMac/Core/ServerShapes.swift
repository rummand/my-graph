import Foundation

// Shapes of the server's answers (docs/mac-app-api.md), read tolerantly. Pure, unit-tested.

/// What the server lets this Mac send (`GET /api/connections/mac/settings`, docs/mac-app-api.md section 2).
struct MacSettings: Equatable {
    var enabled: [SourceID: Bool] = [:]
    var writeBackReminders = false
    var writeBackEvents = false
    /// The labels of the folders chosen for Files (paths stay on the Mac).
    var folderLabels: [String] = []
    var generation: [SourceID: Int] = [:]
    var serverCursor: [SourceID: String] = [:]
    /// Calls: the newest call time the server has.
    var callsSince: Date?
    var chats: [String] = []
    var backfill: [String] = []
    var since: Date?
    var noteFolders: [String]?
    var visibility: String?
    var maxBatchBytes = 5_000_000
    var uploadMaxBytes = Int(FileRules.maxBytes)
    var connectionId: String?
    var label: String?
    var graphId: String?
    var graphName: String?

    init() {}

    init(json data: Data) {
        let obj = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any]) ?? [:]
        self.init(dict: obj)
    }

    init(dict o: [String: Any]) {
        connectionId = o["connectionId"] as? String
        label = o["label"] as? String
        visibility = o["visibility"] as? String
        if let g = o["graph"] as? [String: Any] { graphId = g["id"] as? String; graphName = g["name"] as? String }
        if let m = (o["maxBatchBytes"] as? NSNumber)?.intValue, m > 100_000 { maxBatchBytes = min(m, PhoneImportKit.maxBatchBytes) }
        if let m = (o["uploadMaxBytes"] as? NSNumber)?.intValue, m > 0 { uploadMaxBytes = m }
        if let sources = o["sources"] as? [String: Any] {
            for (k, v) in sources {
                guard let id = SourceID(serverKey: k) else { continue }
                enabled[id] = (v as? Bool) ?? ((v as? [String: Any])?["enabled"] as? Bool) ?? false
            }
        }
        if let w = o["writeBack"] as? [String: Any] {
            writeBackReminders = (w["reminders"] as? Bool) ?? false
            writeBackEvents = (w["events"] as? Bool) ?? false
        }
        folderLabels = (o["folders"] as? [String]) ?? []
        if let c = o["cursors"] as? [String: Any] { callsSince = AppleTime.parseISO(c["calls"] as? String) }
        if let m = o["messages"] as? [String: Any] {
            if enabled[.messages] == nil { enabled[.messages] = (m["enabled"] as? Bool) ?? false }
            if let c = m["chats"] as? [String] { chats = c }
            if let b = m["backfill"] as? [String] { backfill = b }
            if let s = m["since"] as? String { since = AppleTime.parseISO(s) }
            if let g = (m["generation"] as? NSNumber)?.intValue { generation[.messages] = g }
            if let c = m["cursor"], let t = Self.text(c) { serverCursor[.messages] = t }
        }
        if let n = o["notes"] as? [String: Any] {
            if enabled[.notes] == nil { enabled[.notes] = (n["enabled"] as? Bool) ?? false }
            noteFolders = n["folders"] as? [String]
            if let g = (n["generation"] as? NSNumber)?.intValue { generation[.notes] = g }
            if let c = n["cursor"], let t = Self.text(c) { serverCursor[.notes] = t }
        }
    }

    private static func text(_ v: Any) -> String? {
        if let s = v as? String { return s }
        if let n = v as? NSNumber { return n.stringValue }
        return nil
    }

    func isOn(_ s: SourceID) -> Bool { enabled[s] ?? false }
    var writeBackOn: Bool { writeBackReminders || writeBackEvents }
}

/// `GET /api/connections/mac/status`: the badge, and what came in lately.
struct MacStatus: Equatable {
    struct Import: Equatable {
        var sourceId: String
        var title: String
        var kind: String
        var status: String
        var at: Date?
    }

    var waiting = 0
    var reviewPath = "/changes"
    var lastImports: [Import] = []
    var connectionStatus: String?

    init() {}

    init(json data: Data) {
        guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        waiting = (o["waiting"] as? NSNumber)?.intValue ?? 0
        lastImports = ((o["lastImports"] as? [[String: Any]]) ?? []).compactMap { d in
            guard let id = d["sourceId"] as? String else { return nil }
            return Import(sourceId: id, title: (d["title"] as? String) ?? "", kind: (d["kind"] as? String) ?? "",
                          status: (d["status"] as? String) ?? "", at: AppleTime.parseISO(d["at"] as? String))
        }
        connectionStatus = (o["connection"] as? [String: Any])?["status"] as? String
    }
}

/// One item as the outbox sends it.
struct OutboxWire: Decodable {
    let id: String
    let kind: String
    let title: String?
    let notes: String?
    let dueAt: String?
    let startAt: String?
    let endAt: String?
    let allDay: Bool?
    let done: Bool?
    let deleted: Bool?
    let updatedAt: String?
    let url: String?

    var item: OutboxItem {
        OutboxItem(id: id, kind: kind, op: deleted == true ? "delete" : "upsert", version: updatedAt, title: title, notes: notes, url: url,
                   dueAt: dueAt, startAt: startAt, endAt: endAt, allDay: allDay, location: nil, completed: done)
    }
}

