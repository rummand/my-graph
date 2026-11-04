import SwiftUI
import Observation

/// The question being typed, with @mentions. Shown as "@Emma"; sent as `@[Emma](node:<uuid>)`.
@MainActor
@Observable
final class ComposerModel {
    var text = "" { didSet { textChanged() } }
    var mentions: [MentionItem] = []
    var suggestions: [MentionItem] = []
    private var searchTask: Task<Void, Never>?

    /// The text after an "@" at the end of what's typed (at the start or after a space), if any.
    var mentionQuery: String? {
        guard let at = text.lastIndex(of: "@") else { return nil }
        if at != text.startIndex {
            let before = text[text.index(before: at)]
            if !before.isWhitespace { return nil }
        }
        let q = String(text[text.index(after: at)...])
        if q.contains("\n") || q.count > 40 { return nil }
        if mentions.contains(where: { q.hasPrefix($0.label) && q.count > $0.label.count }) { return nil }
        return q
    }

    private func textChanged() {
        searchTask?.cancel()
        guard let q = mentionQuery else { suggestions = []; return }
        searchTask = Task {
            try? await Task.sleep(for: .milliseconds(150))
            guard !Task.isCancelled else { return }
            let r: MentionsResponse? = try? await API.shared.get("/api/mentions", query: ["q": q, "limit": "6"])
            if let items = r?.items, !Task.isCancelled { suggestions = items }
            else if r == nil, !Task.isCancelled {
                // Older servers without /api/mentions: fall back to node search.
                struct Nodes: Decodable { let nodes: [GraphNode]? }
                let n: Nodes? = try? await API.shared.get("/api/nodes", query: ["q": q, "limit": "6"])
                suggestions = (n?.nodes ?? []).map { MentionItem(nodeId: $0.id, label: $0.label, type: $0.type, typeLabel: nil, kindLabel: nil, summary: $0.summary, isYou: nil) }
            }
        }
    }

    func pick(_ m: MentionItem) {
        guard let at = text.lastIndex(of: "@") else { return }
        text = String(text[..<at]) + "@" + m.label + " "
        if !mentions.contains(m) { mentions.append(m) }
        suggestions = []
    }

    /// The text with mentions in the server's markup.
    func markup() -> String {
        var out = text
        for m in mentions.sorted(by: { $0.label.count > $1.label.count }) {
            let token = "@" + m.label
            if let r = out.range(of: token) { out.replaceSubrange(r, with: "@[\(m.label)](node:\(m.nodeId))") }
        }
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func clear() { text = ""; mentions = []; suggestions = [] }
}

struct ComposerView: View {
    @Bindable var model: ComposerModel
    let streaming: Bool
    let send: (String) -> Void
    let stop: () -> Void
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            if !model.suggestions.isEmpty {
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(model.suggestions) { m in
                            Button { model.pick(m) } label: {
                                HStack(spacing: 10) {
                                    if m.type == "person" { Avatar(name: m.label, id: m.nodeId, size: 26) }
                                    else { Circle().fill(Color.nodeType(m.type)).frame(width: 8, height: 8).frame(width: 26) }
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(m.label).mgFont(.body).foregroundStyle(Color.mgFg).lineLimit(1)
                                        Text(m.kindLabel ?? m.typeLabel ?? m.type.capitalized).mgFont(.meta).foregroundStyle(Color.mgMuted)
                                    }
                                    Spacer()
                                }
                                .padding(.horizontal, 12).padding(.vertical, 8)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(Text("Mention \(m.label)"))
                        }
                    }
                }
                .frame(maxHeight: 220)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.mgSurface).shadow(color: .black.opacity(0.12), radius: 16, y: 6))
                .padding(.horizontal, 12).padding(.bottom, 6)
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Ask about anything…", text: $model.text, axis: .vertical)
                    .lineLimit(1...6)
                    .mgFont(.body)
                    .focused($focused)
                    .padding(.horizontal, 12).padding(.vertical, 10)
                    .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Color.mgSurface))
                    .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(Color.mgLine))
                    .accessibilityLabel(Text("Question"))
                    .accessibilityHint(Text("Type @ to mention a person, place or event"))
                if streaming {
                    Button(action: stop) {
                        Image(systemName: "stop.fill").font(.system(size: 14, weight: .bold))
                            .foregroundStyle(Color.mgBg).frame(width: 40, height: 40).background(Circle().fill(Color.mgFg))
                    }
                    .accessibilityLabel(Text("Stop"))
                } else {
                    Button {
                        let t = model.markup()
                        guard !t.isEmpty else { return }
                        send(t)
                        model.clear()
                    } label: {
                        Image(systemName: "arrow.up").font(.system(size: 16, weight: .bold))
                            .foregroundStyle(Color.mgBg).frame(width: 40, height: 40)
                            .background(Circle().fill(model.text.trimmingCharacters(in: .whitespaces).isEmpty ? Color.mgMuted.opacity(0.5) : Color.mgFg))
                    }
                    .disabled(model.text.trimmingCharacters(in: .whitespaces).isEmpty)
                    .accessibilityLabel(Text("Send"))
                }
            }
            .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 8)
        }
        .background(Color.mgBg.opacity(0.96))
        .animation(.easeOut(duration: 0.15), value: model.suggestions)
    }
}
