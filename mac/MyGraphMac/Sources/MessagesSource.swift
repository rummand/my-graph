import Foundation
import Contacts

/// Messages: `~/Library/Messages/chat.db`, read-only (Full Disk Access). Only the conversations chosen in My Graph (or
/// in this app's conversation picker) are read. The list of conversations (names and numbers, never messages) is sent
/// so the person can choose. Cursor: the message ROWID; a newly chosen conversation gets its history once (backfill).
struct MessagesSource: MacSource {
    let id = SourceID.messages
    var path = MessagesReader.defaultPath

    func permission() -> Permission { Permissions.fileSource(path) }

    /// The conversations on this Mac, newest first (for the picker). Names come from Contacts when it is allowed.
    func catalog() throws -> [ChatSummary] {
        let reader = try open()
        let names = ContactNames.load()
        return try reader.catalog(limit: 500, nameOf: names.name(for:))
    }

    private func open() throws -> MessagesReader {
        do { return try MessagesReader(path: path) } catch let e as SQLiteReader.Failure {
            switch e {
            case .noAccess: throw SourceError.permission(.needsFullDiskAccess)
            case .missing: throw SourceError.permission(.unavailable)
            case .failed(let m): throw SourceError.failed(m)
            }
        }
    }

    func run(_ ctx: SyncContext) async throws -> SourceResult {
        let reader = try open()
        let names = ContactNames.load()
        let catalog = try reader.catalog(limit: 500, nameOf: names.name(for:))
        // The server answers the catalog with fresh settings (which conversations it may send now).
        var settings = ctx.settings
        if let fresh = try? await ctx.reportCatalog(chats: catalog, canRead: ["messages": true]) {
            // The catalog answers with the helper fields only (which conversations, cursors).
            settings.chats = fresh.chats; settings.backfill = fresh.backfill; settings.since = fresh.since
            settings.serverCursor[.messages] = fresh.serverCursor[.messages]; settings.generation[.messages] = fresh.generation[.messages]
        }
        guard settings.isOn(.messages) else { return SourceResult(sent: 0) }
        let chats = settings.chats
        guard !chats.isEmpty else {
            throw SourceError.nothingChosen(L("Choose the conversations to send in My Graph on the web (Connections, My Graph for Mac)."))
        }
        let meta = Dictionary(catalog.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let metaOf: (String) -> (name: String?, participants: [MessageParticipant]) = { id in (meta[id]?.name, meta[id]?.participants ?? []) }

        let local = ctx.store.load()[.messages]
        let generation = settings.generation[.messages] ?? 0
        var cursor: Int64? = settings.serverCursor[.messages].flatMap { Int64($0) }
        if cursor == nil, local.generation == generation { cursor = local.cursor.flatMap { Int64($0) } }
        let snapshot = try reader.maxRowId()
        var total = 0

        func phase(_ name: String, chats: [String], from: Int64, to: Int64) async throws {
            var batcher = MessageBatcher(maxBytes: ctx.maxBytes, meta: metaOf)
            var held: MessageBatcher.Batch?
            func post(_ b: MessageBatcher.Batch?, final: Bool) async throws {
                let label = b.map { "\(name.prefix(1))-\($0.firstRowId)-\($0.lastRowId)" } ?? "\(name.prefix(1))-none-\(to)"
                let batch = MacBatch(runId: ctx.runId, batch: batchName(label), final: final, device: ctx.device, phase: name,
                                     lastRowId: final ? to : b?.lastRowId, covered: final ? chats : nil,
                                     data: b?.data ?? IMessageData(chats: []))
                _ = try await ctx.api.importBatch(.imessage, batch)
                total += b?.count ?? 0
                if name == "forward" {
                    let at = final ? to : (b?.lastRowId ?? from)
                    ctx.store.update { s in s[.messages].cursor = String(at); s[.messages].generation = generation }
                }
            }
            // Read in ROWID windows, so a long history never sits in memory at once; one batch is always held back,
            // because the last one carries `final` (the conversations covered and where the cursor ends).
            var window = from
            while window < to {
                let end = min(to, window + 20_000)
                var ready: [MessageBatcher.Batch] = []
                try reader.read(chats: chats, fromRowId: window, toRowId: end, since: settings.since) { chat, rowId, msg in
                    if let done = batcher.add(chat: chat, rowId: rowId, message: msg) { ready.append(done) }
                }
                if end == to, let last = batcher.flush() { ready.append(last) }
                for b in ready {
                    if let h = held { try await post(h, final: false) }
                    held = b
                }
                window = end
                try Task.checkCancellation()
            }
            if held != nil || name == "forward" { try await post(held, final: true) }
        }

        let backfill = settings.backfill.filter { chats.contains($0) }
        if let c = cursor, !backfill.isEmpty { try await phase("backfill", chats: backfill, from: 0, to: c) }
        let from = cursor ?? 0
        if snapshot > from || cursor == nil { try await phase("forward", chats: chats, from: from, to: max(snapshot, from)) }
        return SourceResult(sent: total, note: L("\(chats.count) conversations chosen"))
    }
}

/// Names for numbers and addresses, from Contacts (only when the person allowed Contacts).
struct ContactNames {
    var phones: [String: String] = [:]
    var emails: [String: String] = [:]

    static func load() -> ContactNames {
        var out = ContactNames()
        guard CNContactStore.authorizationStatus(for: .contacts) == .authorized else { return out }
        let keys: [CNKeyDescriptor] = [CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
                                       CNContactPhoneNumbersKey as CNKeyDescriptor, CNContactEmailAddressesKey as CNKeyDescriptor,
                                       CNContactOrganizationNameKey as CNKeyDescriptor]
        let req = CNContactFetchRequest(keysToFetch: keys)
        try? CNContactStore().enumerateContacts(with: req) { c, _ in
            guard let name = (CNContactFormatter.string(from: c, style: .fullName) ?? c.organizationName).nilIfBlank else { return }
            for p in c.phoneNumbers {
                let n = normPhone(p.value.stringValue)
                if n.count >= 8 { out.phones[n] = name }
            }
            for e in c.emailAddresses { out.emails[(e.value as String).lowercased()] = name }
        }
        return out
    }

    /// Digits only, the last 8, so +45 / 0045 / none all match (as My Graph does).
    static func normPhone(_ s: String) -> String {
        let d = s.filter(\.isNumber)
        return d.count >= 8 ? String(d.suffix(8)) : d
    }

    func name(for handle: String) -> String? {
        let h = handle.trimmingCharacters(in: .whitespaces)
        if h.contains("@") { return emails[h.lowercased()] }
        return phones[Self.normPhone(h)]
    }
}
