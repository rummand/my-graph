import Foundation
import Contacts
import EventKit

/// Contacts: every card (CNContactStore), mapped like the iPhone does (shared ContactsSource), only changed cards sent.
struct ContactsMacSource: MacSource {
    let id = SourceID.contacts
    func permission() -> Permission { Permissions.contacts }

    func run(_ ctx: SyncContext) async throws -> SourceResult {
        guard permission().isUsable else { throw SourceError.permission(permission()) }
        let items = try await ContactsSource.readAll()
        let sent = try await sendChanged(ctx, importer: .contacts, items: items, id: \.id, maxCount: PhoneImporter.contacts.maxItems) {
            ContactsData(contacts: $0)
        }
        return SourceResult(sent: sent)
    }
}

/// One EventKit store for the whole app (it is expensive to make, and change notifications come from it).
enum EventStore {
    nonisolated(unsafe) static let shared = EKEventStore()

    static func requestEvents() async -> Bool { (try? await shared.requestFullAccessToEvents()) ?? false }
    static func requestReminders() async -> Bool { (try? await shared.requestFullAccessToReminders()) ?? false }

    /// The calendars and lists the app made for write-back, left out of what is read.
    static func isOurs(_ c: EKCalendar, state: SyncState) -> Bool {
        c.calendarIdentifier == state.calendarId || c.calendarIdentifier == state.remindersListId
    }
}

/// Calendar: events 30 days back and 120 ahead in every calendar except "My Graph" (what the app writes back).
struct CalendarMacSource: MacSource {
    let id = SourceID.calendar
    func permission() -> Permission { Permissions.events(.event) }

    static let daysBack = 30
    static let daysAhead = 120

    static func item(_ e: EKEvent) -> EventItem? {
        guard let start = e.startDate else { return nil }
        let base = e.calendarItemExternalIdentifier ?? e.calendarItemIdentifier
        let occurrence = e.hasRecurrenceRules ? "@" + (AppleTime.iso(e.occurrenceDate ?? start) ?? "") : ""
        let attendees = (e.attendees ?? []).prefix(200).compactMap { a -> EventAttendee? in
            let email = a.url.scheme == "mailto" ? a.url.absoluteString.replacingOccurrences(of: "mailto:", with: "").removingPercentEncoding : nil
            let out = EventAttendee(name: PhoneImportKit.clip(a.name, 200), email: PhoneImportKit.clip(email, 320))
            return out.name == nil && out.email == nil ? nil : out
        }
        return EventItem(id: String((base + occurrence).prefix(300)), calendar: PhoneImportKit.clip(e.calendar?.title, 200) ?? L("Calendar"),
                         title: PhoneImportKit.clip(e.title, 500) ?? L("Event"), start: AppleTime.iso(start) ?? "",
                         end: AppleTime.iso(e.endDate), allDay: e.isAllDay, location: PhoneImportKit.clip(e.location, 500),
                         notes: PhoneImportKit.clip(e.notes, 10_000), url: PhoneImportKit.clip(e.url?.absoluteString, 2000),
                         attendees: attendees.isEmpty ? nil : Array(attendees))
    }

    func run(_ ctx: SyncContext) async throws -> SourceResult {
        guard permission() == .granted else { throw SourceError.permission(permission()) }
        let state = ctx.store.load()
        let store = EventStore.shared
        let cals = store.calendars(for: .event).filter { !EventStore.isOurs($0, state: state) }
        guard !cals.isEmpty else { return SourceResult(sent: 0) }
        let now = Date()
        let start = Calendar.current.date(byAdding: .day, value: -Self.daysBack, to: now)!
        let end = Calendar.current.date(byAdding: .day, value: Self.daysAhead, to: now)!
        let events = store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: cals))
        let items = events.compactMap(Self.item)
        let sent = try await sendChanged(ctx, importer: .calendar, items: items, id: \.id) { CalendarData(events: $0) }
        return SourceResult(sent: sent)
    }
}

