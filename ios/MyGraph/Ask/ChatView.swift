import SwiftUI

struct ChatView: View {
    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
    @State private var model: ChatModel
    @State private var composer = ComposerModel()
    private let skipText = "Skip that. Continue with what you know."

    private var autoAsk: String?

    init(conversationId: String?, mention: MentionItem? = nil, autoAsk: String? = nil) {
        self.autoAsk = autoAsk
        _model = State(initialValue: ChatModel(conversationId: conversationId))
        let c = ComposerModel()
        if let mention { c.text = "@"; c.pick(mention) }
        _composer = State(initialValue: c)
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    if let badge = model.sensitivityBadge {
                        NoticeBar(text: badge, tone: .warn).accessibilityLabel(Text(badge))
                    }
                    if model.messages.isEmpty && !model.loading && !model.streaming {
                        starter
                    }
                    if let e = model.loadError { ErrorStateView(message: e) { await model.load() } }
                    ForEach(model.messages) { m in
                        MessageView(message: m, isLast: m.id == model.messages.last?.id && !model.streaming, model: model) { choice in
                            model.send(choice)
                        } skip: { model.send(skipText) }
                        .id(m.id)
                    }
                    if model.streaming { live.id("live") }
                    if let e = model.sendError {
                        Text(e).mgFont(.secondary).foregroundStyle(Color.mgDanger).id("error")
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            .onChange(of: model.messages.count) { _, _ in withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) } }
            .onChange(of: model.liveText) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
        }
        .safeAreaInset(edge: .bottom) {
            ComposerView(model: composer, streaming: model.streaming) { text in
                model.send(text)
            } stop: { model.stop() }
        }
        .background(Color.mgBg)
        .navigationTitle(Text(model.title ?? String(localized: "New chat")))
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if model.messages.isEmpty { await model.load() }
            if let q = autoAsk, model.messages.isEmpty { model.send(q) }
        }
    }

    private var starter: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Ask anything about your graph").mgFont(.heading)
            Text("Type @ to point at a person, place or event. Every answer shows where it came from.")
                .mgFont(.secondary).foregroundStyle(Color.mgMuted)
            ForEach([String(localized: "What's happening this week?"), String(localized: "When is the next school trip?"), String(localized: "What do we need to remember for the weekend?")], id: \.self) { q in
                Button { model.send(q) } label: {
                    Text(q).mgFont(.body).foregroundStyle(Color.mgFg)
                        .padding(.horizontal, 12).padding(.vertical, 9)
                        .background(RoundedRectangle(cornerRadius: 8).fill(Color.mgSurface))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.top, 12)
    }

    /// The answer being written: live steps with a running clock, then the text as it streams.
    private var live: some View {
        VStack(alignment: .leading, spacing: 10) {
            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                let secs = Int(ctx.date.timeIntervalSince(model.startedAt ?? ctx.date))
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text(model.liveText.isEmpty ? String(localized: "Working… \(secs)s") : String(localized: "Writing… \(secs)s"))
                            .mgFont(.secondaryStrong).foregroundStyle(Color.mgMuted).monospacedDigit()
                    }
                    ForEach(Array(model.liveSteps.enumerated()), id: \.offset) { _, s in
                        StepLine(step: s)
                    }
                }
            }
            .accessibilityElement(children: .combine)
            if !model.liveText.isEmpty {
                RichTextView(text: model.liveText, citations: model.liveSources)
            }
        }
    }
}

struct StepLine: View {
    let step: AssistantStep
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: icon).font(.system(size: 11)).foregroundStyle(Color.mgMuted).frame(width: 14).accessibilityHidden(true)
            Text(step.label).mgFont(.secondary).foregroundStyle(Color.mgMuted)
        }
    }
    private var icon: String {
        switch step.kind {
        case "search": return "magnifyingglass"
        case "read": return "doc.text"
        case "timeline": return "calendar"
        case "people": return "person"
        case "memory": return "brain"
        case "write": return "pencil"
        default: return "checkmark"
        }
    }
}

