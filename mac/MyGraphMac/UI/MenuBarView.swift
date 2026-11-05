import SwiftUI

/// The menu bar window: the graph, Ask and Quick note, what waits for review, how each source is doing, and the
/// app's own controls. Calm: grey chrome, cobalt only on the count of proposals, brick only on errors.
struct MenuBarView: View {
    @Environment(AppModel.self) private var app
    @Environment(SyncEngine.self) private var sync
    var close: () -> Void = {}

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if app.phase == .signedOut || app.phase == .launching {
                signedOut
            } else {
                header
                Divider().padding(.vertical, 6)
                actions
                Divider().padding(.vertical, 6)
                waiting
                sources
                Divider().padding(.vertical, 6)
            }
            footer
        }
        .padding(.vertical, 8)
        .frame(width: 320)
    }

    // MARK: Parts

    private var header: some View {
        HStack(spacing: 8) {
            Circle().fill(Color.graph(app.currentGraph?.hue ?? 210)).frame(width: 9, height: 9)
            VStack(alignment: .leading, spacing: 1) {
                Text(app.currentGraph?.name ?? L("My Graph")).font(.system(size: 13, weight: .semibold))
                Text(app.me?.name ?? L("Signed in on this Mac")).font(.system(size: 11)).foregroundStyle(.secondary)
            }
            Spacer()
            if app.graphs.count > 1 {
                Menu {
                    ForEach(app.graphs) { g in
                        Button {
                            Task { await app.switchGraph(to: g) }
                        } label: {
                            if g.id == app.currentGraph?.id { Label(g.name, systemImage: "checkmark") } else { Text(g.name) }
                        }
                    }
                } label: {
                    Text(L("Switch"))
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .font(.system(size: 12))
                .help(L("Switch graph: Ask, notes and what this Mac sends go to the graph you pick."))
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 2)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(L("Current graph: \(app.currentGraph?.name ?? "")")))
    }

    private var actions: some View {
        VStack(spacing: 0) {
            MenuRow(L("Ask My Graph…"), symbol: "sparkle.magnifyingglass", shortcut: Shortcuts.ask?.display) {
                close(); Panels.shared.showAsk()
            }
            MenuRow(L("Quick note…"), symbol: "square.and.pencil", shortcut: Shortcuts.note?.display) {
                close(); Panels.shared.showNote()
            }
        }
    }

    private var waiting: some View {
        let n = sync.status.waiting
        return MenuRow(n == 0 ? L("Nothing waiting for you") : L("Waiting for you: \(n)"), symbol: "tray", trailing: {
            if n > 0 {
                // Amber: proposals are decisions waiting for the person (DESIGN.md's colour for "needs a decision").
                Text("\(n)").font(.system(size: 11, weight: .semibold)).monospacedDigit()
                    .padding(.horizontal, 6).padding(.vertical, 1)
                    .background(Capsule().fill(Color.mgWarnTint)).foregroundStyle(Color.mgWarn)
            }
        }) {
            close(); Web.open(sync.status.reviewPath)
        }
    }

    private var sources: some View {
        let on = SourceID.allCases.filter { sync.settings.isOn($0) }
        return VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(L("Sending from this Mac")).font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary)
                Spacer()
                if sync.isSyncing { ProgressView().controlSize(.mini) }
            }
            .padding(.horizontal, 14).padding(.top, 8).padding(.bottom, 4)
            if let p = sync.problem {
                Text(p).font(.system(size: 11)).foregroundStyle(Color.mgDanger).padding(.horizontal, 14).padding(.bottom, 4)
                    .fixedSize(horizontal: false, vertical: true)
            } else if sync.paused {
                Text(L("Paused. Nothing is sent until you resume.")).font(.system(size: 11)).foregroundStyle(Color.mgWarn)
                    .padding(.horizontal, 14).padding(.bottom, 4)
            }
            if on.isEmpty {
                Text(sync.settingsLoaded ? L("Nothing is turned on yet. Choose what to send in Settings.") : L("Checking with My Graph…"))
                    .font(.system(size: 12)).foregroundStyle(.secondary)
                    .padding(.horizontal, 14).padding(.vertical, 4)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(on) { id in SourceStatusRow(id: id) }
        }
    }

    private var footer: some View {
        VStack(spacing: 0) {
            MenuRow(L("Settings…"), symbol: "gearshape", shortcut: "⌘,") { close(); Panels.shared.showSettings() }
            if app.phase == .signedIn {
                MenuRow(sync.paused ? L("Resume syncing") : L("Pause syncing"), symbol: sync.paused ? "play" : "pause") {
                    sync.setPaused(!sync.paused)
                }
            }
            MenuRow(L("Quit My Graph"), symbol: "power", shortcut: "⌘Q") { NSApp.terminate(nil) }
        }
    }

    private var signedOut: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(L("My Graph")).font(.system(size: 13, weight: .semibold))
            Text(app.signOutReason ?? L("Sign in to send what you choose from this Mac to your graph."))
                .font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Button(L("Sign in…")) { close(); Panels.shared.showSettings(tab: .account) }
                .buttonStyle(.borderedProminent).tint(Color.mgAccent).padding(.top, 4)
        }
        .padding(.horizontal, 14).padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottom) { Divider() }
        .padding(.bottom, 6)
    }
}

