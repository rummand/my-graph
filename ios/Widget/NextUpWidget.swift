import WidgetKit
import SwiftUI

struct NextUpProvider: TimelineProvider {
    func placeholder(in context: Context) -> NextUpEntry {
        NextUpEntry(date: Date(), snapshot: NextUpSnapshot(graphName: "Family", graphHue: 28, items: [
            NextUpItem(id: "1", title: String(localized: "Pack lunch for the zoo trip"), at: Date().addingTimeInterval(3600), personId: "a", personName: "Emma", isReminder: true, allDay: false),
            NextUpItem(id: "2", title: String(localized: "Swimming"), at: Date().addingTimeInterval(7200), personId: "b", personName: "Noah", isReminder: false, allDay: false),
        ], savedAt: Date()), signedIn: true)
    }

    func getSnapshot(in context: Context, completion: @escaping (NextUpEntry) -> Void) {
        if context.isPreview { completion(placeholder(in: context)); return }
        completion(NextUpEntry(date: Date(), snapshot: NextUp.load(), signedIn: true))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<NextUpEntry>) -> Void) {
        Task {
            MGFont.register()
            CookieVault.restore()
            API.shared.persistsCookies = false
            let signedIn = CookieVault.hasSession
            var snap = NextUp.load()
            if signedIn, let fresh = try? await NextUp.fetch() { snap = fresh }
            let now = Date()
            // One entry now, and one as each item passes, so the list moves on by itself.
            var entries = [NextUpEntry(date: now, snapshot: snap, signedIn: signedIn)]
            for item in (snap?.items ?? []) where item.at > now && !item.allDay {
                entries.append(NextUpEntry(date: item.at.addingTimeInterval(15 * 60), snapshot: snap, signedIn: signedIn))
            }
            let midnight = Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: now))!
            let refresh = min(now.addingTimeInterval(30 * 60), midnight)
            completion(Timeline(entries: entries, policy: .after(refresh)))
        }
    }
}

struct NextUpWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "NextUp", provider: NextUpProvider()) { entry in
            NextUpView(entry: entry)
        }
        .configurationDisplayName(Text("Next up"))
        .description(Text("The next three things today in your current graph."))
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

@main
struct MyGraphWidgets: WidgetBundle {
    var body: some Widget { NextUpWidget() }
}