struct MessageView: View {
    let message: ChatMessage
    let isLast: Bool
    let model: ChatModel
    let choose: (String) -> Void
    let skip: () -> Void
    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
    @State private var showSteps = false

    var body: some View {
        if message.role == "user" {
            HStack {
                Spacer(minLength: 48)
                Text(RichText.attributed(message.content))
                    .mgFont(.body).foregroundStyle(Color.mgFg)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.mgSurface2))
                    .textSelection(.enabled)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(Text("You: \(RichText.mentionsToPlain(message.content))"))
        } else {
            VStack(alignment: .leading, spacing: 10) {
                if let steps = message.steps, !steps.isEmpty {
                    Button { withAnimation(.easeOut(duration: 0.2)) { showSteps.toggle() } } label: {
                        HStack(spacing: 4) {
                            Text(workedFor(steps)).mgFont(.secondary).foregroundStyle(Color.mgMuted)
                            Image(systemName: showSteps ? "chevron.up" : "chevron.down").font(.system(size: 10, weight: .semibold)).foregroundStyle(Color.mgMuted)
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint(Text(showSteps ? "Hide the steps" : "Show the steps"))
                    if showSteps {
                        VStack(alignment: .leading, spacing: 4) { ForEach(Array(steps.enumerated()), id: \.offset) { _, s in StepLine(step: s) } }
                    }
                }
                RichTextView(text: message.content, citations: message.citations ?? [])
                CitationRow(citations: message.citations ?? [])
                ForEach(message.proposals ?? []) { p in
                    ProposalCard(proposal: p, busy: model.deciding.contains("\(message.id)#\(p.n)")) { action in
                        Task {
                            if let e = await model.decide(message: message, proposal: p, action: action) { app.banner = e; Haptics.warning() }
                            else if action == "approve" || action == "always" { Haptics.success() }
                        }
                    } open: { href in if let r = Route.fromWebHref(href) { router.push(r) } }
                }
                if let c = message.clarify, isLast {
                    ClarifyPicker(clarify: c, choose: choose, skip: skip)
                }
            }
        }
    }

    private func workedFor(_ steps: [AssistantStep]) -> String {
        let secs = max(1, Int(((Double(message.thoughtMs ?? 0)) / 1000).rounded()))
        return steps.count == 1 ? String(localized: "Worked for \(secs)s, 1 step") : String(localized: "Worked for \(secs)s, \(steps.count) steps")
    }
}

/// An approval card for something the assistant proposes. Nothing is written until a person says yes.
struct ProposalCard: View {
    let proposal: Proposal
    let busy: Bool
    let act: (String) -> Void
    let open: (String?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                StateBadge(text: kindLabel, tone: proposal.status == "pending" || proposal.status == "queued" ? .warn : .muted)
                if proposal.basis == "document" { Text("From a document").mgFont(.meta).foregroundStyle(Color.mgMuted) }
            }
            Text(headline).mgFont(.bodyStrong).foregroundStyle(Color.mgFg)
            if let d = detail { Text(d).mgFont(.secondary).foregroundStyle(Color.mgMuted) }
            if let cur = proposal.current, !cur.isEmpty {
                Text("Now: \(cur.joined(separator: "; "))").mgFont(.secondary).foregroundStyle(Color.mgMuted).strikethrough()
            }
            if let w = proposal.widens { Text(w).mgFont(.secondary).foregroundStyle(Color.mgWarn) }
            if let e = proposal.error { Text(e).mgFont(.secondary).foregroundStyle(Color.mgDanger) }
            switch proposal.status {
            case "pending", "queued":
                HStack(spacing: 8) {
                    Button("Approve") { act("approve") }.buttonStyle(MGButtonStyle(kind: .primary, compact: true))
                        .accessibilityIdentifier("proposal.approve")
                    Button("Always allow") { act("always") }.buttonStyle(MGButtonStyle(kind: .secondary, compact: true))
                        .accessibilityIdentifier("proposal.always")
                    Button("Deny") { act("deny") }.buttonStyle(MGButtonStyle(kind: .ghost, compact: true))
                        .accessibilityIdentifier("proposal.deny")
                    if busy { ProgressView() }
                }
                .disabled(busy)
            case "approved":
                HStack(spacing: 10) {
                    Label(proposal.result?.label ?? String(localized: "Done"), systemImage: "checkmark.circle.fill")
                        .mgFont(.secondaryStrong).foregroundStyle(Color.mgAccent)
                        .accessibilityIdentifier("proposal.approved")
                    if proposal.result?.href != nil {
                        Button("Open") { open(proposal.result?.href) }.buttonStyle(MGButtonStyle(kind: .ghost, compact: true))
                    }
                    Button("Undo") { act("undo") }.buttonStyle(MGButtonStyle(kind: .ghost, compact: true)).disabled(busy)
                }
            case "dismissed":
                Text("Not added").mgFont(.secondary).foregroundStyle(Color.mgMuted)
            case "undone":
                Text("Taken back").mgFont(.secondary).foregroundStyle(Color.mgMuted)
            default:
                EmptyView()
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.mgSurface))
        .overlay(alignment: .leading) {
            if proposal.status == "pending" || proposal.status == "queued" { Rectangle().fill(Color.mgWarn).frame(width: 3) }
        }
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
    }

    private var kindLabel: String {
        switch proposal.type {
        case "propose_reminder": return String(localized: "Add reminder")
        case "propose_fact": return String(localized: "Add fact")
        case "propose_wiki_note": return String(localized: "Add wiki note")
        case "propose_memory": return String(localized: "Remember this")
        default: return String(localized: "Suggestion")
        }
    }

    private var headline: String {
        switch proposal.type {
        case "propose_reminder": return proposal.title ?? ""
        case "propose_fact": return [proposal.from, proposal.relation.map(Fmt.relationWord), proposal.to].compactMap { $0 }.joined(separator: " ")
        case "propose_wiki_note": return proposal.title ?? ""
        case "propose_memory": return proposal.text ?? ""
        default: return proposal.title ?? proposal.text ?? ""
        }
    }

    private var detail: String? {
        switch proposal.type {
        case "propose_reminder":
            var parts: [String] = []
            if let d = proposal.dueAt, let date = ISODate.parse(d) { parts.append(String(localized: "Due \(Fmt.when(date))")) }
            if let a = proposal.aboutPerson { parts.append(String(localized: "About \(a)")) }
            return parts.isEmpty ? proposal.detail : parts.joined(separator: ". ")
        case "propose_fact": return proposal.quote.map { "“\($0)”" }
        case "propose_wiki_note": return proposal.text.map { String($0.prefix(160)) }
        case "propose_memory": return proposal.quote.map { "“\($0)”" }
        default: return nil
        }
    }
}

