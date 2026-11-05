import Foundation

/// What this iPhone keeps for "Bring in from this iPhone": which sources are on, how the last send went, and per
/// graph what was already sent (id → fingerprint), so a later send carries only what changed. Nothing here leaves the
/// phone except through `PhoneImportClient.send`. Kept in the app's own Application Support (not the App Group): the
/// share extension and widget have no business reading it.
enum PhoneImportStore {
    private static var defaults: UserDefaults { .standard }

    private static var dir: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let d = base.appendingPathComponent("FromThisPhone", isDirectory: true)
        if !FileManager.default.fileExists(atPath: d.path) {
            try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
            var u = d
            var rv = URLResourceValues(); rv.isExcludedFromBackup = true
            try? u.setResourceValues(rv)
        }
        return d
    }

    // MARK: Switches

    static func isOn(_ i: PhoneImporter) -> Bool { defaults.bool(forKey: "fromPhone.\(i.rawValue).on") }
    static func setOn(_ i: PhoneImporter, _ on: Bool) { defaults.set(on, forKey: "fromPhone.\(i.rawValue).on") }

    /// Who can see what a source brings in. Health is always private.
    static func visibility(_ i: PhoneImporter) -> String {
        if i == .health { return "private" }
        return defaults.string(forKey: "fromPhone.\(i.rawValue).visibility") ?? "private"
    }
    static func setVisibility(_ i: PhoneImporter, _ v: String) { defaults.set(v, forKey: "fromPhone.\(i.rawValue).visibility") }

    /// Photos: the details of every photo in the library (opt-in; the default is only photos you pick).
    static var photosWholeLibrary: Bool {
        get { defaults.bool(forKey: "fromPhone.photos.library") }
        set { defaults.set(newValue, forKey: "fromPhone.photos.library") }
    }

    /// Places: look up place names with Apple Maps before sending.
    static var placesNames: Bool {
        get { defaults.object(forKey: "fromPhone.places.names") as? Bool ?? false }
        set { defaults.set(newValue, forKey: "fromPhone.places.names") }
    }

    /// Places: noticing visits is paused (what is stored stays until sent or deleted).
    static var placesPaused: Bool {
        get { defaults.bool(forKey: "fromPhone.places.paused") }
        set { defaults.set(newValue, forKey: "fromPhone.places.paused") }
    }

    /// Places: the graph visits are sent to (the one open when Places was turned on). Automatic sends happen only
    /// while that graph is the current one, so visits never land in a graph the person didn't choose.
    static var placesGraphId: String? {
        get { defaults.string(forKey: "fromPhone.places.graph") }
        set { defaults.set(newValue, forKey: "fromPhone.places.graph") }
    }
    static var placesGraphName: String? {
        get { defaults.string(forKey: "fromPhone.places.graphName") }
        set { defaults.set(newValue, forKey: "fromPhone.places.graphName") }
    }

    // MARK: Last send

    static func lastOutcome(_ i: PhoneImporter) -> ImportOutcome? {
        guard let d = defaults.data(forKey: "fromPhone.\(i.rawValue).last") else { return nil }
        let dec = JSONDecoder(); dec.dateDecodingStrategy = .secondsSince1970
        return try? dec.decode(ImportOutcome.self, from: d)
    }

    static func setLastOutcome(_ i: PhoneImporter, _ o: ImportOutcome?) {
        guard let o else { defaults.removeObject(forKey: "fromPhone.\(i.rawValue).last"); return }
        let enc = JSONEncoder(); enc.dateEncodingStrategy = .secondsSince1970
        defaults.set(try? enc.encode(o), forKey: "fromPhone.\(i.rawValue).last")
    }

    // MARK: What was sent (per server and graph)

    private static func ledgerFile(_ i: PhoneImporter, graphId: String) -> URL {
        let host = ServerConfig.current.host ?? "server"
        let safe = "\(host)-\(graphId)-\(i.rawValue)".replacingOccurrences(of: "[^A-Za-z0-9._-]", with: "_", options: .regularExpression)
        return dir.appendingPathComponent("sent-\(safe).json")
    }

    static func ledger(_ i: PhoneImporter, graphId: String) -> [String: String] {
        guard let d = try? Data(contentsOf: ledgerFile(i, graphId: graphId)) else { return [:] }
        return (try? JSONDecoder().decode([String: String].self, from: d)) ?? [:]
    }

    static func saveLedger(_ l: [String: String], _ i: PhoneImporter, graphId: String) {
        guard let d = try? JSONEncoder().encode(l) else { return }
        try? d.write(to: ledgerFile(i, graphId: graphId), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    /// Forgets what was sent for one source (every graph), so the next send carries everything again.
    static func forgetLedgers(_ i: PhoneImporter) {
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        for f in files where f.lastPathComponent.hasPrefix("sent-") && f.lastPathComponent.hasSuffix("-\(i.rawValue).json") {
            try? FileManager.default.removeItem(at: f)
        }
    }

    // MARK: Visits kept on the phone

    private static var visitsFile: URL { dir.appendingPathComponent("visits.json") }

    static func visits() -> [StoredVisit] {
        guard let d = try? Data(contentsOf: visitsFile) else { return [] }
        let dec = JSONDecoder(); dec.dateDecodingStrategy = .secondsSince1970
        return (try? dec.decode([StoredVisit].self, from: d)) ?? []
    }

    static func saveVisits(_ v: [StoredVisit]) {
        let enc = JSONEncoder(); enc.dateEncodingStrategy = .secondsSince1970
        guard let d = try? enc.encode(v) else { return }
        // Visits arrive while the phone is locked, so the file must stay writable after first unlock.
        try? d.write(to: visitsFile, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    static func deleteVisits() {
        try? FileManager.default.removeItem(at: visitsFile)
        forgetLedgers(.places)
    }

    /// Everything kept for one source, when it is turned off.
    static func reset(_ i: PhoneImporter) {
        setLastOutcome(i, nil)
        if i == .places { deleteVisits(); placesGraphId = nil; placesGraphName = nil; placesPaused = false }
    }
}

/// Sends batches to `POST /api/import/<importer>`. Each successful batch is written into the ledger at once, so a
/// failure half-way keeps what already arrived and the rest goes next time.
enum PhoneImportClient {
    struct Answer: Decodable { let sourceId: String?; let duplicate: Bool? }

    /// Sends `items` (already filtered to what changed) in batches; returns how many were sent and how many are left.
    static func send<T: Encodable>(
        _ importer: PhoneImporter, items: [T], id: (T) -> String, title: String, graphId: String,
        wrap: ([T]) -> any Encodable, api: API = .shared,
        progress: (@MainActor (Int, Int) -> Void)? = nil
    ) async -> (sent: Int, left: Int, error: String?) {
        var ledger = PhoneImportStore.ledger(importer, graphId: graphId)
        let batches = PhoneImportKit.batches(items, maxCount: importer.maxItems)
        var sent = 0
        for (n, batch) in batches.enumerated() {
            await progress?(sent, items.count)
            do {
                let label = batches.count > 1 ? "\(title) (\(n + 1)/\(batches.count))" : title
                let body = try PhoneImportKit.body(title: String(label.prefix(250)), visibility: PhoneImportStore.visibility(importer), data: AnyEncodable(wrap(batch)))
                var req = api.request("POST", "/api/import/\(importer.rawValue)")
                req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                req.httpBody = body
                req.timeoutInterval = 180
                _ = try await api.send(req)
                for item in batch { ledger[id(item)] = PhoneImportKit.fingerprint(item) }
                PhoneImportStore.saveLedger(ledger, importer, graphId: graphId)
                sent += batch.count
            } catch {
                if error.isCancellation { return (sent, items.count - sent, nil) }
                return (sent, items.count - sent, sendError(error))
            }
        }
        await progress?(sent, items.count)
        return (sent, 0, nil)
    }

    private static func sendError(_ error: Error) -> String {
        if case APIError.notFound = error {
            return String(localized: "This server can't take imports from the iPhone yet. Update My Graph on the server and try again.")
        }
        if case APIError.tooMany = error {
            return String(localized: "Sent as much as the server takes for now. The rest goes in a few minutes.")
        }
        return error.plainMessage
    }
}

/// Lets a batch's wrapper (`ContactsData`, `PhotosData` …) be encoded inside the generic envelope.
struct AnyEncodable: Encodable {
    let value: any Encodable
    init(_ v: any Encodable) { value = v }
    func encode(to encoder: Encoder) throws { try value.encode(to: encoder) }
}
