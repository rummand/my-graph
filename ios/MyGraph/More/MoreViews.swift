import SwiftUI
import UserNotifications

/// What the assistant remembers across chats: family rules, preferences and notes.
struct MemoryView: View {
    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
    @State private var data: MemoryResponse?
    @State private var error: String?

    private let kinds: [(String, LocalizedStringKey)] = [("rule", "Family rules"), ("preference", "Preferences"), ("note", "Notes")]

    var body: some View {
        List {
            if let d = data {
                if d.memories.isEmpty {
                    EmptyStateView(title: "Nothing remembered yet",
                                   message: "When you tell the assistant something to keep in mind, like “reminders the evening before”, it shows up here.",
                                   systemImage: "brain")
                        .listRowBackground(Color.clear)
                }
                ForEach(kinds, id: \.0) { kind, title in
                    let list = d.memories.filter { $0.kind == kind }
                    if !list.isEmpty {
                        Section { ForEach(list) { m in row(m) } } header: { Text(title) }
                    }
                }
            } else if let error {
                ErrorStateView(message: error) { await load() }.listRowBackground(Color.clear)
            } else {
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .refreshable { await load() }
        .navigationTitle(Text("Memory"))
        .task { await load() }
    }

    private func row(_ m: MemoryItem) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(m.text).mgFont(.body).foregroundStyle(m.status == "paused" ? Color.mgMuted : Color.mgFg)
            if let about = m.about, !about.isEmpty {
                FlowLayout(spacing: 4) {
                    ForEach(about, id: \.id) { a in
                        if a.type == "person" { PersonChip(name: a.label, id: a.id) } else { NodeChip(label: a.label, type: a.type) }
                    }
                }
            }
            HStack(spacing: 6) {
                if let f = m.from?.label {
                    Button { if let r = Route.fromWebHref(m.from?.href) { router.push(r) } } label: {
                        Text(f).mgFont(.meta).foregroundStyle(Color.mgAccent).lineLimit(1)
                    }
                    .buttonStyle(.plain)
                }
                if m.status == "paused" { StateBadge(text: String(localized: "Paused"), tone: .muted) }
                if m.status == "proposed" { StateBadge(text: String(localized: "Waiting for you"), tone: .warn) }
            }
        }
        .padding(.vertical, 3)
        .listRowBackground(Color.mgSurface)
        .swipeActions {
            if m.canEdit == true {
                Button(role: .destructive) { Task { await forget(m) } } label: { Label("Forget", systemImage: "trash") }
                Button { Task { await togglePause(m) } } label: {
                    Label(m.status == "paused" ? "Resume" : "Pause", systemImage: m.status == "paused" ? "play" : "pause")
                }
            }
        }
    }

    private func load() async {
        do { data = try await API.shared.get("/api/memory"); error = nil }
        catch { if !error.isCancellation, data == nil { self.error = error.plainMessage } }
    }

    private func forget(_ m: MemoryItem) async {
        do { _ = try await API.shared.send(API.shared.request("DELETE", "/api/memory/\(m.id)")); await load() }
        catch { app.banner = error.plainMessage }
    }

    private func togglePause(_ m: MemoryItem) async {
        do { _ = try await API.shared.send(API.shared.request("PATCH", "/api/memory/\(m.id)", json: ["status": m.status == "paused" ? "active" : "paused"])); await load() }
        catch { app.banner = error.plainMessage }
    }
}

/// Change sets: proposed changes that don't touch the graph until a person delivers them.
struct ChangesView: View {
    @Environment(AppModel.self) private var app
    @State private var sets: [ChangeSet]?
    @State private var unavailable = false
    @State private var error: String?
    @State private var busy: Set<String> = []
    @State private var status = "draft"

