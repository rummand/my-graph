import Foundation

/// Call History (`~/Library/Application Support/CallHistoryDB/CallHistory.storedata`, Core Data on SQLite), read-only.
/// Phone calls relayed from the iPhone and FaceTime calls appear here. Cursor: ZCALLRECORD.Z_PK.
enum CallHistory {
    static var defaultPath: String { NSHomeDirectory() + "/Library/Application Support/CallHistoryDB/CallHistory.storedata" }

    /// One row of ZCALLRECORD as read.
    struct Record: Equatable {
        var pk: Int64
        var uniqueId: String?
        var date: Double?
        var duration: Double?
        var originated: Int64?
        var answered: Int64?
        var callType: Int64?
        var serviceProvider: String?
        var address: String?
        var name: String?
    }

    /// A row as the payload wants it; nil without a usable date or without the other side's number or address.
    /// `nameOf` gives a name from Contacts; the name Call History saved is the fallback.
    static func item(_ r: Record, nameOf: (String) -> String? = { _ in nil }) -> CallItem? {
        guard let d = r.date.flatMap(AppleTime.date(seconds:)), let at = AppleTime.iso(d) else { return nil }
        guard let handle = r.address.flatMap({ PhoneImportKit.clip($0, 320) }) else { return nil }
        let service: String
        switch r.callType {
        case 1: service = "phone"
        case 8: service = "facetime_video"
        case 16: service = "facetime_audio"
        default:
            let p = (r.serviceProvider ?? "").lowercased()
            service = p.contains("facetime") ? "facetime_audio" : "phone"
        }
        let duration = min(7 * 86_400, max(0, Int((r.duration ?? 0).rounded())))
        let direction: String
        if r.originated == 1 { direction = "out" }
        else if r.answered == 1 || duration > 0 { direction = "in" }
        else { direction = "missed" }
        let name = PhoneImportKit.clip(nameOf(handle), 200) ?? PhoneImportKit.clip(r.name, 200)
        return CallItem(id: PhoneImportKit.clip(r.uniqueId, 300) ?? "call-\(r.pk)", at: at, durationSec: duration,
                        direction: direction, handle: handle, name: name, service: service)
    }

    /// Records after `afterPk` (and not before `since`), oldest first.
    static func read(path: String = defaultPath, afterPk: Int64, since: Date?, limit: Int = 20_000) throws -> [Record] {
        let db = try SQLiteReader(path: path)
        guard db.hasTable("ZCALLRECORD") else { return [] }
        let cols = db.columns("ZCALLRECORD")
        func col(_ c: String) -> String { cols.contains(c) ? c : "NULL" }
        var sql = """
            SELECT Z_PK AS pk, \(col("ZUNIQUE_ID")) AS uid, \(col("ZDATE")) AS date, \(col("ZDURATION")) AS duration,
                   \(col("ZORIGINATED")) AS originated, \(col("ZANSWERED")) AS answered, \(col("ZCALLTYPE")) AS type,
                   \(col("ZSERVICE_PROVIDER")) AS provider, \(col("ZADDRESS")) AS address, \(col("ZNAME")) AS name
            FROM ZCALLRECORD WHERE Z_PK > ?
            """
        var params: [Any?] = [afterPk]
        if let since, cols.contains("ZDATE") { sql += " AND ZDATE >= ?"; params.append(since.timeIntervalSinceReferenceDate) }
        sql += " ORDER BY Z_PK LIMIT ?"
        params.append(Int64(limit))
        return try db.query(sql, params).map { r in
            Record(pk: r["pk"]?.int ?? 0, uniqueId: r["uid"]?.string, date: r["date"]?.double, duration: r["duration"]?.double,
                   originated: r["originated"]?.int, answered: r["answered"]?.int, callType: r["type"]?.int,
                   serviceProvider: r["provider"]?.string, address: r["address"]?.string, name: r["name"]?.string)
        }
    }

    static func count(path: String = defaultPath) throws -> Int {
        let db = try SQLiteReader(path: path)
        guard db.hasTable("ZCALLRECORD") else { return 0 }
        return Int(try db.scalar("SELECT count(*) FROM ZCALLRECORD").int ?? 0)
    }
}
