import Foundation

/// Watched folders and Voice Memos (pure parts): which files are sent, a file's stable id, and whether a change is a
/// new file, a new version of one already sent, or nothing to send.
enum FileRules {
    /// The server's limit for one file (50 MB).
    static let maxBytes: Int64 = 50 * 1024 * 1024

    enum Skip: String, Equatable {
        case hidden, temporary, tooLarge, package, notAFile, empty
    }

    /// Names editors and browsers use while writing, and system clutter.
    static func isTemporary(_ name: String) -> Bool {
        let n = name.lowercased()
        if n.hasPrefix("~$") || n.hasPrefix(".~lock.") || n.hasPrefix("~") && n.hasSuffix(".tmp") { return true }
        let ext = (n as NSString).pathExtension
        if ["tmp", "temp", "part", "partial", "crdownload", "download", "swp", "swo", "lock", "icloud"].contains(ext) { return true }
        if n == "thumbs.db" || n == "desktop.ini" || n == "icon\r" { return true }
        return false
    }

    /// Why a file is left out, or nil when it is sent.
    static func skip(name: String, isRegularFile: Bool, isPackage: Bool, isHidden: Bool, size: Int64) -> Skip? {
        if isPackage { return .package }
        if !isRegularFile { return .notAFile }
        if isHidden || name.hasPrefix(".") { return .hidden }
        if isTemporary(name) { return .temporary }
        if size <= 0 { return .empty }
        if size > maxBytes { return .tooLarge }
        return nil
    }

    /// A file's id that stays the same when it is renamed or moved inside the volume: the volume's UUID and the inode.
    static func fileId(volume: String?, inode: UInt64) -> String {
        "f:\(volume ?? "local"):\(inode)"
    }
}

/// What was last sent for one file.
struct FileRecord: Codable, Equatable {
    var fileId: String
    var relPath: String
    var size: Int64
    var modifiedAt: Date
    /// Versions sent so far (1 = the first upload).
    var versions: Int = 1
}

/// The file as it is now.
struct FileObservation: Equatable {
    var observedId: String
    var relPath: String
    var size: Int64
    var modifiedAt: Date
}

enum FileDecision: Equatable {
    /// Send it: a new file, or a new version of `fileId`. `replacesKey`: the record kept under an old inode id that
    /// this file now continues (an editor's safe save); it moves to the id seen now.
    case upload(fileId: String, newVersion: Bool, replacesKey: String?)
    /// Only its place changed (renamed or moved): remember the new path, send nothing.
    case moved(fileId: String)
    case unchanged(fileId: String)
}

enum FileVersions {
    /// Decides for one file against what was sent (`records`, keyed by the inode id the file was last seen with;
    /// `FileRecord.fileId` is the id the server knows, which never changes).
    ///
    /// - Same inode id, same size and time: unchanged (whatever its path; a new path is a move).
    /// - Same inode id, different size or time: a new version.
    /// - A new inode id at a path a sent file had, and that inode is gone: an editor saved by replacing the file
    ///   ("safe save" makes a new inode), so it is a new version of the old file, under the old fileId.
    /// - Otherwise: a new file.
    static func decide(_ f: FileObservation, records: [String: FileRecord], liveIds: Set<String>) -> FileDecision {
        if let r = records[f.observedId] {
            if same(r, f) { return r.relPath == f.relPath ? .unchanged(fileId: r.fileId) : .moved(fileId: r.fileId) }
            return .upload(fileId: r.fileId, newVersion: true, replacesKey: nil)
        }
        if let (key, previous) = records.first(where: { $0.value.relPath == f.relPath && !liveIds.contains($0.key) }) {
            return .upload(fileId: previous.fileId, newVersion: true, replacesKey: key)
        }
        return .upload(fileId: f.observedId, newVersion: false, replacesKey: nil)
    }

    private static func same(_ r: FileRecord, _ f: FileObservation) -> Bool {
        r.size == f.size && abs(r.modifiedAt.timeIntervalSince(f.modifiedAt)) < 1
    }

    /// The records after a successful upload of `f` under `decision`.
    static func record(_ decision: FileDecision, _ f: FileObservation, into records: [String: FileRecord]) -> [String: FileRecord] {
        var out = records
        switch decision {
        case .unchanged: break
        case .moved:
            out[f.observedId]?.relPath = f.relPath
        case .upload(let fileId, _, let replacesKey):
            var r = (replacesKey.flatMap { out[$0] }) ?? out[f.observedId]
                ?? FileRecord(fileId: fileId, relPath: f.relPath, size: f.size, modifiedAt: f.modifiedAt, versions: 0)
            if let k = replacesKey { out[k] = nil }
            r.fileId = fileId
            r.relPath = f.relPath
            r.size = f.size
            r.modifiedAt = f.modifiedAt
            r.versions += 1
            out[f.observedId] = r
        }
        return out
    }

    /// A file still being written is left for the next pass: changed in the last `quiet` seconds.
    static func isSettled(modifiedAt: Date, now: Date, quiet: TimeInterval = 3) -> Bool {
        now.timeIntervalSince(modifiedAt) >= quiet
    }
}