    var body: some View {
        List {
            Section {
                Picker("Show", selection: $status) {
                    Text("Waiting").tag("draft")
                    Text("Delivered").tag("delivered")
                    Text("Dropped").tag("abandoned")
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
            }
            if unavailable {
                EmptyStateView(title: "Changes aren't on this server yet",
                               message: "When the assistant proposes changes to your graph, you'll review and deliver them here. Your server needs an update first.",
                               systemImage: "arrow.triangle.branch")
                    .listRowBackground(Color.clear)
            } else if let sets {
                if sets.isEmpty {
                    EmptyStateView(title: status == "draft" ? "Nothing waiting" : "Nothing here",
                                   message: "Proposed changes from chats, uploads and check-ins show up here. Nothing is added to your graph until you deliver it.",
                                   systemImage: "checkmark.circle")
                        .listRowBackground(Color.clear)
                }
                ForEach(sets) { c in
                    if status == "draft" {
                        ChangeSetCard(set: c, busy: busy.contains(c.id)) { action in Task { await act(c, action) } }
                            .listRowBackground(Color.clear)
                            .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                    } else {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(c.title).mgFont(.bodyStrong)
                            if let d = c.createdAt { Text(Fmt.relative(d)).mgFont(.meta).foregroundStyle(Color.mgMuted) }
                        }
                        .listRowBackground(Color.mgSurface)
                    }
                }
            } else if let error {
                ErrorStateView(message: error) { await load() }.listRowBackground(Color.clear)
            } else {
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .refreshable { await load() }
        .navigationTitle(Text("Changes"))
        .task(id: status) { await load() }
    }

    private func load() async {
        do {
            let r: ChangeSetsResponse = try await API.shared.get("/api/changes", query: ["status": status, "limit": "50"])
            sets = r.changeSets; unavailable = false; error = nil
        } catch let e as APIError {
            if case .notFound = e { unavailable = true } else if sets == nil { error = e.plainMessage }
        } catch {
            if !error.isCancellation, sets == nil { self.error = error.plainMessage }
        }
    }

    private func act(_ c: ChangeSet, _ action: String) async {
        busy.insert(c.id); defer { busy.remove(c.id) }
        do {
            try await API.shared.post("/api/changes/\(c.id)/\(action)")
            if action == "deliver" { Haptics.success() }
            sets?.removeAll { $0.id == c.id }
        } catch { app.banner = error.plainMessage; Haptics.warning() }
    }
}

struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    @State private var notifications: UNAuthorizationStatus = .notDetermined
    @State private var showServer = false
    @State private var versionTaps = 0
    @State private var showLicense = false

    var body: some View {
        List {
            Section {
                HStack(spacing: 12) {
                    Avatar(name: app.myName ?? "?", id: app.myPersonId, size: 40)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(app.myName ?? String(localized: "Signed in")).mgFont(.bodyStrong)
                        Text(app.currentGraph?.name ?? "").mgFont(.secondary).foregroundStyle(Color.mgMuted)
                    }
                }
                .listRowBackground(Color.mgSurface)
            }
            Section {
                HStack {
                    Text("Reminders on this iPhone")
                    Spacer()
                    Text(notificationLabel).foregroundStyle(Color.mgMuted)
                }
                .listRowBackground(Color.mgSurface)
                if notifications == .notDetermined {
                    Button("Turn on reminders") {
                        Task { _ = await ReminderNotifications.requestPermission(); await refreshStatus(); await ReminderNotifications.refresh() }
                    }
                    .listRowBackground(Color.mgSurface)
                } else {
                    Button("Change in iOS Settings") { if let u = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(u) } }
                        .listRowBackground(Color.mgSurface)
                }
            } header: { Text("Notifications") } footer: {
                Text("A notification when a reminder is due. Refreshed when you open the app and now and then in the background.")
            }
            Section {
                Button("Language") { if let u = URL(string: UIApplication.openSettingsURLString) { openURL(u) } }
                    .listRowBackground(Color.mgSurface)
            } footer: { Text("My Graph follows your iPhone's language. English and Danish are available.") }
            Section {
                Button { showServer = true } label: {
                    HStack { Text("Server"); Spacer(); Text(ServerConfig.current.host ?? "").foregroundStyle(Color.mgMuted) }
                }
                .listRowBackground(Color.mgSurface)
            } footer: { Text("Changing the server signs you out of this one.") }
            Section {
                Button("Font licence (SIL Open Font License)") { showLicense = true }.listRowBackground(Color.mgSurface)
                HStack { Text("Version"); Spacer(); Text(version).foregroundStyle(Color.mgMuted) }
                    .contentShape(Rectangle())
                    .onTapGesture { versionTaps += 1 }
                    .listRowBackground(Color.mgSurface)
            }
            Section {
                Button("Sign out", role: .destructive) { Task { await app.signOut() } }.listRowBackground(Color.mgSurface)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .navigationTitle(Text("Settings"))
        .task { await refreshStatus() }
        .sheet(isPresented: $showServer) {
            ServerSettingsSheet(showDebug: versionTaps >= 7 || ServerConfig.isLocal)
                .onDisappear { Task { await app.bootstrap() } }
        }
        .sheet(isPresented: $showLicense) { LicenseView() }
    }

    private var version: String {
        let v = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
        let b = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "1"
        return "\(v) (\(b))"
    }

    private var notificationLabel: String {
        switch notifications {
        case .authorized, .provisional, .ephemeral: return String(localized: "On")
        case .denied: return String(localized: "Off")
        default: return String(localized: "Not set up")
        }
    }

    private func refreshStatus() async { notifications = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus }
}

struct LicenseView: View {
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView {
                Text(license).mgFont(.secondary).padding(16).frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(Color.mgBg)
            .navigationTitle(Text("Schibsted Grotesk"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
    private var license: String {
        guard let u = Bundle.main.url(forResource: "OFL", withExtension: "txt"), let s = try? String(contentsOf: u, encoding: .utf8) else { return "" }
        return s
    }
}
