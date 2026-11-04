import SwiftUI

struct PeopleView: View {
    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
    @State private var overview: PeopleOverview?
    @State private var error: String?
    @State private var cachedAt: Date?
    @State private var query = ""
    @State private var showAdd = false

    private var cacheKey: String { "people-\(app.currentGraphId ?? "")" }

    var body: some View {
        List {
            if cachedAt != nil {
                NoticeBar(text: cachedAt.map { String(localized: "Offline. Showing what was here \(Fmt.relative($0)).") } ?? String(localized: "You're offline."))
                    .listRowBackground(Color.clear).listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
            }
            if let o = overview {
                if let att = o.attention, !att.isEmpty, query.isEmpty {
                    Section {
                        ForEach(uniqueAttention(att), id: \.personId) { a in
                            Button { router.push(.person(a.personId)) } label: {
                                HStack(spacing: 12) {
                                    Avatar(name: a.label, id: a.personId, size: 32)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(a.label).mgFont(.bodyStrong).foregroundStyle(Color.mgFg)
                                        Text(a.note ?? attentionWhy(a.reason)).mgFont(.secondary).foregroundStyle(Color.mgMuted).lineLimit(2)
                                    }
                                }
                            }
                            .buttonStyle(.plain)
                            .listRowBackground(Color.mgSurface)
                        }
                    } header: { Text("Could use some attention") }
                }
                ForEach(groups(o), id: \.0) { circle, people in
                    Section {
                        ForEach(people) { p in
                            Button { router.push(.person(p.id)) } label: { PersonRow(person: p) }
                                .buttonStyle(.plain)
                                .listRowBackground(Color.mgSurface)
                        }
                    } header: {
                        HStack(spacing: 6) {
                            Circle().fill(Color.circle(circle)).frame(width: 8, height: 8)
                            Text(Fmt.circleLabel(circle))
                        }
                    }
                }
                if o.people.isEmpty {
                    EmptyStateView(title: "No people yet", message: "Add the people in your life, or upload a letter and the assistant will find them.",
                                   systemImage: "person.2", actionTitle: "Add person") { showAdd = true }
                        .listRowBackground(Color.clear)
                }
            } else if let error {
                ErrorStateView(message: error) { await load() }.listRowBackground(Color.clear)
            } else {
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .searchable(text: $query, prompt: Text("Find a person"))
        .refreshable { await load() }
        .navigationTitle(Text("People"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showAdd = true } label: { Image(systemName: "person.badge.plus") }
                    .accessibilityLabel(Text("Add person"))
            }
        }
        .sheet(isPresented: $showAdd) {
            AddPersonSheet(kinds: overview?.kinds ?? []) { id in
                Task { await load() }
                router.push(.person(id))
            }
        }
        .task { await load() }
    }

    private func groups(_ o: PeopleOverview) -> [(String, [PersonSummary])] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let people = o.people.filter { q.isEmpty || $0.label.lowercased().contains(q) || ($0.kindLabel ?? "").lowercased().contains(q) }
        let by = Dictionary(grouping: people) { p in Fmt.circleOrder.contains(p.circle ?? "") ? p.circle! : "other" }
        return Fmt.circleOrder.compactMap { c in
            guard let list = by[c], !list.isEmpty else { return nil }
            return (c, list.sorted { ($0.isViewer == true ? 0 : 1, $0.label) < ($1.isViewer == true ? 0 : 1, $1.label) })
        }
    }

    private func uniqueAttention(_ a: [AttentionItem]) -> [AttentionItem] {
        var seen = Set<String>()
        return a.filter { seen.insert($0.personId).inserted }
    }

    private func attentionWhy(_ r: String?) -> String {
        switch r {
        case "wellbeing": return String(localized: "Seems to be having a hard time")
        case "contact": return String(localized: "It's been a while since you were in touch")
        case "birthday": return String(localized: "Birthday coming up")
        default: return String(localized: "Worth a look")
        }
    }

    private func load() async {
        if overview == nil, let c = DiskCache.load(PeopleOverview.self, key: cacheKey) { overview = c.value; cachedAt = c.savedAt }
        do {
            let o: PeopleOverview = try await API.shared.get("/api/people")
            overview = o; error = nil; cachedAt = nil; app.isOffline = false
            DiskCache.save(o, as: cacheKey)
            if let me = o.people.first(where: { $0.isViewer == true }) { app.rememberMe(name: me.label, personId: me.id) }
        } catch {
            if error.isCancellation { return }
            if error.isOffline { app.isOffline = true }
            if overview == nil { self.error = error.plainMessage }
        }
    }
}

struct PersonRow: View {
    let person: PersonSummary
    var body: some View {
        HStack(spacing: 12) {
            Avatar(name: person.label, id: person.id, size: 38)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(person.label).mgFont(.bodyStrong).foregroundStyle(Color.mgFg)
                    if person.isViewer == true { Text("You").mgFont(.meta).foregroundStyle(Color.mgMuted) }
                }
                if let sub = subtitle { Text(sub).mgFont(.secondary).foregroundStyle(Color.mgMuted).lineLimit(1) }
            }
            Spacer(minLength: 0)
            if let n = person.openReminders, n > 0 {
                Text("\(n)").mgFont(.meta).monospacedDigit().foregroundStyle(Color.mgMuted)
                    .padding(.horizontal, 7).padding(.vertical, 2).background(Capsule().fill(Color.mgSurface2))
                    .accessibilityLabel(Text("\(n) open reminders"))
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var subtitle: String? {
        if let r = person.relation?.label { return r }
        return person.kindLabel
    }
}

struct AddPersonSheet: View {
    let kinds: [PersonKindOption]
    let added: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var kind: String?
    @State private var visibility = "household"
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") {
                    TextField("For example Birgit Jensen", text: $name).textContentType(.name).mgFont(.body)
                }
                Section("Who they are") {
                    Picker("Kind", selection: $kind) {
                        Text("Not sure yet").tag(String?.none)
                        ForEach(groupedKinds, id: \.0) { circle, list in
                            Section(Fmt.circleLabel(circle)) {
                                ForEach(list) { k in Text(k.label).tag(Optional(k.key)) }
                            }
                        }
                    }
                }
                Section {
                    Picker("Who can see them", selection: $visibility) {
                        Text("Everyone at home").tag("household")
                        Text("Parents").tag("parents")
                        Text("Only you").tag("private")
                    }
                }
                if let error { Section { Text(error).foregroundStyle(Color.mgDanger) } }
            }
            .scrollContentBackground(.hidden)
            .background(Color.mgBg)
            .navigationTitle(Text("Add person"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await save() } } label: { if busy { ProgressView() } else { Text("Add") } }
                        .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || busy)
                }
            }
        }
        .mgFont(.body)
    }

    private var groupedKinds: [(String, [PersonKindOption])] {
        let by = Dictionary(grouping: kinds) { $0.circle ?? "other" }
        return Fmt.circleOrder.compactMap { c in by[c].map { (c, $0) } }
    }

    private func save() async {
        busy = true; defer { busy = false }
        var body: [String: Any] = ["label": name.trimmingCharacters(in: .whitespaces), "visibility": visibility]
        body["kind"] = kind ?? NSNull()
        do {
            let r: CreatePersonResponse = try await API.shared.call("POST", "/api/people", json: body)
            Haptics.success()
            dismiss()
            if let id = r.personId { added(id) }
        } catch {
            self.error = error.plainMessage
        }
    }
}
