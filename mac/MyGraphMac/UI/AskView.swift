import SwiftUI

/// "Ask My Graph": the same always-active conversation as the web's Ask panel and the iPhone's Ask tab
/// (`/api/chat/active`, `POST /api/chat` as server-sent events), in a floating panel.
struct AskView: View {
    @Environment(AppModel.self) private var app
    var initial: String?
    @State private var model = ChatModel(conversationId: nil)
    @State private var question = ""
    @State private var opened = false
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "sparkle.magnifyingglass").foregroundStyle(Color.mgAccent).font(.system(size: 18))
                TextField(L("Ask about your people, plans and documents"), text: $question, axis: .vertical)
                    .textFieldStyle(.plain).font(.system(size: 17)).lineLimit(1...4)
                    .focused($focused)
                    .onSubmit(send)
                if model.streaming {
                    Button { model.stop() } label: { Image(systemName: "stop.circle.fill").font(.system(size: 18)) }
                        .buttonStyle(.plain).foregroundStyle(.secondary).help(L("Stop"))
                }
            }
            .padding(.horizontal, 18).padding(.top, 22).padding(.bottom, 14)
            Divider()
            if !app.hasSession {
                VStack(spacing: 8) {
                    Text(L("Sign in to ask.")).font(.headline)
                    Text(L("Your session on this Mac has ended. Syncing goes on in the background.")).foregroundStyle(.secondary)
                    Button(L("Sign in…")) { Panels.shared.showSettings(tab: .account) }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                conversation
            }
            footer
        }
        .background(.regularMaterial)
        .task { await open() }
        .onReceive(NotificationCenter.default.publisher(for: .mgAsk)) { n in
            if let q = n.object as? String { question = q; send() }
        }
    }

    private var conversation: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if model.messages.isEmpty && !model.streaming {
                        Text(L("Ask anything about your graph. Answers cite where each fact came from."))
                            .foregroundStyle(.secondary).padding(.top, 30).frame(maxWidth: .infinity)
                    }
                    ForEach(model.messages.suffix(12)) { m in MessageBubble(message: m).id(m.id) }
                    if model.streaming {
                        VStack(alignment: .leading, spacing: 6) {
                            if let step = model.liveSteps.last { Text(step.label).font(.caption).foregroundStyle(.secondary) }
                            if model.liveText.isEmpty { ProgressView().controlSize(.small) }
                            else { Text(markdown(model.liveText)).textSelection(.enabled) }
                        }
                        .id("live")
                    }
                    if let e = model.sendError { Text(e).foregroundStyle(Color.mgDanger).font(.callout) }
                }
                .padding(18)
            }
            .onChange(of: model.liveText) { _, _ in proxy.scrollTo("live", anchor: .bottom) }
            .onChange(of: model.messages.count) { _, _ in if let id = model.messages.last?.id { proxy.scrollTo(id, anchor: .bottom) } }
        }
    }

    private var footer: some View {
        HStack(spacing: 12) {
            if model.sensitivityBadge != nil {
                Label(model.sensitivityBadge ?? "", systemImage: "lock").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Button(L("New conversation")) { Task { await newConversation() } }.buttonStyle(.link)
            if let id = model.conversationId {
                Button(L("Open in My Graph")) { Web.open("/chat/\(id)") }.buttonStyle(.link)
            }
        }
        .font(.callout)
        .padding(.horizontal, 18).padding(.vertical, 10)
    }

    private func markdown(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }

    private func open() async {
        focused = true
        guard !opened, app.hasSession else { return }
        opened = true
        struct Light: Decodable { let conversationId: String? }
        let active: Light? = try? await API.shared.get("/api/chat/active", query: ["light": "1"])
        model = ChatModel(conversationId: active?.conversationId)
        await model.load()
        if let q = initial { question = q; send() }
    }

    private func send() {
        let q = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty, !model.streaming else { return }
        question = ""
        model.send(q)
    }

    private func newConversation() async {
        _ = try? await API.shared.send(API.shared.request("PUT", "/api/chat/active", json: ["conversationId": NSNull()]))
        model = ChatModel(conversationId: nil)
        focused = true
    }
}

struct MessageBubble: View {
    let message: ChatMessage

    var body: some View {
        let mine = message.role == "user"
        VStack(alignment: .leading, spacing: 6) {
            Text(md(message.content))
                .textSelection(.enabled)
                .padding(mine ? 10 : 0)
                .background(RoundedRectangle(cornerRadius: 8).fill(mine ? Color.primary.opacity(0.06) : .clear))
            if let c = message.citations, !c.isEmpty {
                Text(L("\(c.count) sources")).font(.caption).foregroundStyle(Color.mgAccent)
            }
            if let p = message.proposals?.filter({ $0.status == "pending" || $0.status == "proposed" }), !p.isEmpty {
                Label(L("\(p.count) suggestions waiting for your approval"), systemImage: "tray").font(.caption).foregroundStyle(Color.mgWarn)
            }
        }
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
    }

    private func md(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }
}

/// "Quick note": a note saved to the library of the current graph (`POST /api/library/paste`), private by default.
struct QuickNoteView: View {
    @Environment(AppModel.self) private var app
    var initial: String?
    var close: () -> Void
    @State private var text = ""
    @State private var visibility = "private"
    @State private var sending = false
    @State private var result: String?
    @State private var failed = false
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Image(systemName: "square.and.pencil").foregroundStyle(Color.mgAccent)
                Text(L("Note to \(app.currentGraph?.name ?? L("My Graph"))")).font(.headline)
            }
            .padding(.top, 10)
            TextEditor(text: $text)
                .font(.system(size: 14))
                .scrollContentBackground(.hidden)
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .textBackgroundColor)))
                .focused($focused)
            HStack {
                Picker(L("Who can see it"), selection: $visibility) {
                    Text(L("Only me")).tag("private")
                    if app.currentGraph?.isFamily == true || app.currentGraph?.kind == "family" { Text(L("Parents")).tag("parents") }
                    Text(L("Everyone in the graph")).tag("household")
                }
                .frame(maxWidth: 260)
                Spacer()
                if let result { Text(result).font(.callout).foregroundStyle(failed ? Color.mgDanger : .secondary) }
                if sending { ProgressView().controlSize(.small) }
                Button(L("Save note"), action: send).keyboardShortcut(.return, modifiers: .command)
                    .disabled(sending || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !app.hasSession)
            }
            Text(L("Saved to the library. Anything My Graph finds in it is proposed for you to approve.")).font(.caption).foregroundStyle(.secondary)
        }
        .padding(16)
        .background(.regularMaterial)
        .onAppear { if let initial { text = initial }; focused = true }
    }

    private func send() {
        sending = true; result = nil; failed = false
        let items = SendKit.plan(files: [], urls: [], texts: [text])
        Task {
            let s = await SendKit.send(items, visibility: visibility) { _, _ in }
            sending = false
            if s.allFailed { failed = true; result = s.errors.first }
            else {
                result = L("Saved")
                text = ""
                try? await Task.sleep(for: .seconds(0.8))
                close()
                result = nil
            }
        }
    }
}
