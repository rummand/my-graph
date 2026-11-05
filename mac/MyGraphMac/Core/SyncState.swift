import Foundation

/// The sources the Mac app can send from. `importer` is the server's import door; folders and Voice Memos upload
/// files instead.
enum SourceID: String, Codable, CaseIterable, Identifiable {
    case messages, notes, contacts, calendar, reminders, photos, folders, voiceMemos, calls
    var id: String { rawValue }

    var importer: MacImporter? {
        switch self {
        case .messages: return .imessage
        case .notes: return .apple_notes
        case .contacts: return .contacts
        case .calendar: return .calendar
        case .reminders: return .reminders
        case .photos: return .photos
        case .calls: return .calls
        case .folders, .voiceMemos: return nil
        }
    }

    /// The key the server's settings use for this source.
    var serverKey: String {
        switch self {
        case .folders: return "files"
        default: return rawValue
        }
    }

    init?(serverKey: String) {
        guard let s = SourceID.allCases.first(where: { $0.serverKey == serverKey || $0.rawValue == serverKey }) else { return nil }
        self = s
    }
}

/// How one source's last run went, and where it got to.
struct SourceState: Codable, Equatable {
    var lastRunAt: Date?
    var lastSuccessAt: Date?
    /// Items sent in the last run.
    var lastSent: Int = 0
    var lastError: String?
    /// The error needs the person (a permission, a choice) rather than a retry.
    var needsPerson: Bool = false
    var failures: Int = 0
    var nextTryAt: Date?
    /// The source's own cursor (a ROWID, a timestamp, a Z_PK), as text.
    var cursor: String?
    /// Which server generation the cursor belongs to (the server bumps it when the person asks to send again).
    var generation: Int?
    /// id → fingerprint of what was sent, so only changes go out (contacts, calendar, reminders, photos).
    var ledger: [String: String] = [:]
    /// When everything was last sent regardless of the ledger (once a day; the server drops what it already has).
    var lastFullAt: Date?
}

struct WatchedFolder: Codable, Equatable, Identifiable {
    var id: String = UUID().uuidString
    var path: String
    var label: String
    /// A security-scoped bookmark (also works unsandboxed; survives renames of the folder).
    var bookmark: Data?
    var addedAt: Date = Date()
}

/// Everything the app remembers between runs, in Application Support/My Graph/state.json. Per server and graph:
/// switching either starts the cursors afresh.
struct SyncState: Codable, Equatable {
    var version = 1
    var server: String?
    var graphId: String?
    var paused = false
    var sources: [String: SourceState] = [:]
    var folders: [WatchedFolder] = []
    /// fileId → what was sent (watched folders and Voice Memos).
    var files: [String: FileRecord] = [:]
    /// Write-back: server id → what was written, and the outbox cursor.
    var outbox: [String: OutboxLink] = [:]
    var outboxCursor: String?
    var calendarId: String?
    var remindersListId: String?
    /// The number of proposals waiting, as last reported (for the badge and the "new proposals" notification).
    var waiting: Int?
    var notifiedWaiting: Int?
    var photosLibraryOptIn = false
    /// What this Mac last reported for choosing on the web (names only): Messages conversations, Notes folders.
    var catalogChats: [ChatSummary] = []
    var catalogFolders: [String: Int] = [:]
    var canRead: [String: Bool] = [:]

    subscript(source: SourceID) -> SourceState {
        get { sources[source.rawValue] ?? SourceState() }
        set { sources[source.rawValue] = newValue }
    }

    /// Cursors and ledgers start afresh for another server or graph; choices made on this Mac stay.
    mutating func rebind(server: String, graphId: String?) {
        guard self.server != server || self.graphId != graphId else { return }
        self.server = server
        self.graphId = graphId
        sources = [:]
        files = [:]
        outbox = [:]
        outboxCursor = nil
        waiting = nil
        notifiedWaiting = nil
    }
}

/// Reads and writes state.json atomically (0600, in a 0700 folder).
final class StateStore: @unchecked Sendable {
    let url: URL
    private let lock = NSLock()
    private var cached: SyncState?

    static var defaultDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("My Graph", isDirectory: true)
    }

    init(directory: URL = StateStore.defaultDirectory) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        url = directory.appendingPathComponent("state.json")
    }

    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        e.dateEncodingStrategy = .iso8601
        return e
    }()

    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()

    func load() -> SyncState {
        lock.lock(); defer { lock.unlock() }
        return current()
    }

    func save(_ s: SyncState) {
        lock.lock(); defer { lock.unlock() }
        write(s)
    }

    /// Load, change and save under one lock, so two tasks never lose each other's changes.
    @discardableResult
    func update(_ change: (inout SyncState) -> Void) -> SyncState {
        lock.lock(); defer { lock.unlock() }
        var s = current()
        change(&s)
        write(s)
        return s
    }

    private func current() -> SyncState {
        if let cached { return cached }
        let s = (try? Data(contentsOf: url)).flatMap { try? Self.decoder.decode(SyncState.self, from: $0) } ?? SyncState()
        cached = s
        return s
    }

    private func write(_ s: SyncState) {
        guard s != cached || !FileManager.default.fileExists(atPath: url.path) else { return }
        cached = s
        guard let data = try? Self.encoder.encode(s) else { return }
        try? data.write(to: url, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}
