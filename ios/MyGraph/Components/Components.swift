import SwiftUI

/// A person's avatar: initials on their pale tint, ring in their own colour. Never colour a person by hand.
struct Avatar: View {
    let name: String
    let id: String?
    var size: CGFloat = 36

    var body: some View {
        let key = id ?? name
        Text(PersonColor.initials(name))
            .font(Font(MGFont.base(size: size * 0.38, weight: 600)))
            .foregroundStyle(id == nil ? Color.mgMuted : PersonColor.solid(key))
            .frame(width: size, height: size)
            .background(Circle().fill(id == nil ? Color.mgSurface2 : PersonColor.tint(key)))
            .accessibilityHidden(true)
    }
}

/// A person's name on their tint, for answers and lists.
struct PersonChip: View {
    let name: String
    let id: String
    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(PersonColor.solid(id)).frame(width: 7, height: 7)
            Text(name).mgFont(.secondaryStrong).foregroundStyle(Color.mgFg).lineLimit(1)
        }
        .padding(.horizontal, 9).padding(.vertical, 4)
        .background(Capsule().fill(PersonColor.tint(id)))
        .accessibilityElement(children: .combine)
    }
}

/// A source mark in cobalt: "where did this come from?" always looks the same.
struct CitationChip: View {
    let citation: Citation
    var body: some View {
        HStack(spacing: 4) {
            if let n = citation.n {
                Text("\(n)").mgFont(.meta).monospacedDigit()
                    .foregroundStyle(Color.mgAccentFg)
                    .frame(minWidth: 16, minHeight: 16)
                    .background(Circle().fill(Color.mgAccent))
            }
            Text(citation.title).mgFont(.secondary).lineLimit(1)
        }
        .foregroundStyle(Color.mgAccent)
        .padding(.leading, 4).padding(.trailing, 9).padding(.vertical, 4)
        .background(Capsule().fill(Color.mgAccentTint))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Source \(citation.n ?? 0): \(citation.title)"))
        .accessibilityAddTraits(.isLink)
    }
}

struct CitationRow: View {
    let citations: [Citation]
    @Environment(Router.self) private var router

    var body: some View {
        if !citations.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(citations) { c in
                        Button {
                            if let r = Route.forCitation(c) { router.push(r) }
                        } label: { CitationChip(citation: c) }
                        .buttonStyle(.plain)
                        .disabled(Route.forCitation(c) == nil)
                    }
                }
            }
            .scrollClipDisabled()
        }
    }
}

/// A node chip (place, event, topic …) with its type colour as a dot.
struct NodeChip: View {
    let label: String
    let type: String?
    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(Color.nodeType(type)).frame(width: 6, height: 6)
            Text(label).mgFont(.secondary).foregroundStyle(Color.mgFg).lineLimit(1)
        }
        .padding(.horizontal, 9).padding(.vertical, 4)
        .background(Capsule().fill(Color.mgSurface2))
    }
}

struct GraphPill: View {
    let graph: GraphSummary?
    var body: some View {
        let hue = graph?.hue ?? 210
        HStack(spacing: 6) {
            Circle().fill(GraphColor.dot(hue)).frame(width: 8, height: 8)
            Text(graph?.name ?? "My Graph").mgFont(.secondaryStrong).foregroundStyle(Color.mgFg).lineLimit(1).fixedSize()
            Image(systemName: "chevron.up.chevron.down").font(.system(size: 10, weight: .semibold)).foregroundStyle(Color.mgMuted)
        }
        .padding(.leading, 10).padding(.trailing, 8).padding(.vertical, 6)
        .background(Capsule().fill(GraphColor.tint(hue)))
        .fixedSize()
    }
}

/// Section heading on the ground (no box), with an optional action on the right.
struct SectionHeader<Trailing: View>: View {
    let title: LocalizedStringKey
    var trailing: Trailing

    init(_ title: LocalizedStringKey, @ViewBuilder trailing: () -> Trailing) {
        self.title = title; self.trailing = trailing()
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).mgFont(.heading).foregroundStyle(Color.mgFg).accessibilityAddTraits(.isHeader)
            Spacer()
            trailing
        }
    }
}

extension SectionHeader where Trailing == EmptyView {
    init(_ title: LocalizedStringKey) { self.init(title) { EmptyView() } }
}

/// A flat surface group: bg-surface, rounded 8, no border.
struct Panel<Content: View>: View {
    var padding: CGFloat = 14
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content }
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.mgSurface))
    }
}

