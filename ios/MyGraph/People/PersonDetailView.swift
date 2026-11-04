import SwiftUI

struct PersonDetailView: View {
    let personId: String
    @Environment(Router.self) private var router
    @Environment(AppModel.self) private var app
    @State private var detail: PersonDetail?
    @State private var error: String?

    var body: some View {
        ScrollView {
            if let d = detail {
                content(d)
            } else if let error {
                ErrorStateView(message: error) { await load() }
            } else {
                ProgressView().padding(.top, 60).frame(maxWidth: .infinity)
            }
        }
        .background(Color.mgBg)
        .refreshable { await load() }
        .navigationTitle(Text(detail?.person.label ?? ""))
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    @ViewBuilder
    private func content(_ d: PersonDetail) -> some View {
        let p = d.person
        VStack(alignment: .leading, spacing: 26) {
            HStack(spacing: 14) {
                Avatar(name: p.label, id: p.id, size: 60)
                VStack(alignment: .leading, spacing: 4) {
                    Text(p.label).mgFont(.title).foregroundStyle(Color.mgFg).accessibilityAddTraits(.isHeader)
                    if let r = p.relation?.label ?? p.kindLabel {
                        Text(r).mgFont(.body).foregroundStyle(Color.mgMuted)
                    }
                    HStack(spacing: 6) {
                        if let c = p.circle {
                            HStack(spacing: 5) { Circle().fill(Color.circle(c)).frame(width: 7, height: 7); Text(Fmt.circleLabel(c)) }
                                .mgFont(.meta).foregroundStyle(Color.mgMuted)
                        }
                        StateBadge(text: Fmt.visibilityLabel(p.visibility), tone: .muted)
                    }
                }
            }
            .padding(.top, 8)

            let facts = attributeFacts(d)
            if !facts.isEmpty || p.summary != nil {
                VStack(alignment: .leading, spacing: 10) {
                    SectionHeader("About")
                    Panel {
                        VStack(alignment: .leading, spacing: 10) {
                            if let s = p.summary { Text(s).mgFont(.body) }
                            ForEach(facts, id: \.0) { label, value in
                                HStack(alignment: .firstTextBaseline) {
                                    Text(label).mgFont(.secondary).foregroundStyle(Color.mgMuted).frame(width: 110, alignment: .leading)
                                    Text(value).mgFont(.body).foregroundStyle(Color.mgFg)
                                    Spacer(minLength: 0)
                                }
                                .accessibilityElement(children: .combine)
                            }
                        }
                    }
                }
            }

            if let groups = d.relationships, !groups.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    SectionHeader("Relations")
                    ForEach(groups) { g in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(g.label).mgFont(.secondaryStrong).foregroundStyle(Color.mgMuted)
                            VStack(spacing: 0) {
                                ForEach(g.items) { item in relationRow(item) }
                            }
                            .padding(.horizontal, 12)
                            .background(RoundedRectangle(cornerRadius: 8).fill(Color.mgSurface))
                        }
                    }
                }
            }

