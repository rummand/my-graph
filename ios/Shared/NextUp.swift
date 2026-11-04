import Foundation

/// "Next up": today's remaining reminders and events in the current graph, soonest first.
/// Shared by Today, the widget and the notification scheduler.
struct NextUpItem: Codable, Hashable, Identifiable {
    let id: String
    let title: String
    let at: Date
    let personId: String?
    let personName: String?
    let isReminder: Bool
    let allDay: Bool
}

struct NextUpSnapshot: Codable {
    var graphName: String
    var graphHue: Double
    var items: [NextUpItem]
    var savedAt: Date
}

enum NextUp {
    static func compute(reminders: [Reminder], events: [TimelineItem], people: [TimelinePerson], now: Date = Date(), calendar: Calendar = .current) -> [NextUpItem] {
        let endOfDay = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now))!
        let names = Dictionary(people.map { ($0.id, $0.label) }, uniquingKeysWith: { a, _ in a })
        var out: [NextUpItem] = []
        for r in reminders where !r.done && r.dueAt < endOfDay {
            out.append(NextUpItem(id: "r:\(r.id)", title: r.title, at: r.dueAt, personId: r.aboutNodeId, personName: r.aboutLabel, isReminder: true, allDay: false))
        }
        for e in events where e.kind == "event" && e.precision != "month" && e.precision != "year"
            && e.start < endOfDay && (e.end ?? e.start) >= calendar.startOfDay(for: now) {
            let pid = e.personIds?.first
            let allDay = e.precision != nil && e.precision != "minute"
            if !allDay && e.start < now.addingTimeInterval(-3600) { continue }
            out.append(NextUpItem(id: "e:\(e.id)", title: e.title, at: max(e.start, calendar.startOfDay(for: now)), personId: pid, personName: pid.flatMap { names[$0] }, isReminder: false, allDay: allDay))
        }
        return out.sorted { $0.at < $1.at }
    }

    private static var file: URL { AppGroup.containerURL.appendingPathComponent("next-up.json") }

    static func save(_ s: NextUpSnapshot) {
        let enc = JSONEncoder(); enc.dateEncodingStrategy = .iso8601
        if let d = try? enc.encode(s) { try? d.write(to: file, options: .atomic) }
    }

    static func load() -> NextUpSnapshot? {
        let dec = JSONDecoder(); dec.dateDecodingStrategy = .iso8601
        guard let d = try? Data(contentsOf: file) else { return nil }
        return try? dec.decode(NextUpSnapshot.self, from: d)
    }

    static func clear() { try? FileManager.default.removeItem(at: file) }

    /// Fetches what's needed for Next up from the server (used by the widget and background refresh).
    static func fetch(api: API = .shared) async throws -> NextUpSnapshot {
        let cal = Calendar.current
        let start = cal.startOfDay(for: Date())
        let end = cal.date(byAdding: .day, value: 1, to: start)!
        async let graphs: GraphsResponse = api.get("/api/graphs")
        async let rem: RemindersResponse = api.get("/api/reminders", query: ["upcoming": "true", "days": "1", "limit": "50"])
        async let tl: TimelineResponse = api.get("/api/timeline", query: ["from": ISODate.string(start), "to": ISODate.string(end), "types": "event"])
        let (g, r, t) = try await (graphs, rem, tl)
        let current = g.graphs.first { $0.id == g.currentGraphId } ?? g.graphs.first
        let snap = NextUpSnapshot(graphName: current?.name ?? "My Graph", graphHue: current?.hue ?? 210,
                                  items: compute(reminders: r.reminders, events: t.items, people: t.people ?? []), savedAt: Date())
        save(snap)
        return snap
    }
}
