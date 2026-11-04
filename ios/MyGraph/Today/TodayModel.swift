import Foundation
import Observation
import WidgetKit

struct TodaySnapshot: Codable {
    var brief: Brief?
    var reminders: [Reminder]
    var week: [TimelineItem]
    var people: [TimelinePerson]
    var suggestions: [Suggestion]
    var recent: [LibraryItem]
    var myName: String?
    var myPersonId: String?
    /// From GET /api/today (nil when an older server answered through the separate routes).
    var greeting: TodayGreeting?
    var weekByPerson: [ServerWeekGroup]?
    var connections: [ConnectionNeed]?
    var attention: TodayAttention?
    var changeSets: [ChangeSet]?
}

/// One person's row in "This week": their events and reminders for the next seven days.
struct WeekGroup: Identifiable {
    let id: String
    let personId: String?
    let name: String
    var entries: [Entry]

    struct Entry: Identifiable, Hashable {
        let id: String
        let title: String
        let at: Date
        let allDay: Bool
        let route: Route?
        let isReminder: Bool
    }
}

@MainActor
@Observable
final class TodayModel {
    var snap: TodaySnapshot?
    var changeSets: [ChangeSet]? // nil: the server has no change set routes yet
    var loading = false
    var error: String?
    var fromCache: Date?
    var briefBusy = false
    var briefError: String?
    var deciding: Set<String> = []

    func load(app: AppModel) async {
        if snap == nil, let cached = DiskCache.load(TodaySnapshot.self, key: "today-\(app.currentGraphId ?? "")") {
            snap = cached.value; fromCache = cached.savedAt
            if changeSets == nil { changeSets = cached.value.changeSets }
        }
        loading = true
        defer { loading = false }
        do {
            let new: TodaySnapshot
            do {
                new = try await loadOne()
            } catch APIError.notFound {
                new = try await loadSeparately(app: app) // a server without GET /api/today
            }
            if let name = new.myName { app.rememberMe(name: name, personId: new.myPersonId) }
            snap = new
            fromCache = nil
            error = nil
            app.isOffline = false
            DiskCache.save(new, as: "today-\(app.currentGraphId ?? "")")
            if app.graphs.isEmpty { await app.loadGraphs() }
            let next = NextUp.compute(reminders: new.reminders, events: new.week, people: new.people)
            NextUp.save(NextUpSnapshot(graphName: app.currentGraph?.name ?? "My Graph", graphHue: app.currentGraph?.hue ?? 210, items: next, savedAt: Date()))
            WidgetCenter.shared.reloadAllTimelines()
            await ReminderNotifications.schedule(new.reminders)
        } catch {
            #if DEBUG
            print("[debug] today failed: \(error)")
            #endif
            if error.isCancellation { return }
            if error.isOffline { app.isOffline = true }
            self.error = error.plainMessage
        }
    }

    /// Everything in one request, written in the account's language.
    private func loadOne() async throws -> TodaySnapshot {
        let r: TodayResponse = try await API.shared.get("/api/today", query: ["days": "7"])
        if let sets = r.changeSets { changeSets = sets } else if r.failed?.contains("changeSets") != true { changeSets = [] }
        return TodaySnapshot(
            brief: r.brief, reminders: r.reminders ?? snap?.reminders ?? [], week: r.week?.items ?? [], people: r.week?.people ?? [],
            suggestions: r.suggestions ?? [], recent: r.recent ?? [], myName: r.me?.name, myPersonId: r.me?.personNodeId,
            greeting: r.greeting, weekByPerson: r.weekByPerson, connections: r.connections, attention: r.attention, changeSets: changeSets
        )
    }

    /// The six requests an older server needs.
    private func loadSeparately(app: AppModel) async throws -> TodaySnapshot {
        let cal = Calendar.current
        let start = cal.startOfDay(for: Date())
        let end = cal.date(byAdding: .day, value: 7, to: start)!
        let api = API.shared
        async let brief: BriefResponse = api.get("/api/briefs")
        async let rem: RemindersResponse = api.get("/api/reminders", query: ["upcoming": "true", "days": "14", "limit": "50"])
        async let tl: TimelineResponse = api.get("/api/timeline", query: ["from": ISODate.string(start), "to": ISODate.string(end), "types": "event"])
        async let sug: SuggestionsResponse = api.get("/api/suggestions", query: ["status": "pending", "limit": "10"])
        async let lib: LibraryResponse = api.get("/api/library", query: ["limit": "5"])
        async let people: PeopleOverview = api.get("/api/people")
        let (b, r, t, s, l) = try await (brief, rem, tl, sug, lib)
        let p = try? await people
        let me = p?.people.first { $0.isViewer == true }
        await loadChangeSets()
        return TodaySnapshot(brief: b.brief, reminders: r.reminders, week: t.items, people: t.people ?? [], suggestions: s.suggestions,
                             recent: l.items, myName: me?.label ?? app.myName, myPersonId: me?.id ?? app.myPersonId, changeSets: changeSets)
    }