/// "Which Emma do you mean?" Choices as chips, plus Skip. A free-text answer goes through the composer.
struct ClarifyPicker: View {
    let clarify: Clarify
    let choose: (String) -> Void
    let skip: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(clarify.question).mgFont(.bodyStrong)
            FlowLayout(spacing: 8) {
                ForEach(clarify.choices, id: \.self) { c in
                    Button(c) { choose(c) }
                        .buttonStyle(MGButtonStyle(kind: .secondary, compact: true))
                }
                Button("Skip") { skip() }.buttonStyle(MGButtonStyle(kind: .ghost, compact: true))
            }
            Text("Or type your own answer below.").mgFont(.meta).foregroundStyle(Color.mgMuted)
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.mgAccentTint))
    }
}

/// Wraps children onto new lines.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxW = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0, widest: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > 0 && x + s.width > maxW { y += rowH + spacing; x = 0; rowH = 0 }
            x += s.width + spacing; rowH = max(rowH, s.height); widest = max(widest, x - spacing)
        }
        return CGSize(width: min(widest, maxW), height: y + rowH)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowH: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > bounds.minX && x + s.width > bounds.maxX { y += rowH + spacing; x = bounds.minX; rowH = 0 }
            v.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(s))
            x += s.width + spacing; rowH = max(rowH, s.height)
        }
    }
}
