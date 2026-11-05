import Foundation
import Darwin

/// Walks one folder and uploads files that are new or changed (with a stable fileId, so the server keeps versions).
struct FolderScanner {
    let root: URL
    let label: String
    let source: SourceID
    /// Only these extensions (lowercased), or any when nil.
    var extensions: Set<String>?
    /// Uploads per run at most; the rest follow on the next run.
    var maxUploads = 200

    struct Found {
        var url: URL
        /// `relPath` here is "<label>/<path in the folder>", so two folders never share records.
        var observation: FileObservation
        /// The path relative to the chosen folder, as the server wants it.
        var relPath: String
    }

    func scan() throws -> (files: [Found], skipped: Int) {
        let keys: [URLResourceKey] = [.isRegularFileKey, .isPackageKey, .isHiddenKey, .fileSizeKey, .contentModificationDateKey,
                                      .volumeUUIDStringKey, .isSymbolicLinkKey]
        guard let e = FileManager.default.enumerator(at: root, includingPropertiesForKeys: keys,
                                                     options: [.skipsHiddenFiles, .skipsPackageDescendants], errorHandler: { _, _ in true }) else {
            throw SourceError.failed(L("The folder “\(label)” can't be opened. Choose it again in Settings."))
        }
        var out: [Found] = [], skipped = 0
        let base = root.standardizedFileURL.path
        for case let url as URL in e {
            guard let v = try? url.resourceValues(forKeys: Set(keys)) else { continue }
            if v.isSymbolicLink == true { continue }
            if v.isPackage == true { e.skipDescendants(); skipped += 1; continue }
            if v.isRegularFile != true { continue }
            let name = url.lastPathComponent
            if let exts = extensions, !exts.contains(url.pathExtension.lowercased()) { continue }
            let size = Int64(v.fileSize ?? 0)
            if FileRules.skip(name: name, isRegularFile: true, isPackage: false, isHidden: v.isHidden ?? false, size: size) != nil { skipped += 1; continue }
            var st = stat()
            guard lstat(url.path, &st) == 0 else { continue }
            let id = FileRules.fileId(volume: v.volumeUUIDString, inode: UInt64(st.st_ino))
            var rel = url.standardizedFileURL.path
            if rel.hasPrefix(base) { rel = String(rel.dropFirst(base.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/")) }
            out.append(Found(url: url, observation: FileObservation(observedId: id, relPath: label + "/" + rel, size: size,
                                                                    modifiedAt: v.contentModificationDate ?? Date()), relPath: rel))
        }
        return (out, skipped)
    }

    /// Uploads what changed. Returns how many files were sent and how many wait for the next run.
    func sync(_ ctx: SyncContext) async throws -> (sent: Int, waiting: Int) {
        let (found, _) = try scan()
        let records = ctx.store.load().files
        let live = Set(found.map(\.observation.observedId))
        var sent = 0, waiting = 0
        let now = Date()
        for f in found {
            let decision = FileVersions.decide(f.observation, records: records, liveIds: live)
            switch decision {
            case .unchanged: continue
            case .moved:
                ctx.store.update { s in s.files = FileVersions.record(decision, f.observation, into: s.files) }
            case .upload(let fid, _, _):
                guard FileVersions.isSettled(modifiedAt: f.observation.modifiedAt, now: now) else { waiting += 1; continue }
                if sent >= maxUploads { waiting += 1; continue }
                if f.observation.size > Int64(ctx.settings.uploadMaxBytes) { continue }
                _ = try await ctx.api.upload(file: f.url, fileId: fid, relPath: f.relPath, modifiedAt: f.observation.modifiedAt,
                                             folderLabel: label, source: source)
                sent += 1
                ctx.store.update { s in s.files = FileVersions.record(decision, f.observation, into: s.files) }
            }
            try Task.checkCancellation()
        }
        return (sent, waiting)
    }
}

/// Watched folders: the folders the person picked (security-scoped bookmarks).
struct FoldersMacSource: MacSource {
    let id = SourceID.folders
    func permission() -> Permission { .notNeeded }

    static func resolve(_ f: WatchedFolder) -> URL? {
        if let b = f.bookmark {
            var stale = false
            if let u = try? URL(resolvingBookmarkData: b, options: [.withSecurityScope], relativeTo: nil, bookmarkDataIsStale: &stale) { return u }
        }
        let u = URL(fileURLWithPath: f.path, isDirectory: true)
        return FileManager.default.fileExists(atPath: u.path) ? u : nil
    }

    static func bookmark(_ url: URL) -> Data? {
        try? url.bookmarkData(options: [.withSecurityScope], includingResourceValuesForKeys: nil, relativeTo: nil)
    }

    func run(_ ctx: SyncContext) async throws -> SourceResult {
        // Only folders the server also has chosen (it refuses others).
        let all = ctx.store.load().folders
        guard !all.isEmpty else { throw SourceError.nothingChosen(L("Add a folder to watch in Settings, Sources, Folders.")) }
        if Set(all.map(\.label)) != Set(ctx.settings.folderLabels) {
            _ = try? await ctx.api.updateSettings(["folders": all.map(\.label)])
        }
        let folders = all
        var sent = 0, waiting = 0
        var missing: [String] = []
        for f in folders {
            guard let url = Self.resolve(f) else { missing.append(f.label); continue }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let r = try await FolderScanner(root: url, label: f.label, source: .folders).sync(ctx)
            sent += r.sent; waiting += r.waiting
        }
        if !missing.isEmpty { throw SourceError.failed(L("Can't find \(missing.joined(separator: ", ")). Choose the folder again in Settings.")) }
        return SourceResult(sent: sent, note: waiting > 0 ? L("\(waiting) more next time") : nil)
    }
}

/// Voice Memos: the recordings folder (Full Disk Access). New and changed recordings are uploaded as audio.
struct VoiceMemosMacSource: MacSource {
    let id = SourceID.voiceMemos
    static var folder: String { NSHomeDirectory() + "/Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings" }

    func permission() -> Permission {
        if !Permissions.hasFullDiskAccess { return .needsFullDiskAccess }
        return FileManager.default.fileExists(atPath: Self.folder) ? .granted : .unavailable
    }

    func run(_ ctx: SyncContext) async throws -> SourceResult {
        let p = permission()
        guard p == .granted else { throw SourceError.permission(p) }
        let scanner = FolderScanner(root: URL(fileURLWithPath: Self.folder, isDirectory: true), label: L("Voice Memos"), source: .voiceMemos,
                                    extensions: ["m4a", "qta", "wav", "caf", "aac"], maxUploads: 50)
        let r = try await scanner.sync(ctx)
        return SourceResult(sent: r.sent, note: r.waiting > 0 ? L("\(r.waiting) more next time") : nil)
    }
}
