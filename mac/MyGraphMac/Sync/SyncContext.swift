import Foundation

/// What one run of one source gets: the server's settings, the API, the local state and this run's id.
struct SyncContext: Sendable {
    let api: MacAPI
    let store: StateStore
    let settings: MacSettings
    let runId: String
    let device: String
    var maxBytes: Int { settings.maxBatchBytes }
}

struct SourceResult: Equatable {
    var sent: Int
    /// Extra words for the status line ("12 conversations chosen").
    var note: String?
}

enum SourceError: LocalizedError, Equatable {
    case permission(Permission)
    case nothingChosen(String)
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .permission(let p):
            switch p {
            case .needsFullDiskAccess: return L("Give My Graph Full Disk Access in System Settings to read this.")
            case .needsAutomation, .denied: return L("Allow My Graph in System Settings, Privacy & Security, to read this.")
            case .notAsked: return L("Turn this on again to let macOS ask for permission.")
            case .unavailable: return L("There is nothing to read on this Mac.")
            default: return p.label
            }
        case .nothingChosen(let m): return m
        case .failed(let m): return m
        }
    }

    var needsPerson: Bool {
        switch self {
        case .permission, .nothingChosen: return true
        case .failed: return false
        }
    }
}

extension SyncContext {
    /// Reports the conversations and Notes folders this Mac can see (names only), keeping the other half as last
    /// reported (the server replaces the whole list each time). Answers with the helper fields of the settings.
    @discardableResult
    func reportCatalog(chats: [ChatSummary]? = nil, folders: [(name: String, count: Int)]? = nil, canRead: [String: Bool]) async throws -> MacSettings {
        let s = store.update { s in
            if let chats { s.catalogChats = chats }
            if let folders { s.catalogFolders = Dictionary(folders.map { ($0.name, $0.count) }, uniquingKeysWith: { a, b in a + b }) }
            s.canRead.merge(canRead) { _, b in b }
        }
        let list = s.catalogFolders.sorted { $0.key < $1.key }.map { (name: $0.key, count: $0.value) }
        return try await api.sendCatalog(chats: s.catalogChats, folders: list, canRead: s.canRead)
    }
}

protocol MacSource: Sendable {
    var id: SourceID { get }
    func permission() -> Permission
    func run(_ ctx: SyncContext) async throws -> SourceResult
}

extension MacSource {
    /// Sends the items that are new or changed since the ledger (id → fingerprint), in batches under the size limit,
    /// moving the ledger after every batch that arrived. A batch's name comes from its content, so a batch sent again
    /// after a failure updates the same source on the server instead of making another.
    func sendChanged<T: Encodable, D: Encodable>(
        _ ctx: SyncContext, importer: MacImporter, items: [T], id: (T) -> String, maxCount: Int = 20_000,
        wrap: ([T]) -> D
    ) async throws -> Int {
        // Once a day everything goes again: the server keeps its own fingerprints and drops what it has, so a server
        // that lost or reset its copy catches up without the person doing anything.
        let st = ctx.store.load()[self.id]
        let full = st.lastFullAt.map { Date().timeIntervalSince($0) > 86_400 } ?? true
        let changed = full ? items : PhoneImportKit.changed(items, id: id, ledger: st.ledger)
        let batches = PhoneImportKit.batches(changed, maxBytes: ctx.maxBytes, maxCount: maxCount)
        for (i, b) in batches.enumerated() {
            let prints = b.map { (id($0), PhoneImportKit.fingerprint($0)) }
            let name = batchName("\(importer.rawValue.prefix(3))-\(PhoneImportKit.fingerprint(prints.map { $0.0 + $0.1 }))")
            let batch = MacBatch(runId: ctx.runId, batch: name, final: i == batches.count - 1, device: ctx.device, data: wrap(b))
            _ = try await ctx.api.importBatch(importer, batch)
            ctx.store.update { s in for (k, v) in prints { s[self.id].ledger[k] = v } }
        }
        // Items gone from the Mac are forgotten here, so they are sent again if they come back.
        let live = Set(items.map(id))
        ctx.store.update { s in
            s[self.id].ledger = s[self.id].ledger.filter { live.contains($0.key) }
            if full { s[self.id].lastFullAt = Date() }
        }
        return changed.count
    }
}
