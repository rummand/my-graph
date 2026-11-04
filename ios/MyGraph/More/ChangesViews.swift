import SwiftUI

/// Change sets: proposed changes that don't touch the graph until a person delivers them.
struct ChangesView: View {
    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
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
                        ChangeSetCard(set: c, busy: busy.contains(c.id), canDecide: app.canWrite, open: { router.push(.changeSet(c.id)) }) { action in
                            Task { await act(c, action) }
                        }
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                    } else {
                        Button { router.push(.changeSet(c.id)) } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(c.title).mgFont(.bodyStrong).foregroundStyle(Color.mgFg)
                                Text(pastLine(c)).mgFont(.meta).foregroundStyle(Color.mgMuted)
                            }
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

    private func pastLine(_ c: ChangeSet) -> String {
        let n = c.changes?.count ?? 0
        let count = n == 1 ? String(localized: "1 change") : String(localized: "\(n) changes")
        if let d = c.deliveredAt ?? c.createdAt { return "\(count) · \(Fmt.relative(d))" }
        return count
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
            try await API.shared.post("/api/changes/\(c.id)/\(action)", json: action == "deliver" ? (c.fingerprint.map { ["fingerprint": $0] } ?? [:]) : [:])
            if action == "deliver" { Haptics.success() }
            sets?.removeAll { $0.id == c.id }
        } catch { app.banner = error.plainMessage; Haptics.warning() }
    }
}

/// One proposal, change by change: untick what you don't want, then Deliver the rest or Drop it all.
struct ChangeSetDetailView: View {
    let changeSetId: String
    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @State private var set: ChangeSet?
    @State private var error: String?
    @State private var busy = false
    @State private var toggling: Set<String> = []
    @State private var outcome: String?

