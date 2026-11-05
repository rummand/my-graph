import Foundation
import SQLite3

/// A small read-only reader over the SQLite C API, for Messages (chat.db) and Call History. The databases are opened
/// read-only and never written; a database that can't be opened because of privacy rules says so (`.noAccess`), so the
/// app can ask for Full Disk Access.
final class SQLiteReader {
    enum Failure: Error, Equatable {
        case noAccess(String)
        case missing(String)
        case failed(String)
    }

    private var db: OpaquePointer?
    let path: String

    init(path: String) throws {
        self.path = path
        let fm = FileManager.default
        if !fm.fileExists(atPath: path) {
            // Without Full Disk Access the folder itself can't be listed, so a missing file may be a hidden one.
            let dir = (path as NSString).deletingLastPathComponent
            if fm.fileExists(atPath: dir), (try? fm.contentsOfDirectory(atPath: dir)) == nil { throw Failure.noAccess(path) }
            throw Failure.missing(path)
        }
        guard fm.isReadableFile(atPath: path) else { throw Failure.noAccess(path) }
        let uri = "file:" + (path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? path) + "?mode=ro"
        let rc = sqlite3_open_v2(uri, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI | SQLITE_OPEN_NOMUTEX, nil)
        if rc != SQLITE_OK {
            let msg = db.map { String(cString: sqlite3_errmsg($0)) } ?? "open failed"
            sqlite3_close(db); db = nil
            if rc == SQLITE_PERM || rc == SQLITE_AUTH || rc == SQLITE_CANTOPEN { throw Failure.noAccess(path) }
            throw Failure.failed(msg)
        }
        sqlite3_busy_timeout(db, 3000)
        // A first query proves the file can really be read (TCC can let the open succeed and fail the read).
        do { _ = try scalar("SELECT count(*) FROM sqlite_master") } catch {
            sqlite3_close(db); db = nil
            throw Failure.noAccess(path)
        }
    }

    deinit { sqlite3_close(db) }

    /// One value in a column of a row.
    enum Value: Equatable {
        case int(Int64), double(Double), text(String), blob(Data), null

        var int: Int64? {
            switch self {
            case .int(let i): return i
            case .double(let d): return Int64(d)
            case .text(let s): return Int64(s)
            default: return nil
            }
        }
        var double: Double? {
            switch self {
            case .int(let i): return Double(i)
            case .double(let d): return d
            case .text(let s): return Double(s)
            default: return nil
            }
        }
        var string: String? {
            switch self {
            case .text(let s): return s
            case .int(let i): return String(i)
            case .double(let d): return String(d)
            case .blob(let b): return String(data: b, encoding: .utf8)
            case .null: return nil
            }
        }
        var data: Data? {
            switch self {
            case .blob(let b): return b
            case .text(let s): return Data(s.utf8)
            default: return nil
            }
        }
    }

    typealias Row = [String: Value]

    /// Runs a query with bound parameters (Int64, Double, String or nil) and returns every row.
    func query(_ sql: String, _ params: [Any?] = []) throws -> [Row] {
        var rows: [Row] = []
        try each(sql, params) { rows.append($0) }
        return rows
    }

    func each(_ sql: String, _ params: [Any?] = [], _ body: (Row) throws -> Void) throws {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { throw Failure.failed(lastError) }
        defer { sqlite3_finalize(stmt) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (i, p) in params.enumerated() {
            let idx = Int32(i + 1)
            switch p {
            case let v as Int64: sqlite3_bind_int64(stmt, idx, v)
            case let v as Int: sqlite3_bind_int64(stmt, idx, Int64(v))
            case let v as Double: sqlite3_bind_double(stmt, idx, v)
            case let v as String: sqlite3_bind_text(stmt, idx, v, -1, transient)
            default: sqlite3_bind_null(stmt, idx)
            }
        }
        let n = sqlite3_column_count(stmt)
        while true {
            let rc = sqlite3_step(stmt)
            if rc == SQLITE_DONE { break }
            guard rc == SQLITE_ROW else { throw Failure.failed(lastError) }
            var row: Row = [:]
            for c in 0..<n {
                let name = String(cString: sqlite3_column_name(stmt, c))
                switch sqlite3_column_type(stmt, c) {
                case SQLITE_INTEGER: row[name] = .int(sqlite3_column_int64(stmt, c))
                case SQLITE_FLOAT: row[name] = .double(sqlite3_column_double(stmt, c))
                case SQLITE_TEXT: row[name] = .text(String(cString: sqlite3_column_text(stmt, c)))
                case SQLITE_BLOB:
                    let len = Int(sqlite3_column_bytes(stmt, c))
                    if let p = sqlite3_column_blob(stmt, c), len > 0 { row[name] = .blob(Data(bytes: p, count: len)) } else { row[name] = .blob(Data()) }
                default: row[name] = .null
                }
            }
            try body(row)
        }
    }

    func scalar(_ sql: String, _ params: [Any?] = []) throws -> Value {
        try query(sql, params).first?.values.first ?? .null
    }

    /// The columns a table has (schemas differ between macOS versions).
    func columns(_ table: String) -> Set<String> {
        guard let rows = try? query("PRAGMA table_info(\(table))") else { return [] }
        return Set(rows.compactMap { $0["name"]?.string })
    }

    func hasTable(_ table: String) -> Bool {
        ((try? scalar("SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?", [table]))?.int ?? 0) > 0
    }

    private var lastError: String { db.map { String(cString: sqlite3_errmsg($0)) } ?? "no database" }
}
