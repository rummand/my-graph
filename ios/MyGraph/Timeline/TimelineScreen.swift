import SwiftUI

/// A vertical, day-grouped list: each item carries its people's colours. Filter by person.
struct TimelineScreen: View {
    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
    @State private var data: TimelineResponse?
    @State private var allPeople: [TimelinePerson] = []
    @State private var selected: Set<String> = []
    @State private var error: String?
    @State private var range: Range = .upcoming

    enum Range: String, CaseIterable, Identifiable {
        case upcoming, past
        var id: String { rawValue }
        var label: LocalizedStringKey { self == .upcoming ? "Coming up" : "Earlier" }
    }

    var body: some View {
        ScrollViewReader { _ in
            List {
                Section {
                    filters.listRowBackground(Color.clear).listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                }
                if let d = data {
                    let days = grouped(d)
                    if days.isEmpty {
                        EmptyStateView(title: range == .upcoming ? "Nothing coming up" : "Nothing here yet",
                                       message: "Events from letters, chats and the calendar appear here, each in the colour of the person it's about.",
                                       systemImage: "calendar")
                            .listRowBackground(Color.clear)
                    }
                    ForEach(days, id: \.0) { day, items in
                        Section {
                            ForEach(items) { item in
                                Button { open(item) } label: { TimelineRow(item: item, names: names) }
                                    .buttonStyle(.plain)
                                    .listRowBackground(Color.mgSurface)
                            }
                        } header: {
                            Text(Fmt.dayTitle(day)).mgFont(.secondaryStrong).foregroundStyle(Calendar.current.isDateInToday(day) ? Color.mgAccent : Color.mgMuted)
                                .textCase(nil)
                        }
                    }
                    if d.truncated == true {
                        Text("Showing the first part. Narrow it down with a person.").mgFont(.secondary).foregroundStyle(Color.mgMuted).listRowBackground(Color.clear)
                    }
                } else if let error {
                    ErrorStateView(message: error) { await load() }.listRowBackground(Color.clear)
                } else {
                    ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .listSectionSpacing(14)
        }
        .refreshable { await load() }
        .navigationTitle(Text("Timeline"))
        .navigationBarTitleDisplayMode(.inline)
        .task(id: "\(range.rawValue)|\(selected.sorted().joined(separator: ","))") { await load() }
    }

    private var names: [String: String] { Dictionary(allPeople.map { ($0.id, $0.label) }, uniquingKeysWith: { a, _ in a }) }

    private var filters: some View {
        VStack(alignment: .leading, spacing: 10) {
            Picker("Show", selection: $range) {
                ForEach(Range.allCases) { r in Text(r.label).tag(r) }
            }
            .pickerStyle(.segmented)
            if !allPeople.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        filterChip(label: String(localized: "Everyone"), id: nil, on: selected.isEmpty)
                        ForEach(allPeople) { p in filterChip(label: p.label, id: p.id, on: selected.contains(p.id)) }
                    }
                    .padding(.vertical, 2)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func filterChip(label: String, id: String?, on: Bool) -> some View {
        Button {
            withAnimation(.easeOut(duration: 0.2)) {
                if let id { if selected.contains(id) { selected.remove(id) } else { selected.insert(id) } } else { selected = [] }
            }
        } label: {
            HStack(spacing: 5) {
                if let id { Circle().fill(PersonColor.solid(id)).frame(width: 7, height: 7) }
                Text(label).mgFont(.secondaryStrong)
            }
            .foregroundStyle(Color.mgFg)
            .padding(.horizontal, 11).padding(.vertical, 6)
            .background(Capsule().fill(on ? (id.map { PersonColor.tint($0) } ?? Color.mgSurface) : Color.mgSurface2))
            .overlay(Capsule().stroke(on ? Color.mgFg.opacity(0.5) : .clear, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private func grouped(_ d: TimelineResponse) -> [(Date, [TimelineItem])] {
        let cal = Calendar.current
        let by = Dictionary(grouping: d.items) { cal.startOfDay(for: $0.start) }
        let keys = range == .upcoming ? by.keys.sorted() : by.keys.sorted(by: >)
        return keys.map { k in (k, by[k]!.sorted { $0.start < $1.start }) }
    }

    private func open(_ item: TimelineItem) {
        if item.kind == "event", let n = item.nodeId { router.push(.node(n)) }
        else if let s = item.sourceId { router.push(.source(s)) }
        else if let n = item.nodeId { router.push(.node(n)) }
    }

    private func load() async {
        let cal = Calendar.current
        let today = cal.startOfDay(for: Date())
        let from = range == .upcoming ? today : cal.date(byAdding: .month, value: -12, to: today)!
        let to = range == .upcoming ? cal.date(byAdding: .month, value: 6, to: today)! : today
        do {
            let r: TimelineResponse = try await API.shared.get("/api/timeline", query: [
                "from": ISODate.string(from), "to": ISODate.string(to), "types": "event,reminder,document",
                "people": selected.isEmpty ? nil : selected.sorted().joined(separator: ","), "limit": "400",
            ])
            data = r; error = nil
            if selected.isEmpty, let p = r.people { allPeople = p }
        } catch {
            if error.isCancellation { return }
            if data == nil { self.error = error.plainMessage } else { app.banner = error.plainMessage }
        }
    }
}

struct TimelineRow: View {
    let item: TimelineItem
    let names: [String: String]

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(spacing: 3) {
                let ids = (item.personIds ?? []).prefix(3)
                if ids.isEmpty {
                    Circle().fill(Color.nodeType(item.kind == "event" ? "event" : "document")).frame(width: 9, height: 9)
                } else {
                    ForEach(Array(ids), id: \.self) { pid in Circle().fill(PersonColor.solid(pid)).frame(width: 9, height: 9) }
                }
            }
            .frame(width: 12).padding(.top, 6)
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.title).mgFont(.body).foregroundStyle(Color.mgFg).multilineTextAlignment(.leading)
                HStack(spacing: 6) {
                    Text(when).mgFont(.meta).foregroundStyle(Color.mgMuted)
                    Text(kindLabel).mgFont(.meta).foregroundStyle(Color.mgMuted)
                    if item.status == "unconfirmed" && item.kind == "event" { StateBadge(text: String(localized: "Unconfirmed"), tone: .muted) }
                    if item.status == "inferred" { StateBadge(text: String(localized: "Inferred"), tone: .inferred) }
                }
                let people = (item.personIds ?? []).compactMap { pid in names[pid].map { (pid, $0) } }
                if !people.isEmpty {
                    FlowLayout(spacing: 4) { ForEach(people, id: \.0) { PersonChip(name: $0.1, id: $0.0) } }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var when: String {
        switch item.precision {
        case "minute": return Fmt.time(item.start)
        case "month": return item.start.formatted(.dateTime.month(.wide).year())
        case "year": return item.start.formatted(.dateTime.year())
        default: return String(localized: "All day")
        }
    }

    private var kindLabel: String {
        switch item.kind {
        case "event": return String(localized: "Event")
        case "reminder": return String(localized: "Reminder")
        case "document", "source": return String(localized: "Document")
        default: return item.kind.capitalized
        }
    }
}
