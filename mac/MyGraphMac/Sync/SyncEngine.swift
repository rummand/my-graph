import Foundation
import Observation
import EventKit
import Contacts
import Photos

/// Runs the sources: every 15 minutes, when files or calendars change, and when the person presses "Send now".
/// One run at a time; a source that failed waits longer each time (exponential backoff); a source the server switched
/// off (409) stops until the settings say otherwise. Nothing is sent while paused or signed out.
@MainActor
@Observable
final class SyncEngine {
    static let shared = SyncEngine()

    let store = StateStore()
    let api = MacAPI.shared
    let sources: [SourceID: any MacSource] = [
        .messages: MessagesSource(), .notes: NotesSource(), .contacts: ContactsMacSource(), .calendar: CalendarMacSource(),
        .reminders: RemindersMacSource(), .photos: PhotosMacSource(), .folders: FoldersMacSource(),
        .voiceMemos: VoiceMemosMacSource(), .calls: CallsMacSource(),
    ]

    static let interval: TimeInterval = 15 * 60

    /// What the UI shows.
    private(set) var state: SyncState
    private(set) var settings = MacSettings()
    private(set) var settingsLoaded = false
    private(set) var status = MacStatus()
    private(set) var running: SourceID?
    private(set) var isSyncing = false
    /// A problem with the whole connection (signed out, offline, old server).
    private(set) var problem: String?
    private(set) var permissions: [SourceID: Permission] = [:]

    var paused: Bool { state.paused }
    var hasToken: Bool { MacToken.load() != nil }

    private var loop: Task<Void, Never>?
    private var pending: Set<SourceID> = []
    private var debounce: Task<Void, Never>?
    private var watcher: FolderWatcher?
    private var observers: [NSObjectProtocol] = []
    private var lastStatusAt: Date?
    private var asking: Set<SourceID> = []

    init() {
        state = store.load()
        refreshPermissions()
    }

    // MARK: Lifecycle

