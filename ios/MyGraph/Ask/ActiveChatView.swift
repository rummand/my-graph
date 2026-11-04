import SwiftUI

/// The server's always-active chat session (`/api/chat/active`), the same one the web's Ask panel opens.
/// Every question keeps its conversation active on the server; "New conversation" and reopening a saved chat set it.
enum ChatSessions {
    enum Source: Equatable { case server, latest }

    /// The active conversation (nil: a new conversation is open). Servers without `/api/chat/active` answer 404;
    /// then the latest conversation is the active one, as the web did before sessions.
    static func active() async throws -> (id: String?, source: Source) {
        struct Light: Decodable { let conversationId: String? }
        do {
            let r: Light = try await API.shared.get("/api/chat/active", query: ["light": "1"])
            return (r.conversationId, .server)
        } catch APIError.notFound(_) {
            let r: ConversationsResponse = try await API.shared.get("/api/chat")
            let latest = r.conversations.max { ($0.updatedAt ?? .distantPast) < ($1.updatedAt ?? .distantPast) }
            return (latest?.id, .latest)
        }
    }

    /// Makes a saved conversation the active one, or nil for a new conversation. Quiet on older servers.
    static func setActive(_ id: String?) async throws {
        do {
            _ = try await API.shared.send(API.shared.request("PUT", "/api/chat/active", json: ["conversationId": id ?? NSNull()]))
        } catch APIError.notFound(let m) where m == nil || id == nil {
            // An older server: nothing to keep. (A 404 with a message means the conversation is gone.)
        }
    }
}

/// The Ask tab: opens straight into the active session. "Chats" lists the saved sessions; "New conversation" starts one.
struct ActiveChatView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase
    @State private var model: ChatModel?
    @State private var failed: String?
    @State private var showChats = false
    @State private var source: ChatSessions.Source = .server

    var body: some View {
        Group {
            if let model {
                ChatView(model: model).id(ObjectIdentifier(model))
            } else if let failed {
                ErrorStateView(message: failed) { await open() }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityLabel(Text("Opening your conversation"))
            }
        }
        .background(Color.mgBg)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button { showChats = true } label: { Image(systemName: "list.bullet") }
                    .accessibilityLabel(Text("Chats"))
                    .accessibilityHint(Text("Your saved conversations"))
                    .accessibilityIdentifier("ask.chats")
                Button { Task { await startNew() } } label: { Image(systemName: "square.and.pencil") }
                    .accessibilityLabel(Text("New conversation"))
                    .accessibilityIdentifier("ask.new")
                    .disabled(model?.streaming == true || (model != nil && model?.conversationId == nil))
            }
        }
        .sheet(isPresented: $showChats) {
            NavigationStack {
                ConversationsView(onPick: { id in showChats = false; Task { await reopen(id) } },
                                  onNew: { showChats = false; Task { await startNew() } },
                                  activeId: model?.conversationId)
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { showChats = false } } }
            }
            .presentationDetents([.large])
        }
        .task { if model == nil { await open() } }
        .onChange(of: scenePhase) { _, p in if p == .active { Task { await follow() } } }
    }

    private func open() async {
        do {
            let a = try await ChatSessions.active()
            source = a.source
            #if DEBUG
            if a.source == .latest { print("[ask] /api/chat/active not on this server; opened the latest conversation") }
            #endif
            model = ChatModel(conversationId: a.id)
            failed = nil
        } catch {
            if error.isCancellation { return }
            // Offline: open a new conversation rather than nothing; sending says what's wrong.
            if model == nil { if error.isOffline { model = ChatModel(conversationId: nil) } else { failed = error.plainMessage } }
        }
    }

    /// Follows a switch made on another device (or the web), unless an answer is being written here.
    private func follow() async {
        guard let model, !model.streaming, source == .server else { return }
        guard let a = try? await ChatSessions.active(), a.id != model.conversationId else { return }
        if a.id == nil && model.messages.isEmpty { return }
        self.model = ChatModel(conversationId: a.id)
    }

    private func startNew() async {
        if model?.streaming == true { model?.stop() }
        model = ChatModel(conversationId: nil)
        do { try await ChatSessions.setActive(nil) } catch { app.banner = error.plainMessage }
    }

    private func reopen(_ id: String) async {
        guard id != model?.conversationId else { return }
        if model?.streaming == true { model?.stop() }
        model = ChatModel(conversationId: id)
        do { try await ChatSessions.setActive(id) } catch { app.banner = error.plainMessage }
    }
}
