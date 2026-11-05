import SwiftUI
import PhotosUI

enum SettingsTab: String, Hashable { case account, sources, general }

struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @Binding var tab: SettingsTab

    var body: some View {
        TabView(selection: $tab) {
            AccountTab().tabItem { Label(L("Account"), systemImage: "person.crop.circle") }.tag(SettingsTab.account)
            SourcesTab().tabItem { Label(L("Sources"), systemImage: "arrow.up.doc.on.clipboard") }.tag(SettingsTab.sources)
            GeneralTab().tabItem { Label(L("General"), systemImage: "gearshape") }.tag(SettingsTab.general)
        }
        .frame(width: 620)
        .tint(Color.mgAccent)
    }
}

// MARK: - Account

struct AccountTab: View {
    @Environment(AppModel.self) private var app
    @Environment(SyncEngine.self) private var sync
    @State private var email = ""
    @State private var password = ""
    @State private var server = ServerConfig.current.absoluteString
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        Form {
            if app.phase == .signedIn {
                Section {
                    LabeledContent(L("Signed in as")) {
                        VStack(alignment: .trailing, spacing: 2) {
                            Text(app.me?.name ?? "—")
                            if let e = app.me?.email { Text(e).foregroundStyle(.secondary).font(.callout) }
                        }
                    }
                    LabeledContent(L("Graph")) {
                        Picker("", selection: Binding(get: { app.currentGraph?.id ?? "" }, set: { id in
                            if let g = app.graphs.first(where: { $0.id == id }) { Task { await app.switchGraph(to: g) } }
                        })) {
                            ForEach(app.graphs) { g in Text(g.name).tag(g.id) }
                        }
                        .labelsHidden().frame(maxWidth: 240)
                    }
                    LabeledContent(L("Server")) { Text(ServerConfig.origin).foregroundStyle(.secondary).textSelection(.enabled) }
                    LabeledContent(L("This Mac")) {
                        if sync.hasToken {
                            Label(L("Connected as “\(DeviceName.current)”"), systemImage: "checkmark.circle").foregroundStyle(Color.mgOK)
                        } else {
                            Button(L("Connect this Mac")) { Task { await app.registerDevice() } }
                        }
                    }
                    if let p = app.deviceProblem { Text(p).foregroundStyle(Color.mgDanger).font(.callout) }
                    if !app.hasSession {
                        Text(L("Your session has ended. Syncing goes on, but Ask and Quick note need you to sign in again."))
                            .font(.callout).foregroundStyle(Color.mgWarn)
                    }
                } footer: {
                    Text(L("This Mac sends only what you turn on under Sources, to the graph shown here. Nothing is added to your graph until you approve it in My Graph."))
                        .foregroundStyle(.secondary)
                }
                Section {
                    HStack {
                        Button(L("Open My Graph")) { Web.open("/") }
                        Spacer()
                        Button(L("Sign out"), role: .destructive) { Task { await app.signOut() } }
                    }
                }
            } else if app.phase == .pending {
                Section {
                    Text(L("A parent needs to approve this Mac before you can use My Graph here.")).fixedSize(horizontal: false, vertical: true)
                    Button(L("Check again")) { Task { await app.checkPending() } }
                }
            } else {
                signInForm
            }
        }
        .formStyle(.grouped)
        .frame(minHeight: 380)
    }

    private var signInForm: some View {
        Section {
            if let r = app.signOutReason { Text(r).foregroundStyle(.secondary) }
            TextField(L("Server"), text: $server).textContentType(.URL)
            TextField(L("Email"), text: $email).textContentType(.username)
            SecureField(L("Password"), text: $password).textContentType(.password).onSubmit(signIn)
            if let error { Text(error).foregroundStyle(Color.mgDanger).font(.callout).fixedSize(horizontal: false, vertical: true) }
            HStack {
                Button(L("Sign in with a passkey")) { passkey() }.disabled(busy || ServerConfig.isLocal)
                Spacer()
                if busy { ProgressView().controlSize(.small) }
                Button(L("Sign in"), action: signIn).keyboardShortcut(.defaultAction).disabled(busy || email.isEmpty || password.isEmpty)
            }
        } header: {
            Text(L("Sign in to My Graph"))
        } footer: {
            Text(L("Use the same email and password as on the web. Signing in connects this Mac; you choose what it sends under Sources."))
                .foregroundStyle(.secondary)
        }
    }

    private func applyServer() -> Bool {
        guard let u = ServerConfig.parse(server) else { error = L("That doesn't look like a web address."); return false }
        if u != ServerConfig.current { ServerConfig.current = u; CookieVault.restore() }
        return true
    }

    private func signIn() {
        guard !busy, applyServer() else { return }
        busy = true; error = nil
        Task {
            defer { busy = false }
            do { try await app.signIn(email: email.trimmingCharacters(in: .whitespaces), password: password); password = "" }
            catch { self.error = error.plainMessage }
        }
    }

    private func passkey() {
        guard !busy, applyServer() else { return }
        busy = true; error = nil
        Task {
            defer { busy = false }
            do { try await app.signInWithPasskey() } catch is CancellationError {} catch {
                self.error = L("This Mac can't use a passkey for this server yet (a signed build is needed). Sign in with your password.")
            }
        }
    }
}

