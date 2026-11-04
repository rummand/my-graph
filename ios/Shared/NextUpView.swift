import SwiftUI
import WidgetKit

struct NextUpEntry: TimelineEntry {
    let date: Date
    let snapshot: NextUpSnapshot?
    let signedIn: Bool
}

struct NextUpView: View {
    let entry: NextUpEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        let items = (entry.snapshot?.items ?? []).filter { $0.allDay || $0.at > entry.date.addingTimeInterval(-15 * 60) }.prefix(3)
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 5) {
                Circle().fill(GraphColor.dot(entry.snapshot?.graphHue ?? 210)).frame(width: 7, height: 7)
                Text("Next up").font(Font(MGFont.base(size: 13, weight: 600))).foregroundStyle(Color.mgFg)
                Spacer(minLength: 0)
                if family != .systemSmall, let g = entry.snapshot?.graphName {
                    Text(g).font(Font(MGFont.base(size: 11, weight: 400))).foregroundStyle(Color.mgMuted).lineLimit(1)
                }
            }
            if !entry.signedIn {
                Spacer(minLength: 0)
                Text("Open My Graph to sign in.").font(Font(MGFont.base(size: 13, weight: 400))).foregroundStyle(Color.mgMuted)
                Spacer(minLength: 0)
            } else if items.isEmpty {
                Spacer(minLength: 0)
                Text("Nothing more today.").font(Font(MGFont.base(size: 14, weight: 500))).foregroundStyle(Color.mgFg)
                Text("Enjoy the rest of the day.").font(Font(MGFont.base(size: 12, weight: 400))).foregroundStyle(Color.mgMuted)
                Spacer(minLength: 0)
            } else {
                ForEach(Array(items)) { item in
                    HStack(alignment: .top, spacing: 7) {
                        RoundedRectangle(cornerRadius: 1.5)
                            .fill(item.personId.map { PersonColor.solid($0) } ?? Color.mgMuted)
                            .frame(width: 3)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(item.title).font(Font(MGFont.base(size: 13, weight: 500))).foregroundStyle(Color.mgFg).lineLimit(family == .systemSmall ? 2 : 1)
                            Text(subtitle(item)).font(Font(MGFont.base(size: 11, weight: 400))).foregroundStyle(Color.mgMuted).lineLimit(1)
                        }
                    }
                    .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
        }
        .containerBackground(for: .widget) { Color.mgSurface }
        .widgetURL(URL(string: "mygraph://today"))
    }

    private func subtitle(_ i: NextUpItem) -> String {
        let when = i.allDay ? String(localized: "Today") : i.at.formatted(date: .omitted, time: .shortened)
        if let p = i.personName { return "\(when), \(p)" }
        return when
    }
}