    func loadChangeSets() async {
        do {
            let r: ChangeSetsResponse = try await API.shared.get("/api/changes", query: ["status": "draft", "limit": "10"])
            changeSets = r.changeSets
        } catch {
            changeSets = nil
        }
    }

    func writeBrief(refresh: Bool) async {
        briefBusy = true; briefError = nil
        defer { briefBusy = false }
        do {
            let r: BriefResponse = try await API.shared.call("POST", "/api/briefs", json: ["refresh": refresh])
            snap?.brief = r.brief
        } catch {
            briefError = error.plainMessage
        }
    }

    func complete(_ r: Reminder) async -> String? {
        guard let i = snap?.reminders.firstIndex(where: { $0.id == r.id }) else { return nil }
        let removed = snap!.reminders.remove(at: i)
        do {
            _ = try await API.shared.send(API.shared.request("PATCH", "/api/reminders/\(r.id)", json: ["done": true]))
            ReminderNotifications.remove(id: r.id)
            return nil
        } catch {
            snap?.reminders.insert(removed, at: min(i, snap?.reminders.count ?? 0))
            return error.plainMessage
        }
    }

    /// approve | always | deny
    func decide(_ s: Suggestion, _ decision: String) async -> (DecisionResponse?, String?) {
        deciding.insert(s.id); defer { deciding.remove(s.id) }
        do {
            let out: DecisionResponse = try await API.shared.call("POST", "/api/suggestions/\(s.id)", json: ["decision": decision])
            snap?.suggestions.removeAll { $0.id == s.id }
            return (out, nil)
        } catch {
            return (nil, error.plainMessage)
        }
    }

    /// deliver | abandon
    func decide(_ c: ChangeSet, _ action: String) async -> String? {
        deciding.insert(c.id); defer { deciding.remove(c.id) }
        do {
            let body: [String: Any] = action == "deliver" ? (c.fingerprint.map { ["fingerprint": $0] } ?? [:]) : [:]
            try await API.shared.post("/api/changes/\(c.id)/\(action)", json: body)
            changeSets?.removeAll { $0.id == c.id }
            snap?.changeSets = changeSets
            return nil
        } catch {
            return error.plainMessage
        }
    }

    var weekGroups: [WeekGroup] {
        guard let snap else { return [] }
        if let server = snap.weekByPerson {
            let done = Set(snap.reminders.filter(\.done).map(\.id))
            let open = Set(snap.reminders.map(\.id))
            return server.compactMap { g in
                let entries = g.entries.compactMap { e -> WeekGroup.Entry? in
                    // A to-do ticked on this screen leaves the week too.
                    if let rid = e.reminderId, done.contains(rid) || !open.contains(rid) { return nil }
                    let route: Route? = e.nodeId.map { .node($0) } ?? e.sourceId.map { .source($0) }
                    return WeekGroup.Entry(id: e.id, title: e.title, at: e.at, allDay: e.allDay, route: route, isReminder: e.isReminder)
                }
                return entries.isEmpty ? nil : WeekGroup(id: g.id, personId: g.personId, name: g.name, entries: entries)
            }
        }
        let names = Dictionary(snap.people.map { ($0.id, $0.label) }, uniquingKeysWith: { a, _ in a })
        let order = snap.people.map(\.id)
        let end = Calendar.current.date(byAdding: .day, value: 7, to: Calendar.current.startOfDay(for: Date()))!
        var groups: [String: WeekGroup] = [:]
        func add(_ pid: String?, _ e: WeekGroup.Entry) {
            let key = pid ?? "family"
            let name = pid.flatMap { names[$0] } ?? String(localized: "Whole family")
            groups[key, default: WeekGroup(id: key, personId: pid, name: name, entries: [])].entries.append(e)
        }
        for item in snap.week where item.kind == "event" {
            let route: Route? = item.nodeId.map { .node($0) } ?? item.sourceId.map { .source($0) }
            let e = WeekGroup.Entry(id: item.id, title: item.title, at: item.start, allDay: item.precision != "minute", route: route, isReminder: false)
            let pids = (item.personIds ?? []).filter { names[$0] != nil }
            if pids.isEmpty { add(nil, e) } else { for p in pids { add(p, e) } }
        }
        for r in snap.reminders where !r.done && r.dueAt < end {
            let route: Route? = r.nodeId.map { .node($0) } ?? r.sourceId.map { .source($0) }
            let e = WeekGroup.Entry(id: "r:\(r.id)", title: r.title, at: r.dueAt, allDay: false, route: route, isReminder: true)
            add(r.aboutNodeId.flatMap { names[$0] != nil ? $0 : nil }, e)
        }
        var out = groups.values.map { g -> WeekGroup in var g = g; g.entries.sort { $0.at < $1.at }; return g }
        out.sort { a, b in
            let ia = a.personId.flatMap { order.firstIndex(of: $0) } ?? Int.max
            let ib = b.personId.flatMap { order.firstIndex(of: $0) } ?? Int.max
            return ia == ib ? a.name < b.name : ia < ib
        }
        return out
    }
}