/// One source's line: name, when it last sent and how much, or the problem.
struct SourceStatusRow: View {
    @Environment(SyncEngine.self) private var sync
    let id: SourceID

    var body: some View {
        let s = sync.state[id]
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: SourceInfo.symbol(id)).frame(width: 16).foregroundStyle(.secondary).font(.system(size: 12))
            VStack(alignment: .leading, spacing: 1) {
                Text(SourceInfo.title(id)).font(.system(size: 13))
                Text(line(s)).font(.system(size: 11)).foregroundStyle(lineColor(s))
                    .lineLimit(2).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 4)
            if sync.running == id { ProgressView().controlSize(.mini) }
            else if s.needsPerson || !(sync.permissions[id]?.isUsable ?? true) {
                Image(systemName: "exclamationmark.circle").foregroundStyle(Color.mgWarn).font(.system(size: 12))
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 3)
        .accessibilityElement(children: .combine)
    }

    private func line(_ s: SourceState) -> String {
        if sync.running == id { return L("Sending…") }
        // A permission the person has to give says so in a few words (the details are in Settings).
        if let p = sync.permissions[id], !p.isUsable { return p == .notAsked ? L("Waiting for your permission") : p.label }
        if let e = s.lastError { return e }
        return SourceStatusRow.result(s)
    }

    /// Amber when the person has to decide something (a permission), brick for errors, grey otherwise.
    private func lineColor(_ s: SourceState) -> Color {
        if sync.running == id { return .secondary }
        if let p = sync.permissions[id], !p.isUsable { return .mgWarn }
        return s.lastError != nil ? (s.needsPerson ? .mgWarn : .mgDanger) : .secondary
    }

    static func result(_ s: SourceState) -> String {
        guard let at = When.ago(s.lastSuccessAt) else { return L("Not sent yet") }
        if s.lastSent == 0 { return L("Up to date, checked \(at)") }
        return L("\(s.lastSent) sent \(at)")
    }
}

/// A row that behaves like a menu item: highlights under the pointer, runs its action on click.
struct MenuRow<Trailing: View>: View {
    let title: String
    let symbol: String
    var shortcut: String?
    let trailing: Trailing
    let action: () -> Void
    @State private var hover = false

    init(_ title: String, symbol: String, shortcut: String? = nil, @ViewBuilder trailing: () -> Trailing = { EmptyView() }, action: @escaping () -> Void) {
        self.title = title; self.symbol = symbol; self.shortcut = shortcut; self.trailing = trailing(); self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: symbol).frame(width: 16).font(.system(size: 12))
                    .foregroundStyle(hover ? Color.white : Color.secondary)
                Text(title).font(.system(size: 13))
                Spacer()
                trailing
                if let shortcut { Text(shortcut).font(.system(size: 12)).foregroundStyle(hover ? Color.white.opacity(0.8) : Color.secondary) }
            }
            .foregroundStyle(hover ? Color.white : Color.primary)
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(RoundedRectangle(cornerRadius: 5).fill(hover ? Color.accentColor : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 6)
        .onHover { hover = $0 }
    }
}
