import Foundation
import EventKit
import AppKit

/// Writes back what a person approved in My Graph: events into a "My Graph" calendar and reminders into a "My Graph"
/// list, both made by this app. Only items in those two are ever created, changed or deleted; the person's own
/// calendars, lists and items are never touched. Ticking a My Graph reminder done in Reminders is reported back.
enum WriteBack {
    static let name = "My Graph"
    /// Cobalt, the one data hue (DESIGN.md).
    static let color = NSColor(srgbRed: 0x2F / 255, green: 0x4B / 255, blue: 0xB0 / 255, alpha: 1)

    struct Outcome: Equatable {
        var applied = 0
        var reported = 0
        var skipped = 0
    }

    static func run(api: MacAPI, store: StateStore, settings: MacSettings) async throws -> Outcome {
        let canEvents = Permissions.events(.event) == .granted
        let canReminders = Permissions.events(.reminder) == .granted
        guard canEvents || canReminders else { return Outcome() }
        let ek = EventStore.shared
        var state = store.load()
        let page = try await api.outbox(since: state.outboxCursor)

        var outcome = Outcome()
        var skippedForPermission = false

        // The current state of everything written so far.
        var local: [String: LocalItemState] = [:]
        for (_, link) in state.outbox {
            guard let item = ek.calendarItem(withIdentifier: link.localId), isOurs(item, state: state) else {
                local[link.localId] = LocalItemState(exists: false); continue
            }
            if let r = item as? EKReminder { local[link.localId] = LocalItemState(exists: true, completed: r.isCompleted, completedAt: r.completionDate) }
            else { local[link.localId] = LocalItemState(exists: true) }
        }

        let incoming = page.items.filter { item in
            let ok = item.isReminder ? canReminders : canEvents
            if !ok { skippedForPermission = true }
            return ok
        }
        // Links of a kind this Mac can't open now are left alone (not "deleted").
        let links = state.outbox.filter { $0.value.item.isReminder ? canReminders : canEvents }
        let ops = OutboxPlanner.plan(incoming: incoming, links: links, local: local)
        for op in ops {
            do {
                switch op {
                case .create(let item), .recreate(let item):
                    let localId = try write(item, existing: nil, state: &state)
                    state.outbox[item.id] = OutboxLink(localId: localId, item: item, completedReported: item.completed == true)
                    outcome.applied += 1
                case .update(let localId, let item):
                    let newId = try write(item, existing: ek.calendarItem(withIdentifier: localId), state: &state)
                    var link = state.outbox[item.id] ?? OutboxLink(localId: newId, item: item)
                    link.localId = newId
                    link.item = item
                    if item.completed == true { link.completedReported = true }
                    state.outbox[item.id] = link
                    outcome.applied += 1
                case .delete(let localId, let serverId):
                    if let item = ek.calendarItem(withIdentifier: localId), isOurs(item, state: state) {
                        if let e = item as? EKEvent { try ek.remove(e, span: .thisEvent, commit: false) }
                        if let r = item as? EKReminder { try ek.remove(r, commit: false) }
                    }
                    state.outbox[serverId] = nil
                    outcome.applied += 1
                case .reportCompleted(let serverId, _):
                    // The only write this Mac makes in My Graph: the person ticked their own reminder done here.
                    if settings.writeBackReminders {
                        do { try await api.ackDone(reminderId: serverId) } catch MacAPI.Failure.notFound(_) {}
                        outcome.reported += 1
                    }
                    state.outbox[serverId]?.completedReported = true
                case .reportDeleted(let serverId):
                    // Deleted in Reminders by the person: theirs to decide; it isn't put back, and My Graph keeps its own.
                    state.outbox[serverId]?.deletedLocally = true
                case .nothing(let serverId):
                    if incoming.contains(where: { $0.id == serverId && $0.op == "delete" }) { state.outbox[serverId] = nil }
                }
            } catch {
                outcome.skipped += 1
            }
        }
        try ek.commit()
        if !skippedForPermission, let c = page.cursor { state.outboxCursor = c }
        let final = state
        store.update { s in
            s.outbox = final.outbox
            s.outboxCursor = final.outboxCursor
            s.calendarId = final.calendarId
            s.remindersListId = final.remindersListId
        }
        return outcome
    }