    func start() {
        guard loop == nil else { return }
        if ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil { return }
        bind()
        observeChanges()
        restartWatcher()
        loop = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            while !Task.isCancelled {
                await self?.tick()
                try? await Task.sleep(for: .seconds(60))
            }
        }
    }

    func stop() {
        loop?.cancel(); loop = nil
        watcher?.stop(); watcher = nil
    }

    /// Cursors belong to one server and graph.
    func bind() {
        state = store.update { $0.rebind(server: ServerConfig.origin, graphId: settings.graphId ?? $0.graphId) }
    }

    private func observeChanges() {
        guard observers.isEmpty else { return }
        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: .EKEventStoreChanged, object: EventStore.shared, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.trigger([.calendar, .reminders], writeBack: true) }
        })
        observers.append(nc.addObserver(forName: .CNContactStoreDidChange, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.trigger([.contacts]) }
        })
    }

    /// Watches the chosen folders and the Voice Memos folder (FSEvents) and sends what changed a few seconds later.
    func restartWatcher() {
        watcher?.stop()
        var paths: [String] = state.folders.compactMap { FoldersMacSource.resolve($0)?.path }
        if settings.isOn(.voiceMemos), FileManager.default.fileExists(atPath: VoiceMemosMacSource.folder) { paths.append(VoiceMemosMacSource.folder) }
        guard !paths.isEmpty else { watcher = nil; return }
        let voice = VoiceMemosMacSource.folder
        watcher = FolderWatcher(paths: paths) { [weak self] changed in
            Task { @MainActor in
                let isVoice = changed.contains { $0.hasPrefix(voice) }
                let isFolder = changed.contains { !$0.hasPrefix(voice) }
                var s: Set<SourceID> = []
                if isVoice { s.insert(.voiceMemos) }
                if isFolder { s.insert(.folders) }
                self?.trigger(s)
            }
        }
        watcher?.start()
    }

    // MARK: Triggers

    /// Runs these sources soon (changes come in bursts, so a few seconds of quiet first).
    func trigger(_ ids: Set<SourceID>, writeBack: Bool = false) {
        pending.formUnion(ids)
        if writeBack { pending.insert(.reminders) }
        debounce?.cancel()
        debounce = Task { [weak self] in
            try? await Task.sleep(for: .seconds(5))
            guard let self, !Task.isCancelled else { return }
            let ids = self.pending
            self.pending = []
            await self.run(only: ids, force: false, writeBack: writeBack)
        }
    }

    /// "Send now" for one source (ignores the wait after failures), or for all.
    func sendNow(_ id: SourceID? = nil) async {
        await run(only: id.map { [$0] }, force: true, writeBack: id == nil || id == .calendar || id == .reminders)
    }

    func setPaused(_ p: Bool) {
        state = store.update { $0.paused = p }
        if !p { Task { await sendNow() } }
    }

    /// Every minute: run when a source is due (15 minutes since it last ran, or its wait after a failure is over), and
    /// check the badge and the outbox every 5 minutes.
    private func tick() async {
        let now = Date()
        let s = store.load()
        let due = !settingsLoaded || SourceID.allCases.contains { id in
            guard settings.isOn(id) else { return false }
            let st = s[id]
            if let next = st.nextTryAt { return next <= now }
            guard let last = st.lastRunAt else { return true }
            return now.timeIntervalSince(last) >= Self.interval - 30
        }
        let statusDue = lastStatusAt.map { now.timeIntervalSince($0) >= 300 } ?? true
        if due || statusDue { await run(only: nil, force: false, writeBack: true) }
    }

    // MARK: Running

    func refreshPermissions() {
        var p: [SourceID: Permission] = [:]
        for (id, s) in sources { p[id] = s.permission() }
        permissions = p
    }

    func refreshSettings() async {
        guard hasToken else { return }
        do {
            settings = try await api.settings()
            settingsLoaded = true
            problem = nil
            bind()
        } catch let e as MacAPI.Failure {
            problem = e.errorDescription
        } catch {}
    }

    func refreshStatus() async {
        guard hasToken else { return }
        guard let s = try? await api.status() else { return }
        status = s
        lastStatusAt = Date()
        // The first count after signing in is only remembered: the notification is for what arrives later.
        guard let before = state.notifiedWaiting else {
            state = store.update { $0.waiting = s.waiting; $0.notifiedWaiting = s.waiting }
            return
        }
        state = store.update { $0.waiting = s.waiting; if s.waiting < before { $0.notifiedWaiting = s.waiting } }
        if s.waiting > before {
            Notifier.proposalsWaiting(s.waiting, path: s.reviewPath)
            state = store.update { $0.notifiedWaiting = s.waiting }
        }
    }

    private func run(only: Set<SourceID>?, force: Bool, writeBack: Bool) async {
        guard !isSyncing, hasToken else { return }
        if state.paused && !force { return }
        isSyncing = true
        defer { isSyncing = false; running = nil; state = store.load(); refreshPermissions() }

        do {
            settings = try await api.settings()
            settingsLoaded = true
            problem = nil
        } catch let e as MacAPI.Failure {
            problem = e.errorDescription
            if case .unpaired = e { Notifier.problem(key: "unpaired", e.errorDescription ?? "") }
            return
        } catch { return }
        bind()

        // Sources turned on (here or on the web) whose permission macOS hasn't asked about yet: ask now, outside the
        // run (the prompt waits for the person), and send next time.
        for id in [SourceID.contacts, .calendar, .reminders] where settings.isOn(id) && permissions[id] == .notAsked && !asking.contains(id) {
            asking.insert(id)
            Task { await self.requestPermission(id); self.asking.remove(id); if self.permissions[id]?.isUsable == true { await self.sendNow(id) } }
        }

        let runId = UUID().uuidString
        let ctx = SyncContext(api: api, store: store, settings: settings, runId: runId, device: DeviceName.current)
        let now = Date()
        let order: [SourceID] = [.contacts, .calendar, .reminders, .notes, .messages, .calls, .folders, .voiceMemos, .photos]
        for id in order {
            if let only, !only.contains(id) { continue }
            guard settings.isOn(id), let source = sources[id] else { continue }
            if asking.contains(id) { continue }
            let s = store.load()[id]
            if !force {
                if let next = s.nextTryAt, next > now { continue }
                // The 15-minute rhythm, unless a change asked for this source.
                if only == nil, let last = s.lastRunAt, now.timeIntervalSince(last) < Self.interval - 30 { continue }
            }
            running = id
            await runOne(id, source, ctx)
            state = store.load()
            if Task.isCancelled { return }
        }

        if writeBack, settings.writeBackOn || !store.load().outbox.isEmpty {
            do { _ = try await WriteBack.run(api: api, store: store, settings: settings) } catch let e as MacAPI.Failure {
                if case .notFound = e {} else { problem = e.errorDescription }
            } catch {}
        }
        await refreshStatus()
    }

    private func runOne(_ id: SourceID, _ source: any MacSource, _ ctx: SyncContext) async {
        let started = Date()
        do {
            let r = try await source.run(ctx)
            store.update { s in
                s[id].lastRunAt = started
                s[id].lastSuccessAt = Date()
                s[id].lastSent = r.sent
                s[id].lastError = nil
                s[id].needsPerson = false
                s[id].failures = 0
                s[id].nextTryAt = nil
            }
            _ = r
        } catch is CancellationError {
            return
        } catch {
            let (message, needsPerson, wait) = describe(error)
            let failures = store.load()[id].failures + 1
            store.update { s in
                s[id].lastRunAt = started
                s[id].lastError = message
                s[id].needsPerson = needsPerson
                s[id].failures = failures
                s[id].nextTryAt = Date().addingTimeInterval(wait ?? Backoff.delay(failures: failures))
            }
            if needsPerson { Notifier.problem(key: "\(id.rawValue)|\(message)", L("\(SourceInfo.title(id)): \(message)")) }
            if case MacAPI.Failure.switchedOff = error { await refreshSettings() }
        }
    }

    private func describe(_ error: Error) -> (String, Bool, TimeInterval?) {
        if let e = error as? MacAPI.Failure {
            if case .wait(let secs, _) = e { return (e.errorDescription ?? "", false, secs) }
            if case .switchedOff = e { return (e.errorDescription ?? "", false, Self.interval) }
            return (e.errorDescription ?? "", e.needsPerson, nil)
        }
        if let e = error as? SourceError { return (e.errorDescription ?? "", e.needsPerson, e.needsPerson ? Self.interval : nil) }
        return (error.localizedDescription, false, nil)
    }

    // MARK: Choices

    /// Turns a source on or off on the server (asking macOS for permission first when turning on).
    func setEnabled(_ id: SourceID, _ on: Bool) async throws {
        if on { _ = await requestPermission(id) }
        var patch: [String: Any] = ["sources": [id.serverKey: on]]
        if id == .folders, on { patch["folders"] = state.folders.map(\.label) }
        settings = try await api.updateSettings(patch)
        settingsLoaded = true
        if id == .voiceMemos || id == .folders { restartWatcher() }
        if on { Task { await self.sendNow(id) } }
    }

    /// Write-back: approved reminders into a "My Graph" list, approved events into a "My Graph" calendar.
    func setWriteBack(reminders: Bool? = nil, events: Bool? = nil) async throws {
        if reminders == true { _ = await requestPermission(.reminders) }
        if events == true { _ = await requestPermission(.calendar) }
        var w: [String: Any] = [:]
        if let reminders { w["reminders"] = reminders }
        if let events { w["events"] = events }
        settings = try await api.updateSettings(["writeBack": w])
        if reminders == false || events == false {
            // What was written stays where it is; only new changes stop. The server sends deletions when it is
            // turned off, so one more pass removes the copies.
        }
        Task { await self.run(only: [], force: true, writeBack: true) }
    }

    /// Sends the list of conversations or Notes folders (names only) and opens the web page where they're chosen.
    func chooseOnWeb(_ id: SourceID) async {
        let ctx = SyncContext(api: api, store: store, settings: settings, runId: UUID().uuidString, device: DeviceName.current)
        do {
            if id == .messages {
                let list = try MessagesSource().catalog()
                try await ctx.reportCatalog(chats: list, canRead: ["messages": true])
            } else if id == .notes {
                let folders = try await NotesSource().folders()
                try await ctx.reportCatalog(folders: NotesPick.counts(folders), canRead: ["notes": true])
            }
        } catch {
            problem = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        Web.open("/connections/mac")
    }

    /// A folder label the server sees ("Documents/Taxes" style: its name, with its parent's when two names clash).
    static func label(for url: URL, taken: [String]) -> String {
        var label = url.lastPathComponent
        if taken.contains(label) { label = url.deletingLastPathComponent().lastPathComponent + "/" + label }
        var n = 2
        let base = label
        while taken.contains(label) { label = "\(base) \(n)"; n += 1 }
        return String(label.prefix(300))
    }

    func addFolder(_ url: URL) async {
        guard !state.folders.contains(where: { $0.path == url.path }) else { return }
        let label = Self.label(for: url, taken: state.folders.map(\.label))
        state = store.update { s in s.folders.append(WatchedFolder(path: url.path, label: label, bookmark: FoldersMacSource.bookmark(url))) }
        restartWatcher()
        _ = try? await updateSettings(["folders": state.folders.map(\.label)])
        if settings.isOn(.folders) { await sendNow(.folders) }
    }

    func removeFolder(_ f: WatchedFolder) async {
        state = store.update { s in s.folders.removeAll { $0.id == f.id } }
        restartWatcher()
        _ = try? await updateSettings(["folders": state.folders.map(\.label)])
    }

    func updateSettings(_ patch: [String: Any]) async throws {
        settings = try await api.updateSettings(patch)
    }

    /// Asks macOS for what a source needs. Full Disk Access can't be asked for: System Settings opens instead.
    @discardableResult
    func requestPermission(_ id: SourceID) async -> Permission {
        switch id {
        case .contacts:
            if Permissions.contacts == .notAsked { _ = try? await CNContactStore().requestAccess(for: .contacts) }
        case .calendar:
            if Permissions.events(.event) != .granted { _ = await EventStore.requestEvents() }
        case .reminders:
            if Permissions.events(.reminder) != .granted { _ = await EventStore.requestReminders() }
        case .photos:
            if Permissions.photos == .notAsked { _ = await PHAuthorization.request() }
        case .notes:
            _ = await Permissions.askNotesAutomation()
        case .messages, .calls, .voiceMemos:
            if !Permissions.hasFullDiskAccess { Permissions.openFullDiskAccess() }
        case .folders:
            break
        }
        refreshPermissions()
        return permissions[id] ?? .notAsked
    }

    func setPhotosLibrary(_ on: Bool) async {
        if on, Permissions.photos == .notAsked { _ = await PHAuthorization.request() }
        state = store.update { $0.photosLibraryOptIn = on }
        refreshPermissions()
        if on { await sendNow(.photos) }
    }

    #if DEBUG
    func debugDump() {
        print("[debug] settings on: \(SourceID.allCases.filter { settings.isOn($0) }.map(\.rawValue)) writeBack r=\(settings.writeBackReminders) e=\(settings.writeBackEvents) folders=\(settings.folderLabels)")
        print("[debug] permissions: \(permissions.map { "\($0.key.rawValue)=\($0.value)" }.sorted())")
        for id in SourceID.allCases { let s = state[id]; if s.lastRunAt != nil { print("[debug] \(id.rawValue): sent \(s.lastSent) error \(s.lastError ?? "-")") } }
        print("[debug] waiting \(status.waiting) problem \(problem ?? "-") outbox \(state.outbox.count)")
    }
    #endif

    /// Records a send made outside a run (picked photos).
    func noteSent(_ id: SourceID, _ n: Int) {
        state = store.update { s in
            s[id].lastRunAt = Date(); s[id].lastSuccessAt = Date(); s[id].lastSent = n; s[id].lastError = nil
        }
    }

    /// Forget everything about this server's sync on this Mac (signing out).
    func reset() {
        stop()
        state = store.update { s in
            let folders = s.folders
            s = SyncState()
            s.folders = folders
        }
        settings = MacSettings()
        settingsLoaded = false
        status = MacStatus()
        problem = nil
    }
}

enum PHAuthorization {
    static func request() async -> PHAuthorizationStatus { await PHPhotoLibrary.requestAuthorization(for: .readWrite) }
}