    var body: some View {
        List {
            if let c = set {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 6) {
                            StateBadge(text: statusLabel(c.status), tone: c.status == "draft" ? .warn : .muted)
                            if let o = c.origin { Text(ChangeWords.origin(o)).mgFont(.meta).foregroundStyle(Color.mgMuted) }
                        }
                        Text(c.title).mgFont(.title).accessibilityAddTraits(.isHeader)
                        if let d = c.description, !d.isEmpty { Text(d).mgFont(.body).foregroundStyle(Color.mgMuted) }
                        if let d = c.createdAt {
                            Text(c.createdByName.map { String(localized: "Proposed by \($0), \(Fmt.relative(d))") } ?? String(localized: "Proposed \(Fmt.relative(d))"))
                                .mgFont(.meta).foregroundStyle(Color.mgMuted)
                        }
                    }
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                }
                Section {
                    ForEach(c.changes ?? []) { item in row(c, item) }
                } header: { Text("Changes") } footer: {
                    if c.status == "draft" {
                        Text("Nothing reaches the graph until you deliver. Untick a change to leave it out.")
                    }
                }
                if let outcome {
                    Section { Text(outcome).mgFont(.secondary).listRowBackground(Color.mgAccentTint) }
                }
                if c.status == "draft" && app.canWrite {
                    Section {
                        let n = (c.changes ?? []).filter { $0.included != false }.count
                        Button {
                            Task { await deliver(c) }
                        } label: {
                            HStack {
                                Text(n == (c.changes?.count ?? 0) ? String(localized: "Deliver all") : String(localized: "Deliver \(n) of \(c.changes?.count ?? 0)"))
                                Spacer()
                                if busy { ProgressView() }
                            }
                        }
                        .disabled(busy || n == 0)
                        .accessibilityIdentifier("changeset.detail.deliver")
                        .listRowBackground(Color.mgSurface)
                        Button("Drop this proposal", role: .destructive) { Task { await drop(c) } }
                            .disabled(busy)
                            .accessibilityIdentifier("changeset.detail.drop")
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
        .navigationTitle(Text("Proposal"))
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    @ViewBuilder
    private func row(_ c: ChangeSet, _ item: ChangeItem) -> some View {
        let on = item.included != false
        let verdict = c.verdicts?[item.id]
        let editable = c.status == "draft" && app.canWrite && verdict != "landed"
        HStack(alignment: .top, spacing: 12) {
            if c.status == "draft" {
                Button { Task { await toggle(c, item, to: !on) } } label: {
                    Image(systemName: on ? "checkmark.square.fill" : "square")
                        .font(.system(size: 22)).foregroundStyle(on ? Color.mgAccent : Color.mgMuted)
                        .frame(width: 30, height: 30).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!editable || toggling.contains(item.id))
                .accessibilityLabel(Text(on ? "Included: \(item.summary ?? item.op)" : "Left out: \(item.summary ?? item.op)"))
                .accessibilityHint(Text(on ? "Leave this change out" : "Include this change"))
                .accessibilityIdentifier("change.tick.\(item.seq ?? 0)")
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(item.summary ?? item.op).mgFont(.body).foregroundStyle(on ? Color.mgFg : Color.mgMuted)
                if let n = item.note, !n.isEmpty { Text(n).mgFont(.secondary).foregroundStyle(Color.mgMuted) }
                if let q = item.receipt?.quote, !q.isEmpty {
                    Text("“\(q)”").mgFont(.secondary).italic().foregroundStyle(Color.mgMuted).lineLimit(3)
                }
                HStack(spacing: 8) {
                    if verdict == "landed" { StateBadge(text: String(localized: "Already in the graph"), tone: .muted) }
                    if verdict == "conflicted" { StateBadge(text: String(localized: "Something changed since"), tone: .warn) }
                    if let s = item.receipt?.sourceId {
                        Button { router.push(.source(s)) } label: { Text("Source").mgFont(.meta).foregroundStyle(Color.mgAccent) }.buttonStyle(.plain)
                    }
                    if let n = item.nodeId, c.status == "delivered" {
                        Button { router.push(.node(n)) } label: { Text("Open").mgFont(.meta).foregroundStyle(Color.mgAccent) }.buttonStyle(.plain)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
        .listRowBackground(Color.mgSurface)
    }

    private func statusLabel(_ s: String) -> String {
        switch s {
        case "delivered": return String(localized: "Delivered")
        case "abandoned": return String(localized: "Dropped")
        default: return String(localized: "Waiting for you")
        }
    }

    private func load() async {
        do {
            let r: ChangeSetResponse = try await API.shared.get("/api/changes/\(changeSetId)")
            set = r.changeSet; error = nil
        } catch {
            if !error.isCancellation, set == nil { self.error = error.plainMessage }
        }
    }

    private func toggle(_ c: ChangeSet, _ item: ChangeItem, to included: Bool) async {
        guard let i = set?.changes?.firstIndex(where: { $0.id == item.id }) else { return }
        toggling.insert(item.id); defer { toggling.remove(item.id) }
        set?.changes?[i].included = included
        Haptics.tap()
        do {
            let r: IncludedResponse = try await API.shared.call("PATCH", "/api/changes/\(c.id)/changes/\(item.id)", json: ["included": included])
            set?.fingerprint = r.fingerprint ?? set?.fingerprint
        } catch {
            set?.changes?[i].included = !included
            app.banner = error.plainMessage
        }
    }

    private func deliver(_ c: ChangeSet) async {
        busy = true; defer { busy = false }
        var body: [String: Any] = [:]
        if let f = set?.fingerprint { body["fingerprint"] = f }
        do {
            let r: DeliverResponse = try await API.shared.call("POST", "/api/changes/\(c.id)/deliver", json: body)
            Haptics.success()
            if let updated = r.changeSet { set = updated } else { await load() }
            let n = r.applied ?? 0
            outcome = n == 1 ? String(localized: "Delivered 1 change. It's in the graph now, with a note of who delivered it.")
                : String(localized: "Delivered \(n) changes. They're in the graph now, with a note of who delivered them.")
        } catch {
            Haptics.warning()
            app.banner = error.plainMessage
            await load()
        }
    }

    private func drop(_ c: ChangeSet) async {
        busy = true; defer { busy = false }
        do {
            try await API.shared.post("/api/changes/\(c.id)/abandon")
            Haptics.tap()
            dismiss()
        } catch {
            app.banner = error.plainMessage
        }
    }
}