    static func isOurs(_ item: EKCalendarItem, state: SyncState) -> Bool {
        guard let id = item.calendar?.calendarIdentifier else { return false }
        return id == state.calendarId || id == state.remindersListId
    }

    /// The "My Graph" calendar or list, made (again) when it is missing.
    static func ourCalendar(_ type: EKEntityType, state: inout SyncState) throws -> EKCalendar {
        let ek = EventStore.shared
        let known = type == .event ? state.calendarId : state.remindersListId
        if let id = known, let c = ek.calendar(withIdentifier: id) { return c }
        let cal = EKCalendar(for: type, eventStore: ek)
        cal.title = name
        cal.cgColor = color.cgColor
        let preferred = type == .event ? ek.defaultCalendarForNewEvents?.source : ek.defaultCalendarForNewReminders()?.source
        guard let source = preferred ?? ek.sources.first(where: { $0.sourceType == .local }) ?? ek.sources.first else {
            throw SourceError.failed(L("There is no calendar account on this Mac to keep the My Graph calendar in."))
        }
        cal.source = source
        try ek.saveCalendar(cal, commit: true)
        if type == .event { state.calendarId = cal.calendarIdentifier } else { state.remindersListId = cal.calendarIdentifier }
        return cal
    }

    /// The item's notes, with a line to open it in My Graph.
    static func notes(_ item: OutboxItem) -> String? {
        let open = item.url.map { L("Open in My Graph: \($0)") }
        let parts = [item.notes?.nilIfBlank, open].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: "\n\n")
    }

    /// Writes one item into the My Graph calendar or list; returns its EventKit identifier.
    static func write(_ item: OutboxItem, existing: EKCalendarItem?, state: inout SyncState) throws -> String {
        let ek = EventStore.shared
        let mine = existing.flatMap { isOurs($0, state: state) ? $0 : nil }
        if item.isReminder {
            let list = try ourCalendar(.reminder, state: &state)
            let r = (mine as? EKReminder) ?? EKReminder(eventStore: ek)
            r.calendar = list
            r.title = item.title ?? L("Reminder")
            r.notes = notes(item)
            r.url = item.url.flatMap(URL.init(string:))
            if let due = AppleTime.parseISO(item.dueAt) ?? ISODate.parse(item.dueAt ?? "") {
                let dateOnly = (item.dueAt?.count ?? 0) == 10
                let comps: Set<Calendar.Component> = dateOnly ? [.year, .month, .day] : [.year, .month, .day, .hour, .minute]
                r.dueDateComponents = Calendar.current.dateComponents(comps, from: due)
            } else {
                r.dueDateComponents = nil
            }
            if let done = item.completed { r.isCompleted = done }
            try ek.save(r, commit: false)
            return r.calendarItemIdentifier
        }
        let cal = try ourCalendar(.event, state: &state)
        guard let start = AppleTime.parseISO(item.startAt) ?? ISODate.parse(item.startAt ?? "") else {
            throw SourceError.failed(L("This event has no start time."))
        }
        let e = (mine as? EKEvent) ?? EKEvent(eventStore: ek)
        e.calendar = cal
        e.title = item.title ?? L("Event")
        e.notes = notes(item)
        e.location = item.location
        e.url = item.url.flatMap(URL.init(string:))
        e.isAllDay = item.allDay ?? false
        e.startDate = start
        e.endDate = AppleTime.parseISO(item.endAt) ?? ISODate.parse(item.endAt ?? "") ?? start.addingTimeInterval(e.isAllDay ? 86_400 : 3600)
        try ek.save(e, span: .thisEvent, commit: false)
        return e.calendarItemIdentifier
    }
}