struct EmptyStateView: View {
    let title: LocalizedStringKey
    let message: LocalizedStringKey
    var systemImage: String = "tray"
    var actionTitle: LocalizedStringKey?
    var action: (() -> Void)?

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: systemImage).font(.system(size: 28, weight: .regular)).foregroundStyle(Color.mgMuted)
                .accessibilityHidden(true)
            Text(title).mgFont(.bodyStrong).foregroundStyle(Color.mgFg)
            Text(message).mgFont(.secondary).foregroundStyle(Color.mgMuted).multilineTextAlignment(.center)
            if let actionTitle, let action {
                Button(action: action) { Text(actionTitle) }
                    .buttonStyle(MGButtonStyle(kind: .primary))
                    .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 32).padding(.horizontal, 24)
    }
}

/// An error in plain words with a retry.
struct ErrorStateView: View {
    let message: String
    var retry: (() async -> Void)?
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "exclamationmark.circle").font(.system(size: 26)).foregroundStyle(Color.mgDanger).accessibilityHidden(true)
            Text(message).mgFont(.secondary).foregroundStyle(Color.mgFg).multilineTextAlignment(.center)
            if let retry {
                Button { Task { await retry() } } label: { Text("Try again") }
                    .buttonStyle(MGButtonStyle(kind: .secondary))
            }
        }
        .frame(maxWidth: .infinity)
        .padding(24)
    }
}

/// A slim notice above content: offline, cached, or something failed.
struct NoticeBar: View {
    let text: String
    var tone: Tone = .muted
    enum Tone { case muted, warn, danger }

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: tone == .muted ? "wifi.slash" : tone == .warn ? "clock" : "exclamationmark.triangle")
                .font(.system(size: 12, weight: .semibold)).accessibilityHidden(true)
            Text(text).mgFont(.secondary)
            Spacer(minLength: 0)
        }
        .foregroundStyle(tone == .danger ? Color.mgDanger : tone == .warn ? Color.mgWarn : Color.mgMuted)
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 6).fill(tone == .danger ? Color.mgDangerTint : tone == .warn ? Color.mgWarnTint : Color.mgSurface2))
    }
}

struct BannerView: View {
    let text: String
    let dismiss: () -> Void
    var body: some View {
        HStack {
            Text(text).mgFont(.secondary).foregroundStyle(Color.mgFg)
            Spacer()
            Button(action: dismiss) { Image(systemName: "xmark").font(.system(size: 12, weight: .semibold)) }
                .accessibilityLabel(Text("Close"))
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.mgSurface).shadow(color: .black.opacity(0.15), radius: 16, y: 8))
    }
}

struct MGButtonStyle: ButtonStyle {
    enum Kind { case primary, secondary, ghost, danger, accent }
    var kind: Kind = .primary
    var compact = false
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .mgFont(compact ? .secondaryStrong : .bodyStrong)
            .lineLimit(1)
            .padding(.horizontal, compact ? 12 : 16)
            .padding(.vertical, compact ? 7 : 11)
            .foregroundStyle(fg)
            .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(bg))
            .opacity(enabled ? (configuration.isPressed ? 0.8 : 1) : 0.45)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
    }

    private var fg: Color {
        switch kind {
        case .primary: return .mgBg
        case .secondary, .ghost: return .mgFg
        case .danger: return .mgDanger
        case .accent: return .mgAccentFg
        }
    }

    private var bg: Color {
        switch kind {
        case .primary: return .mgFg
        case .secondary: return .mgSurface2
        case .ghost: return .clear
        case .danger: return .mgDangerTint
        case .accent: return .mgAccent
        }
    }
}

/// Load state for a screen: what to show, with cached data kept while refreshing.
enum Loadable<T> {
    case idle, loading, loaded(T), failed(String)

    var value: T? { if case .loaded(let v) = self { return v }; return nil }
}

/// A badge for state: amber needs a decision, plum inferred, brick error.
struct StateBadge: View {
    let text: String
    var tone: Tone = .warn
    enum Tone { case warn, inferred, danger, muted, accent }
    var body: some View {
        Text(text).mgFont(.meta)
            .foregroundStyle(fg)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(Capsule().fill(bg))
    }
    private var fg: Color {
        switch tone { case .warn: .mgWarn; case .inferred: .mgInferred; case .danger: .mgDanger; case .muted: .mgMuted; case .accent: .mgAccent }
    }
    private var bg: Color {
        switch tone { case .warn: .mgWarnTint; case .inferred: .mgInferredTint; case .danger: .mgDangerTint; case .muted: .mgSurface2; case .accent: .mgAccentTint }
    }
}
