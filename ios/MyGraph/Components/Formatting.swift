import Foundation
import SwiftUI

/// Dates are stored in UTC and shown in the person's locale and time zone.
enum Fmt {
    static func time(_ d: Date) -> String { d.formatted(date: .omitted, time: .shortened) }

    static func dayTitle(_ d: Date, calendar: Calendar = .current) -> String {
        if calendar.isDateInToday(d) { return String(localized: "Today") }
        if calendar.isDateInTomorrow(d) { return String(localized: "Tomorrow") }
        if calendar.isDateInYesterday(d) { return String(localized: "Yesterday") }
        let sameYear = calendar.isDate(d, equalTo: Date(), toGranularity: .year)
        return sameYear ? d.formatted(.dateTime.weekday(.wide).day().month(.wide)) : d.formatted(.dateTime.weekday(.wide).day().month(.wide).year())
    }

    static func shortDay(_ d: Date, calendar: Calendar = .current) -> String {
        if calendar.isDateInToday(d) { return String(localized: "Today") }
        if calendar.isDateInTomorrow(d) { return String(localized: "Tomorrow") }
        return d.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
    }

    /// "Today 08:00", "Tomorrow", "Thu 26 Nov 08:30".
    static func when(_ d: Date, allDay: Bool = false) -> String {
        let day = shortDay(d)
        return allDay ? day : "\(day) \(time(d))"
    }

    static func relative(_ d: Date) -> String {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .full
        return f.localizedString(for: d, relativeTo: Date())
    }

    static func longDate(_ d: Date) -> String { d.formatted(.dateTime.weekday(.wide).day().month(.wide)) }

    static func bytes(_ n: Int?) -> String? {
        guard let n else { return nil }
        return ByteCountFormatter.string(fromByteCount: Int64(n), countStyle: .file)
    }

    static func greeting(_ d: Date = Date()) -> String {
        let h = Calendar.current.component(.hour, from: d)
        switch h {
        case 5..<12: return String(localized: "Good morning")
        case 12..<18: return String(localized: "Good afternoon")
        case 18..<23: return String(localized: "Good evening")
        default: return String(localized: "Hello")
        }
    }

    static func visibilityLabel(_ v: String?) -> String {
        switch v {
        case "private": return String(localized: "Only you")
        case "parents": return String(localized: "Parents")
        case "household": return String(localized: "Everyone at home")
        default: return v ?? ""
        }
    }

    static func circleLabel(_ c: String) -> String {
        switch c {
        case "family": return String(localized: "Family")
        case "close": return String(localized: "Close friends")
        case "school": return String(localized: "School & daycare")
        case "care": return String(localized: "Care & health")
        case "social": return String(localized: "Friends & neighbours")
        case "work": return String(localized: "Work")
        default: return String(localized: "Others")
        }
    }

    static let circleOrder = ["family", "close", "school", "care", "social", "work", "other"]

    static func relationWord(_ r: String) -> String { r.replacingOccurrences(of: "_", with: " ") }
}

/// Answer text: paragraphs and lists with **bold**, citation marks [n] as links, and @mentions as links.
enum RichText {
    /// `@[Label](node:<uuid>)` → markdown link to the node.
    static func mentionsToLinks(_ s: String) -> String {
        s.replacingOccurrences(of: #"@\[([^\]]+)\]\(node:([0-9a-fA-F-]{36})\)"#, with: "[@$1](mygraph://node/$2)", options: .regularExpression)
    }

    /// `@[Label](node:<uuid>)` → "@Label" (plain, for previews).
    static func mentionsToPlain(_ s: String) -> String {
        s.replacingOccurrences(of: #"@\[([^\]]+)\]\(node:[0-9a-fA-F-]{36}\)"#, with: "@$1", options: .regularExpression)
    }

    static func citationLinks(_ s: String, citations: [Citation]) -> String {
        guard !citations.isEmpty else { return s }
        var out = s
        for c in citations {
            guard let n = c.n, let route = Route.forCitation(c), let url = route.appURL else { continue }
            out = out.replacingOccurrences(of: "[\(n)]", with: "[[\(n)]](\(url.absoluteString))")
        }
        return out
    }

    static func attributed(_ markdown: String, citations: [Citation] = []) -> AttributedString {
        let prepared = citationLinks(mentionsToLinks(markdown), citations: citations)
        var a = (try? AttributedString(markdown: prepared, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(prepared)
        for run in a.runs where run.link != nil {
            a[run.range].foregroundColor = Color.mgAccent
            if run.link?.host == "source" || run.link?.host == "node" {
                if String(a[run.range].characters).hasPrefix("[") {
                    a[run.range].font = Font(MGFont.base(size: 13, weight: 600))
                }
            }
        }
        return a
    }

    struct Block: Identifiable {
        let id: Int
        let kind: Kind
        let text: String
        enum Kind { case paragraph, bullet, numbered(String), heading }
    }

    static func blocks(_ s: String) -> [Block] {
        var out: [Block] = []
        var para: [String] = []
        func flush() {
            if !para.isEmpty { out.append(Block(id: out.count, kind: .paragraph, text: para.joined(separator: "\n"))); para = [] }
        }
        for raw in s.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { flush(); continue }
            if line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("• ") {
                flush(); out.append(Block(id: out.count, kind: .bullet, text: String(line.dropFirst(2))))
            } else if let m = line.range(of: #"^\d+[.)]\s"#, options: .regularExpression) {
                flush(); out.append(Block(id: out.count, kind: .numbered(String(line[m]).trimmingCharacters(in: .whitespaces)), text: String(line[m.upperBound...])))
            } else if line.hasPrefix("#") {
                flush(); out.append(Block(id: out.count, kind: .heading, text: line.trimmingCharacters(in: CharacterSet(charactersIn: "# "))))
            } else {
                para.append(line)
            }
        }
        flush()
        return out
    }
}

/// Renders answer markdown as native text with tappable citations and mentions.
struct RichTextView: View {
    let text: String
    var citations: [Citation] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(RichText.blocks(text)) { b in
                switch b.kind {
                case .paragraph:
                    Text(RichText.attributed(b.text, citations: citations))
                case .heading:
                    Text(RichText.attributed(b.text, citations: citations)).mgFont(.bodyStrong)
                case .bullet:
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("•").foregroundStyle(Color.mgMuted).accessibilityHidden(true)
                        Text(RichText.attributed(b.text, citations: citations))
                    }
                case .numbered(let n):
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(n).monospacedDigit().foregroundStyle(Color.mgMuted)
                        Text(RichText.attributed(b.text, citations: citations))
                    }
                }
            }
        }
        .foregroundStyle(Color.mgFg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }
}