            if let feed = d.feed, !feed.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    SectionHeader("What's happening")
                    VStack(spacing: 0) {
                        ForEach(feed.prefix(12)) { f in
                            Button { if let r = Route.fromWebHref(f.href) { router.push(r) } } label: {
                                HStack(alignment: .firstTextBaseline, spacing: 12) {
                                    Text(f.at.map { Fmt.shortDay($0) } ?? "").mgFont(.secondary).foregroundStyle(Color.mgMuted).frame(width: 92, alignment: .leading)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(f.title).mgFont(.body).foregroundStyle(Color.mgFg).multilineTextAlignment(.leading)
                                        if let det = f.detail { Text(det).mgFont(.secondary).foregroundStyle(Color.mgMuted).lineLimit(2).multilineTextAlignment(.leading) }
                                        ProvenanceLine(refs: f.citations ?? [])
                                    }
                                    Spacer(minLength: 0)
                                }
                                .padding(.vertical, 9)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 12)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.mgSurface))
                }
            }

            if let obs = d.observations, !obs.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    SectionHeader("Notes")
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(obs.prefix(8)) { o in
                            VStack(alignment: .leading, spacing: 3) {
                                HStack(spacing: 6) {
                                    if let s = o.score { WellbeingDot(score: s) }
                                    Text(o.note ?? observationKind(o.kind)).mgFont(.body)
                                }
                                Text([o.at.map { Fmt.shortDay($0) }, o.authorName].compactMap { $0 }.joined(separator: ", "))
                                    .mgFont(.meta).foregroundStyle(Color.mgMuted)
                            }
                            .padding(.vertical, 8)
                        }
                    }
                    .padding(.horizontal, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.mgSurface))
                }
            }

            if let prov = d.provenance, !prov.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    SectionHeader("Where this came from")
                    ProvenanceLine(refs: prov)
                }
            }

            Button {
                router.push(.askAbout(id: p.id, label: p.label, type: "person"))
            } label: { Label("Ask about \(p.label)", systemImage: "sparkle") }
                .buttonStyle(MGButtonStyle(kind: .secondary))
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 32)
    }

    private func relationRow(_ item: RelationshipItem) -> some View {
        Button {
            router.push(item.other.type == "person" ? .person(item.other.id) : .node(item.other.id))
        } label: {
            HStack(spacing: 10) {
                if item.other.type == "person" { Avatar(name: item.other.label, id: item.other.id, size: 28) }
                else { Circle().fill(Color.nodeType(item.other.type)).frame(width: 8, height: 8).frame(width: 28) }
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        Text(item.label.capitalizedFirst).mgFont(.secondary).foregroundStyle(Color.mgMuted)
                        Text(item.other.label).mgFont(.bodyStrong).foregroundStyle(Color.mgFg)
                    }
                    ProvenanceLine(refs: item.citations ?? [])
                }
                Spacer(minLength: 0)
                if item.status == "inferred" { StateBadge(text: String(localized: "Inferred"), tone: .inferred) }
                else if item.status == "unconfirmed" { StateBadge(text: String(localized: "Unconfirmed"), tone: .muted) }
            }
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func attributeFacts(_ d: PersonDetail) -> [(String, String)] {
        var out: [(String, String)] = []
        if let b = d.person.birthday?.display, let date = ISODate.parse(b) { out.append((String(localized: "Birthday"), date.formatted(date: .long, time: .omitted))) }
        let props = d.person.props ?? [:]
        for a in d.attributes ?? [] where a.hidden != true && a.key != "birthday" {
            if let v = props[a.key]?.display { out.append((a.label, v)) }
        }
        if let aliases = d.person.aliases, !aliases.isEmpty { out.append((String(localized: "Also called"), aliases.joined(separator: ", "))) }
        return out
    }

    private func observationKind(_ k: String) -> String {
        switch k {
        case "wellbeing": return String(localized: "How they're doing")
        case "contact": return String(localized: "Were in touch")
        case "milestone": return String(localized: "Milestone")
        case "health": return String(localized: "Health")
        default: return String(localized: "Note")
        }
    }

    private func load() async {
        do {
            detail = try await API.shared.get("/api/people/\(personId)")
            error = nil
        } catch {
            if error.isCancellation { return }
            if detail == nil { self.error = error.plainMessage }
        }
    }
}

struct WellbeingDot: View {
    let score: Int
    var body: some View {
        Circle().fill(score <= 2 ? Color(Palette.dynamic(0xC23B3B, 0xEE7A73)) : score == 3 ? Color.mgMuted : Color(Palette.dynamic(0x2A8A3E, 0x5CBF6E)))
            .frame(width: 8, height: 8)
            .accessibilityLabel(Text(wellbeingWord))
    }
    private var wellbeingWord: String {
        switch score {
        case 1: return String(localized: "Struggling")
        case 2: return String(localized: "Low")
        case 3: return String(localized: "OK")
        case 4: return String(localized: "Good")
        default: return String(localized: "Thriving")
        }
    }
}

/// Where a fact came from: small cobalt marks that open the source.
struct ProvenanceLine: View {
    let refs: [ProvenanceRef]
    @Environment(Router.self) private var router

    var body: some View {
        if !refs.isEmpty {
            FlowLayout(spacing: 6) {
                ForEach(Array(refs.prefix(4).enumerated()), id: \.offset) { _, r in
                    Button { if let route = r.route { router.push(route) } } label: {
                        HStack(spacing: 4) {
                            Image(systemName: r.route == nil ? "pencil" : "doc.text").font(.system(size: 9, weight: .semibold))
                            Text(r.title).lineLimit(1)
                            if let d = r.detail { Text(d).foregroundStyle(Color.mgMuted) }
                        }
                        .mgFont(.meta)
                        .foregroundStyle(Color.mgAccent)
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(Capsule().fill(Color.mgAccentTint))
                    }
                    .buttonStyle(.plain)
                    .disabled(r.route == nil)
                    .accessibilityLabel(Text("Source: \(r.title)"))
                }
            }
        }
    }
}

extension String {
    var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}