// MARK: - Sources

struct SourcesTab: View {
    @Environment(SyncEngine.self) private var sync

    var body: some View {
        ScrollView { SourcesList() }
            .frame(height: 560)
            .task { sync.refreshPermissions(); await sync.refreshSettings() }
    }
}

struct SourcesList: View {
    @Environment(SyncEngine.self) private var sync
    @Environment(AppModel.self) private var app

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "hand.raised").foregroundStyle(Color.mgAccent).font(.system(size: 15))
                Text(L("Each source is off until you turn it on. What this Mac sends arrives in My Graph as proposals, and nothing is added to your graph until you approve it."))
                    .font(.callout).fixedSize(horizontal: false, vertical: true)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.mgAccentTint))
            if app.phase != .signedIn || !sync.hasToken {
                Text(L("Sign in under Account first.")).foregroundStyle(.secondary)
            }
            ForEach(SourceID.allCases) { id in SourceCard(id: id) }
        }
        .padding(20)
    }
}

struct SourceCard: View {
    @Environment(SyncEngine.self) private var sync
    let id: SourceID
    @State private var busy = false
    @State private var error: String?
    @State private var picked: [PhotosPickerItem] = []

    var body: some View {
        let on = sync.settings.isOn(id)
        let perm = sync.permissions[id] ?? .notAsked
        let s = sync.state[id]
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 10) {
                Image(systemName: SourceInfo.symbol(id)).font(.system(size: 16)).frame(width: 22).foregroundStyle(.secondary)
                Text(SourceInfo.title(id)).font(.system(size: 14, weight: .semibold))
                Spacer()
                if busy { ProgressView().controlSize(.small) }
                Toggle("", isOn: Binding(get: { on }, set: { v in toggle(v) }))
                    .toggleStyle(.switch).labelsHidden().disabled(busy || !sync.hasToken)
                    .accessibilityLabel(Text(L("Send \(SourceInfo.title(id))")))
            }
            Text(SourceInfo.explanation(id)).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                permissionChip(perm)
                Spacer()
                extra
                if on {
                    Button(L("Send now")) { Task { await sync.sendNow(id) } }
                        .disabled(sync.isSyncing || !perm.isUsable && id != .photos)
                }
            }
            if (on || s.lastRunAt != nil) && !(s.needsPerson && !perm.isUsable) {
                Text(result(s)).font(.caption).foregroundStyle(s.lastError != nil ? Color.mgDanger : .secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let error { Text(error).font(.caption).foregroundStyle(Color.mgDanger) }
            if id == .folders { FoldersList() }
            if id == .messages && on {
                Text(sync.settings.chats.isEmpty ? L("No conversations chosen yet.") : L("\(sync.settings.chats.count) conversations chosen in My Graph."))
                    .font(.caption).foregroundStyle(sync.settings.chats.isEmpty ? Color.mgWarn : .secondary)
            }
            if id == .calendar || id == .reminders { writeBack }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .controlBackgroundColor)))

    }

    /// Write-back is its own choice: sending from Calendar or Reminders and receiving what was approved are separate.
    @ViewBuilder private var writeBack: some View {
        let events = id == .calendar
        Divider().padding(.vertical, 2)
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(events ? L("Show approved events in a “My Graph” calendar") : L("Keep your My Graph reminders in a “My Graph” list"))
                Text(events ? L("Upcoming events from My Graph, read-only. Your other calendars are never changed.")
                            : L("Tick one off in Reminders and it is done in My Graph too. Your other lists are never changed."))
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            Toggle("", isOn: Binding(get: { events ? sync.settings.writeBackEvents : sync.settings.writeBackReminders }, set: { v in
                busy = true
                Task {
                    defer { busy = false }
                    do { try await events ? sync.setWriteBack(events: v) : sync.setWriteBack(reminders: v) } catch { self.error = error.plainMessage }
                }
            }))
            .labelsHidden()
            .toggleStyle(.switch).controlSize(.small).disabled(busy || !sync.hasToken)
        }
    }

    @ViewBuilder private var extra: some View {
        switch id {
        case .messages:
            Button(L("Choose conversations…")) { Task { await sync.chooseOnWeb(.messages) } }
                .disabled(!(sync.permissions[.messages]?.isUsable ?? false))
                .help(L("Sends the list of conversations (names only) and opens My Graph, where you tick the ones to send."))
        case .notes:
            Button(L("Choose folders…")) { Task { await sync.chooseOnWeb(.notes) } }
                .help(L("Sends the list of Notes folders (names only) and opens My Graph, where you choose."))
        case .folders:
            Button(L("Add folder…")) { addFolder() }
        case .photos:
            PhotosPicker(selection: $picked, maxSelectionCount: 100, matching: .images, photoLibrary: .shared()) {
                Text(L("Send photos…"))
            }
            .disabled(!sync.hasToken)
            .onChange(of: picked) { _, items in sendPicked(items) }
            Toggle(L("Details of every photo"), isOn: Binding(get: { sync.state.photosLibraryOptIn },
                                                               set: { v in Task { await sync.setPhotosLibrary(v) } }))
                .toggleStyle(.checkbox).disabled(!sync.settings.isOn(.photos))
        default:
            EmptyView()
        }
    }

    @ViewBuilder private func permissionChip(_ p: Permission) -> some View {
        let color: Color = p.isUsable ? .mgOK : (p == .unavailable ? .secondary : .mgWarn)
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(p.label).font(.caption).foregroundStyle(.secondary)
            switch p {
            case .needsFullDiskAccess:
                Button(L("Open System Settings")) { Permissions.openFullDiskAccess() }.controlSize(.small)
            case .notAsked, .needsAutomation:
                Button(L("Allow…")) { Task { await sync.requestPermission(id) } }.controlSize(.small)
            case .denied:
                Button(L("Open System Settings")) { openPane() }.controlSize(.small)
            default: EmptyView()
            }
        }
    }

    private func openPane() {
        switch id {
        case .contacts: Permissions.openPrivacy("Privacy_Contacts")
        case .calendar: Permissions.openPrivacy("Privacy_Calendars")
        case .reminders: Permissions.openPrivacy("Privacy_Reminders")
        case .photos: Permissions.openPrivacy("Privacy_Photos")
        case .notes: Permissions.openPrivacy("Privacy_Automation")
        default: Permissions.openFullDiskAccess()
        }
    }

    private func result(_ s: SourceState) -> String {
        if sync.running == id { return L("Sending…") }
        if let e = s.lastError { return e }
        return SourceStatusRow.result(s)
    }

    private func toggle(_ v: Bool) {
        busy = true; error = nil
        Task {
            defer { busy = false }
            do { try await sync.setEnabled(id, v) } catch { self.error = error.plainMessage }
        }
    }

    private func addFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = true
        panel.prompt = L("Watch folder")
        panel.message = L("My Graph sends new and changed files from these folders. Nothing is added to your graph until you approve it.")
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK else { return }
        Task { for u in panel.urls { await sync.addFolder(u) } }
    }

    private func sendPicked(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        busy = true; error = nil
        Task {
            defer { busy = false; picked = [] }
            do {
                let n = try await PhotosMacSource.sendPicked(items, visibility: sync.settings.visibility ?? "private")
                error = nil
                sync.noteSent(.photos, n)
            } catch { self.error = error.plainMessage }
        }
    }
}

