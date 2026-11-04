import SwiftUI

/// Plain sentences for history events ("Anna changed the summary from … to …").
enum HistoryWords {
    static func who(_ e: HistoryEvent) -> String {
        if let n = e.actorName, !n.isEmpty { return n }
        switch e.actorKind {
        case "assistant": return String(localized: "The assistant")
        case "connector": return String(localized: "A connection")
        case "import": return String(localized: "An import")
        case "system": return String(localized: "My Graph")
        default: return String(localized: "Someone")
        }
    }

    static func field(_ f: String) -> String {
        if f.hasPrefix("props.") { return String(localized: "the detail “\(String(f.dropFirst(6)))”") }
        switch f {
        case "label": return String(localized: "the name")
        case "summary": return String(localized: "the summary")
        case "aliases": return String(localized: "the other names")
        case "visibility": return String(localized: "who can see it")
        case "sensitive": return String(localized: "sensitivity")
        case "kind": return String(localized: "the kind")
        case "startAt": return String(localized: "the date")
        case "endAt": return String(localized: "the end date")
        case "status": return String(localized: "the status")
        case "confidence": return String(localized: "how sure we are")
        case "relation": return String(localized: "the relation")
        case "type": return String(localized: "the type")
        case "timePrecision": return String(localized: "how exact the date is")
        default: return f
        }
    }

    static func sentence(_ e: HistoryEvent) -> String {
        let w = who(e)
        switch e.kind {
        case "created": return String(localized: "\(w) added it")
        case "updated":
            if let f = e.field { return String(localized: "\(w) changed \(field(f))") }
            return String(localized: "\(w) changed it")
        case "retired": return String(localized: "\(w) retired it")
        case "restored": return String(localized: "\(w) brought it back")
        case "merged": return String(localized: "\(w) merged something into it")
        case "removed": return e.field.map { String(localized: "\(w) removed \(field($0))") } ?? String(localized: "\(w) removed it")
        case "linked": return String(localized: "\(w) linked it with the same one in another graph")
        case "shared": return String(localized: "\(w) shared it with another graph")
        case "unlinked": return String(localized: "\(w) unlinked it from another graph")
        default: return "\(w): \(e.kind)"
        }
    }

    /// "from 2019 to 2020", "to Copenhagen", or nil when the values aren't short text.
    static func detail(_ e: HistoryEvent) -> String? {
        guard e.kind == "updated" else { return nil }
        let to = e.toValue?.shortText
        let from = e.fromValue?.shortText
        switch (from, to) {
        case let (f?, t?): return String(localized: "from \(f) to \(t)")
        case let (nil, t?): return String(localized: "to \(t)")
        default: return nil
        }
    }
}

struct HistoryRow: View {
    let event: HistoryEvent
    var showSubject = false
    @Environment(Router.self) private var router

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            if showSubject, let s = event.subjectName { Text(s).mgFont(.secondaryStrong).foregroundStyle(Color.mgMuted) }
            Text(HistoryWords.sentence(event)).mgFont(.body).foregroundStyle(Color.mgFg)
            if let d = HistoryWords.detail(event) { Text(d).mgFont(.secondary).foregroundStyle(Color.mgMuted).lineLimit(3) }
            HStack(spacing: 8) {
                Text(Fmt.relative(event.at)).mgFont(.meta).foregroundStyle(Color.mgMuted)
                if let cs = event.changeSetId {
                    Button { router.push(.changeSet(cs)) } label: { Text("See the proposal").mgFont(.meta).foregroundStyle(Color.mgAccent) }
                        .buttonStyle(.plain)
                }
            }
        }
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// "What changed" on a person or node: the latest few events, and the full list one tap away.
struct HistorySection: View {
    let subjectId: String
    let subjectName: String
    @Environment(Router.self) private var router
    @State private var events: [HistoryEvent]?
    @State private var failed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader("What changed") {
                if let e = events, e.count > 3 {
                    Button("See all") { router.push(.history(subjectId, subjectName)) }.mgFont(.secondaryStrong)
                        .accessibilityIdentifier("history.seeAll")
                }
            }
            if let e = events {
                if e.isEmpty {
                    Text("No changes to \(subjectName) have been recorded yet.").mgFont(.secondary).foregroundStyle(Color.mgMuted)
                } else {
                    VStack(spacing: 0) {
                        ForEach(e.prefix(3)) { ev in
                            HistoryRow(event: ev)
                            if ev.id != e.prefix(3).last?.id { Divider().overlay(Color.mgLine) }
                        }
                    }
                    .padding(.horizontal, 12)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.mgSurface))
                }
            } else if failed {
                Text("History couldn't be loaded right now.").mgFont(.secondary).foregroundStyle(Color.mgMuted)
            } else {
                ProgressView()
            }
        }
        .accessibilityIdentifier("history.section")
        .task(id: subjectId) {
            do {
                let r: HistoryResponse = try await API.shared.get("/api/history", query: ["subjectId": subjectId, "limit": "4"])
                events = r.events
            } catch {
                if !error.isCancellation { failed = true }
            }
        }
    }
}

/// Everything recorded about one person or thing, newest first.
struct HistoryView: View {
    let subjectId: String
    let subjectName: String
    @State private var events: [HistoryEvent]?
    @State private var error: String?
    @State private var limit = 50

    var body: some View {
        List {
            if let events {
                if events.isEmpty {
                    EmptyStateView(title: "Nothing recorded yet",
                                   message: "Changes appear here as soon as anything about this changes.",
                                   systemImage: "clock.arrow.circlepath")
                        .listRowBackground(Color.clear)
                }
                ForEach(events) { e in HistoryRow(event: e).listRowBackground(Color.mgSurface) }
                if events.count >= limit {
                    Button("Show older changes") { limit += 50; Task { await load() } }.listRowBackground(Color.mgSurface)
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
        .navigationTitle(Text("History"))
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load() async {
        do {
            let r: HistoryResponse = try await API.shared.get("/api/history", query: ["subjectId": subjectId, "limit": String(limit)])
            events = r.events; error = nil
        } catch {
            if !error.isCancellation, events == nil { self.error = error.plainMessage }
        }
    }
}
