import SwiftUI

/// An event, place or topic: what it is, what it's connected to, and where every part of it came from.
struct NodeDetailView: View {
    let nodeId: String
    @Environment(Router.self) private var router
    @State private var detail: NodeDetail?
    @State private var error: String?

    var body: some View {
        ScrollView {
            if let d = detail { content(d) }
            else if let error { ErrorStateView(message: error) { await load() }.frame(maxWidth: .infinity) }
            else { ProgressView().padding(.top, 60).frame(maxWidth: .infinity) }
        }
        .background(Color.mgBg)
        .refreshable { await load() }
        .navigationTitle(Text(detail?.node.label ?? ""))
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    @ViewBuilder
    private func content(_ d: NodeDetail) -> some View {
        let n = d.node
        let neighbours = Dictionary((d.neighbours ?? []).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Circle().fill(Color.nodeType(n.type)).frame(width: 8, height: 8)
                    Text(typeLabel(n.type)).mgFont(.secondaryStrong).foregroundStyle(Color.mgMuted)
                }
                Text(n.label).mgFont(.title).foregroundStyle(Color.mgFg).accessibilityAddTraits(.isHeader)
                if let s = n.startAt {
                    Text(dateLine(s, n.endAt, n.timePrecision)).mgFont(.body).foregroundStyle(Color.mgFg)
                }
                if let s = n.summary { Text(s).mgFont(.body).foregroundStyle(Color.mgMuted).padding(.top, 2) }
            }
            .padding(.top, 8)

            if let edges = d.edges, !edges.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    SectionHeader("Connected to")
                    VStack(spacing: 0) {
                        ForEach(edges) { e in
                            let otherId = e.fromId == n.id ? e.toId : e.fromId
                            if let other = neighbours[otherId] {
                                Button { router.push(other.type == "person" ? .person(other.id) : .node(other.id)) } label: {
                                    VStack(alignment: .leading, spacing: 4) {
                                        HStack(spacing: 10) {
                                            if other.type == "person" { Avatar(name: other.label, id: other.id, size: 26) }
                                            else { Circle().fill(Color.nodeType(other.type)).frame(width: 8, height: 8).frame(width: 26) }
                                            Text(Fmt.relationWord(e.relation).capitalizedFirst).mgFont(.secondary).foregroundStyle(Color.mgMuted)
                                            Text(other.label).mgFont(.bodyStrong).foregroundStyle(Color.mgFg)
                                            Spacer(minLength: 0)
                                            if e.status == "inferred" { StateBadge(text: String(localized: "Inferred"), tone: .inferred) }
                                        }
                                        ForEach(d.provenance?.edges?[e.id] ?? []) { p in ProvenanceQuote(row: p) }
                                    }
                                    .padding(.vertical, 9)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    .padding(.horizontal, 12)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.mgSurface))
                }
            }

            if let rows = d.provenance?.node, !rows.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    SectionHeader("Sources")
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(rows) { p in ProvenanceQuote(row: p) }
                    }
                }
            }

            Button { router.push(.askAbout(id: n.id, label: n.label, type: n.type)) } label: {
                Label("Ask about this", systemImage: "sparkle")
            }
            .buttonStyle(MGButtonStyle(kind: .secondary))
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 32)
    }

    private func typeLabel(_ t: String) -> String {
        switch t {
        case "event": return String(localized: "Event")
        case "place": return String(localized: "Place")
        case "topic": return String(localized: "Topic")
        case "person": return String(localized: "Person")
        case "document": return String(localized: "Document")
        default: return t.capitalized
        }
    }

    private func dateLine(_ s: Date, _ e: Date?, _ precision: String?) -> String {
        switch precision {
        case "minute":
            if let e { return "\(Fmt.dayTitle(s)), \(Fmt.time(s))–\(Fmt.time(e))" }
            return "\(Fmt.dayTitle(s)), \(Fmt.time(s))"
        case "month": return s.formatted(.dateTime.month(.wide).year())
        case "year": return s.formatted(.dateTime.year())
        default:
            if let e, !Calendar.current.isDate(e, inSameDayAs: s) { return "\(Fmt.dayTitle(s)) – \(Fmt.dayTitle(e))" }
            return Fmt.dayTitle(s)
        }
    }

    private func load() async {
        do { detail = try await API.shared.get("/api/nodes/\(nodeId)"); error = nil }
        catch { if !error.isCancellation, detail == nil { self.error = error.plainMessage } }
    }
}

/// One provenance record: the quote it was read from, how sure, and a link to the source.
struct ProvenanceQuote: View {
    let row: ProvenanceRow
    @Environment(Router.self) private var router

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let q = row.quote, !q.isEmpty {
                Text("“\(q)”").mgFont(.secondary).foregroundStyle(Color.mgFg)
                    .padding(.leading, 10)
                    .overlay(alignment: .leading) { Rectangle().fill(Color.mgAccent.opacity(0.5)).frame(width: 2) }
            }
            HStack(spacing: 6) {
                if let sid = row.sourceId {
                    Button { router.push(.source(sid)) } label: {
                        Label(row.sourceTitle ?? String(localized: "Open the source"), systemImage: "doc.text")
                            .mgFont(.meta).foregroundStyle(Color.mgAccent)
                    }
                    .buttonStyle(.plain)
                } else {
                    Text(agentLabel).mgFont(.meta).foregroundStyle(Color.mgMuted)
                }
                if let c = row.confidence, c < 0.95 {
                    Text(String(localized: "\(Int((c * 100).rounded()))% sure")).mgFont(.meta).foregroundStyle(Color.mgMuted)
                }
                if let d = row.createdAt { Text(Fmt.shortDay(d)).mgFont(.meta).foregroundStyle(Color.mgMuted) }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var agentLabel: String {
        switch row.activity {
        case "manual_edit", "manual": return String(localized: "Added by hand")
        case "llm_extraction": return String(localized: "Read by the assistant")
        case "chat": return String(localized: "From a chat")
        default: return row.agentType == "user" ? String(localized: "Added by hand") : String(localized: "From the assistant")
        }
    }
}