/// Reminders: open reminders and those finished in the last 30 days, in every list except "My Graph".
struct RemindersMacSource: MacSource {
    let id = SourceID.reminders
    func permission() -> Permission { Permissions.events(.reminder) }

    static func item(_ r: EKReminder) -> ReminderItem {
        let due = r.dueDateComponents.flatMap { Calendar.current.date(from: $0) }
        return ReminderItem(id: String((r.calendarItemExternalIdentifier ?? r.calendarItemIdentifier).prefix(300)),
                            list: PhoneImportKit.clip(r.calendar?.title, 200) ?? L("Reminders"), title: PhoneImportKit.clip(r.title, 500) ?? L("Reminder"),
                            due: AppleTime.iso(due), notes: PhoneImportKit.clip(r.notes, 10_000), done: r.isCompleted,
                            priority: (1...9).contains(r.priority) ? r.priority : nil)
    }

    static func fetch(_ predicate: NSPredicate) async -> [EKReminder] {
        await withCheckedContinuation { c in
            EventStore.shared.fetchReminders(matching: predicate) { c.resume(returning: $0 ?? []) }
        }
    }

    func run(_ ctx: SyncContext) async throws -> SourceResult {
        guard permission() == .granted else { throw SourceError.permission(permission()) }
        let state = ctx.store.load()
        let store = EventStore.shared
        let lists = store.calendars(for: .reminder).filter { !EventStore.isOurs($0, state: state) }
        guard !lists.isEmpty else { return SourceResult(sent: 0) }
        let open = await Self.fetch(store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: lists))
        let since = Calendar.current.date(byAdding: .day, value: -30, to: Date())!
        let done = await Self.fetch(store.predicateForCompletedReminders(withCompletionDateStarting: since, ending: Date(), calendars: lists))
        let items = (open + done).map(Self.item)
        let sent = try await sendChanged(ctx, importer: .reminders, items: items, id: \.id) { RemindersData(reminders: $0) }
        return SourceResult(sent: sent)
    }
}

/// Calls: Call History (Full Disk Access), after the last record sent. Only numbers, times and lengths; never audio.
struct CallsMacSource: MacSource {
    let id = SourceID.calls
    var path = CallHistory.defaultPath

    func permission() -> Permission { Permissions.fileSource(path) }

    func run(_ ctx: SyncContext) async throws -> SourceResult {
        let state = ctx.store.load()[.calls]
        let generation = ctx.settings.generation[.calls] ?? 0
        var after: Int64 = ctx.settings.serverCursor[.calls].flatMap { Int64($0) } ?? 0
        if after == 0, state.generation == generation { after = state.cursor.flatMap { Int64($0) } ?? 0 }
        let yearAgo = Calendar.current.date(byAdding: .year, value: -1, to: Date())!
        let since = max(yearAgo, ctx.settings.callsSince ?? yearAgo)
        let records: [CallHistory.Record]
        do { records = try CallHistory.read(path: path, afterPk: after, since: since) } catch let e as SQLiteReader.Failure {
            switch e {
            case .noAccess: throw SourceError.permission(.needsFullDiskAccess)
            case .missing: throw SourceError.permission(.unavailable)
            case .failed(let m): throw SourceError.failed(m)
            }
        }
        let names = ContactNames.load()
        let items = records.compactMap { CallHistory.item($0, nameOf: names.name(for:)) }
        let lastPk = records.last?.pk ?? after
        let batches = PhoneImportKit.batches(items, maxBytes: ctx.maxBytes, maxCount: 20_000)
        for (i, b) in batches.enumerated() {
            let final = i == batches.count - 1
            let batch = MacBatch(runId: ctx.runId, batch: batchName("calls-\(b.first?.id ?? "")-\(b.count)"), final: final, device: ctx.device,
                                 data: CallsData(calls: b))
            _ = try await ctx.api.importBatch(.calls, batch)
        }
        ctx.store.update { s in s[.calls].cursor = String(lastPk); s[.calls].generation = generation }
        return SourceResult(sent: items.count)
    }
}
