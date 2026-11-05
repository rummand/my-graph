#if DEBUG
import Foundation

/// Debug builds: `mygraph-mac://debug-send-sample?source=contacts|calendar|reminders|calls` sends a few made-up items
/// through the same path as a real run (ledger, batches, import door). For checking the server contract on a Mac where
/// macOS hasn't been allowed to show its privacy prompts.
@MainActor
enum DebugSamples {
    struct Sample: MacSource {
        let id: SourceID
        func permission() -> Permission { .granted }
        func run(_ ctx: SyncContext) async throws -> SourceResult {
            let day = { (d: Int, h: Int) in AppleTime.iso(Calendar.current.date(byAdding: .hour, value: h, to: Calendar.current.startOfDay(for: Date().addingTimeInterval(Double(d) * 86_400))))! }
            switch id {
            case .contacts:
                var a = ContactItem(id: "sample-ida", name: "Ida Sample Hansen")
                a.givenName = "Ida"; a.familyName = "Sample Hansen"
                a.phones = [ImportLabelled(label: "mobile", value: "+45 20 11 22 33")]
                a.emails = [ImportLabelled(label: "home", value: "ida.sample@example.com")]
                a.birthday = "1984-03-02"
                return SourceResult(sent: try await sendChanged(ctx, importer: .contacts, items: [a], id: \.id) { ContactsData(contacts: $0) })
            case .calendar:
                let e = EventItem(id: "sample-football-final", calendar: "Family", title: "Football final (sample)", start: day(3, 10), end: day(3, 11),
                                  location: "Skovbo Skole", notes: "Bring water", attendees: [EventAttendee(name: "Ida Sample Hansen", email: "ida.sample@example.com")])
                return SourceResult(sent: try await sendChanged(ctx, importer: .calendar, items: [e], id: \.id) { CalendarData(events: $0) })
            case .reminders:
                let r = ReminderItem(id: "sample-fix-bike", list: "Home", title: "Fix bike (sample)", due: day(4, 9), done: false, priority: 1)
                return SourceResult(sent: try await sendChanged(ctx, importer: .reminders, items: [r], id: \.id) { RemindersData(reminders: $0) })
            case .calls:
                let c = CallItem(id: "sample-call-1", at: day(0, 9), durationSec: 240, direction: "in", handle: "+45 20 11 22 33", name: "Ida Sample Hansen", service: "phone")
                let batch = MacBatch(runId: ctx.runId, batch: "calls-sample-1", final: true, device: ctx.device, data: CallsData(calls: [c]))
                let a = try await ctx.api.importBatch(.calls, batch)
                print("[debug] calls answer: kept \(a.kept ?? -1) dropped \(a.dropped ?? -1) source \(a.sourceId ?? "-")")
                return SourceResult(sent: 1)
            default:
                return SourceResult(sent: 0)
            }
        }
    }

    static func send(_ id: SourceID) async {
        let sync = SyncEngine.shared
        await sync.refreshSettings()
        let ctx = SyncContext(api: sync.api, store: sync.store, settings: sync.settings, runId: UUID().uuidString, device: DeviceName.current)
        do {
            let r = try await Sample(id: id).run(ctx)
            print("[debug] sample \(id.rawValue): sent \(r.sent)")
        } catch {
            print("[debug] sample \(id.rawValue) failed: \((error as? LocalizedError)?.errorDescription ?? "\(error)")")
        }
    }
}
#endif
