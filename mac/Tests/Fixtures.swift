import Foundation
import SQLite3
import XCTest

/// Builds small SQLite databases shaped like chat.db and CallHistory.storedata, in a temporary folder. No real
/// Messages or Calls data is ever read by the tests.
enum Fixture {
    static func database(_ name: String, sql: [String], blobs: [(String, [Data])] = []) throws -> String {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("mg-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let path = dir.appendingPathComponent(name).path
        var db: OpaquePointer?
        guard sqlite3_open(path, &db) == SQLITE_OK else { throw NSError(domain: "fixture", code: 1) }
        defer { sqlite3_close(db) }
        for s in sql {
            var err: UnsafeMutablePointer<CChar>?
            if sqlite3_exec(db, s, nil, nil, &err) != SQLITE_OK {
                let m = err.map { String(cString: $0) } ?? "?"
                throw NSError(domain: "fixture", code: 2, userInfo: [NSLocalizedDescriptionKey: "\(m) in \(s)"])
            }
        }
        // Statements with blob parameters ("?"), one per row of data.
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (stmtSQL, rows) in blobs {
            for data in rows {
                var stmt: OpaquePointer?
                sqlite3_prepare_v2(db, stmtSQL, -1, &stmt, nil)
                _ = data.withUnsafeBytes { sqlite3_bind_blob(stmt, 1, $0.baseAddress, Int32(data.count), transient) }
                sqlite3_step(stmt)
                sqlite3_finalize(stmt)
            }
        }
        return path
    }

    /// An attributedBody blob like Messages writes: … "NSString" 01 94 84 01 "+" <length> <UTF-8>.
    static func attributedBody(_ text: String, mutable: Bool = false) -> Data {
        var d = Data([0x04, 0x0B]) + Data("streamtyped".utf8) + Data([0x81, 0xE8, 0x03, 0x84, 0x01, 0x40, 0x84, 0x84, 0x84])
        d += Data("NSMutableAttributedString".utf8) + Data([0x00, 0x84, 0x84])
        d += Data((mutable ? "NSMutableString" : "NSString").utf8)
        d += Data([0x01, 0x94, 0x84, 0x01, 0x2B])
        let bytes = Data(text.utf8)
        if bytes.count < 0x80 { d.append(UInt8(bytes.count)) }
        else if bytes.count <= 0xFFFF { d.append(0x81); d.append(UInt8(bytes.count & 0xFF)); d.append(UInt8(bytes.count >> 8)) }
        else { d.append(0x82); for i in 0..<4 { d.append(UInt8((bytes.count >> (8 * i)) & 0xFF)) } }
        d += bytes
        d += Data([0x86, 0x84, 0x02, 0x69, 0x49, 0x01])
        return d
    }

    /// chat.db nanoseconds for a date.
    static func ns(_ iso: String) -> Int64 {
        AppleTime.nanoseconds(AppleTime.parseISO(iso)!)
    }
}