struct FoldersList: View {
    @Environment(SyncEngine.self) private var sync

    var body: some View {
        if !sync.state.folders.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(sync.state.folders) { f in
                    HStack {
                        Image(systemName: "folder").foregroundStyle(.secondary)
                        Text(f.path.replacingOccurrences(of: NSHomeDirectory(), with: "~")).lineLimit(1).truncationMode(.middle)
                        Spacer()
                        Button { Task { await sync.removeFolder(f) } } label: { Image(systemName: "minus.circle") }
                            .buttonStyle(.borderless).help(L("Stop watching this folder"))
                    }
                    .font(.callout)
                }
            }
            .padding(.top, 2)
        }
    }
}

// MARK: - General

struct GeneralTab: View {
    @State private var atLogin = LoginItem.isOn
    @State private var loginError: String?
    @State private var ask = Shortcuts.ask
    @State private var note = Shortcuts.note

    var body: some View {
        Form {
            Section {
                Toggle(L("Open My Graph when you log in"), isOn: Binding(get: { atLogin }, set: { v in
                    loginError = LoginItem.set(v); atLogin = LoginItem.isOn
                }))
                if LoginItem.needsApproval {
                    HStack {
                        Text(L("Allow My Graph under Login Items in System Settings.")).font(.callout).foregroundStyle(Color.mgWarn)
                        Button(L("Open")) { LoginItem.openSettings() }
                    }
                }
                if let loginError { Text(loginError).font(.callout).foregroundStyle(Color.mgDanger) }
            } footer: {
                Text(L("My Graph sends what you turned on every 15 minutes, and soon after files, calendars or reminders change.")).foregroundStyle(.secondary)
            }
            Section(L("Keyboard shortcuts")) {
                LabeledContent(L("Ask My Graph")) { ShortcutRecorder(combo: $ask) { Shortcuts.ask = $0 } }
                LabeledContent(L("Quick note")) { ShortcutRecorder(combo: $note) { Shortcuts.note = $0 } }
                if !Panels.shared.takenShortcuts.isEmpty {
                    Text(L("Another app already uses one of these shortcuts. Click it and type a different one."))
                        .font(.callout).foregroundStyle(Color.mgWarn)
                }
                Text(L("Shortcuts work in every app. Also in the Shortcuts app: “Ask My Graph” and “Add note to My Graph”."))
                    .font(.callout).foregroundStyle(.secondary)
            }
            Section(L("Notifications")) {
                Text(L("My Graph tells you when proposals are waiting for you, and when a source needs you (a permission, a sign-in)."))
                    .font(.callout).foregroundStyle(.secondary)
                Button(L("Notification settings…")) { Permissions.open("x-apple.systempreferences:com.apple.Notifications-Settings.extension", fallback: "x-apple.systempreferences:com.apple.preference.notifications") }
            }
            Section {
                LabeledContent(L("Version")) {
                    Text(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0").foregroundStyle(.secondary)
                }
                LabeledContent(L("Kept on this Mac")) {
                    Button(L("Show in Finder")) { NSWorkspace.shared.activateFileViewerSelecting([StateStore.defaultDirectory]) }
                }
            }
        }
        .formStyle(.grouped)
        .frame(minHeight: 440)
    }
}

/// Click, then press the new combination (⌘, ⌥ or ⌃ plus a key). Escape cancels; Delete clears.
struct ShortcutRecorder: View {
    @Binding var combo: KeyCombo?
    var onChange: (KeyCombo?) -> Void
    @State private var recording = false
    @State private var monitor: Any?

    var body: some View {
        HStack(spacing: 6) {
            Button {
                recording ? stop() : start()
            } label: {
                Text(recording ? L("Type the shortcut…") : (combo?.display ?? L("None")))
                    .frame(minWidth: 120)
            }
            if combo != nil && !recording {
                Button { combo = nil; onChange(nil) } label: { Image(systemName: "xmark.circle.fill") }
                    .buttonStyle(.borderless).foregroundStyle(.secondary).help(L("Remove shortcut"))
            }
        }
        .onDisappear(perform: stop)
    }

    private func start() {
        recording = true
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { e in
            if e.keyCode == 53 { stop(); return nil }
            if e.keyCode == 51 { combo = nil; onChange(nil); stop(); return nil }
            if let c = KeyCombo(event: e) { combo = c; onChange(c); stop(); return nil }
            return nil
        }
    }

    private func stop() {
        recording = false
        if let m = monitor { NSEvent.removeMonitor(m); monitor = nil }
    }
}
