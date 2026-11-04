import SwiftUI

struct ConversationsView: View {
    @Environment(Router.self) private var router
    @Environment(AppModel.self) private var app
    @State private var items: Loadable<[ConversationSummary]> = .idle
    @State private var query = ""
    @State private var searchTask: Task<Void, Never>?
    /// Set when the list is the Ask tab's "Chats" sheet: a tap reopens that session instead of pushing it.
    var onPick: ((String) -> Void)? = nil
    var onNew: (() -> Void)? = nil
    var activeId: String? = nil

    private func newChat() { if let onNew { onNew() } else { router.push(.newChat()) } }

    var body: some View {
        List {
            switch items {
            case .idle, .loading:
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            case .failed(let e):
                ErrorStateView(message: e) { await load() }.listRowBackground(Color.clear)
            case .loaded(let list):
                if list.isEmpty {
                    EmptyStateView(title: query.isEmpty ? "No chats yet" : "No chats match",
                                   message: query.isEmpty ? "Ask about anything in your graph: dates, people, letters. Every answer shows where it came from." : "Try other words, or start a new chat.",
                                   systemImage: "bubble.left.and.text.bubble.right",
                                   actionTitle: "New chat") { newChat() }
                        .listRowBackground(Color.clear)
                } else {
                    let pinned = list.filter { $0.pinned == true }
                    if !pinned.isEmpty {
                        Section("Pinned") { ForEach(pinned) { row($0) } }
                    }
                    Section(pinned.isEmpty ? "" : String(localized: "Recent")) {
                        ForEach(list.filter { $0.pinned != true }) { row($0) }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .automatic), prompt: Text("Search your chats"))
        .onChange(of: query) { _, _ in
            searchTask?.cancel()
            searchTask = Task { try? await Task.sleep(for: .milliseconds(300)); if !Task.isCancelled { await load() } }
        }
        .refreshable { await load() }
        .navigationTitle(onPick == nil ? Text("Ask") : Text("Chats"))
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            Button { newChat() } label: {
                HStack(spacing: 8) {
                    Image(systemName: "sparkle")
                    Text("Ask anything").frame(maxWidth: .infinity, alignment: .leading)
                }
                .mgFont(.body).foregroundStyle(Color.mgMuted)
                .padding(.horizontal, 14).padding(.vertical, 12)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.mgSurface))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.mgLine))
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 16).padding(.bottom, 8)
            .accessibilityLabel(Text("New chat"))
        }
        .task { if items.value == nil { await load() } }
    }

    private func row(_ c: ConversationSummary) -> some View {
        Button { if let onPick { onPick(c.id) } else { router.push(.chat(c.id, UUID())) } } label: {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        if c.unread == true { Circle().fill(Color.mgAccent).frame(width: 7, height: 7).accessibilityLabel(Text("Unread")) }
                        Text(c.title).mgFont(.bodyStrong).foregroundStyle(Color.mgFg).lineLimit(2)
                    }
                    if let s = c.snippet, !s.isEmpty {
                        Text(RichText.mentionsToPlain(s)).mgFont(.secondary).foregroundStyle(Color.mgMuted).lineLimit(2)
                    }
                    HStack(spacing: 6) {
                        if let d = c.updatedAt { Text(Fmt.relative(d)).mgFont(.meta).foregroundStyle(Color.mgMuted) }
                        if c.id == activeId { StateBadge(text: String(localized: "Open now"), tone: .accent) }
                        if c.sensitivity == "parents" { StateBadge(text: String(localized: "Parents only"), tone: .muted) }
                        if c.sensitivity == "private" { StateBadge(text: String(localized: "Private"), tone: .inferred) }
                    }
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(Color.mgSurface)
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) { Task { await delete(c) } } label: { Label("Delete", systemImage: "trash") }
        }
        .swipeActions(edge: .leading) {
            Button { Task { await pin(c) } } label: {
                Label(c.pinned == true ? "Unpin" : "Pin", systemImage: c.pinned == true ? "pin.slash" : "pin")
            }
            .tint(Color.mgAccent)
        }
    }

    private func load() async {
        if items.value == nil { items = .loading }
        do {
            let q = query.trimmingCharacters(in: .whitespaces)
            let r: ConversationsResponse = try await API.shared.get("/api/chat", query: ["q": q.isEmpty ? nil : q])
            items = .loaded(r.conversations)
        } catch {
            if error.isCancellation { return }
            if items.value == nil { items = .failed(error.plainMessage) } else { app.banner = error.plainMessage }
        }
    }

    private func delete(_ c: ConversationSummary) async {
        do {
            _ = try await API.shared.send(API.shared.request("DELETE", "/api/chat/\(c.id)"))
            if case .loaded(var l) = items { l.removeAll { $0.id == c.id }; items = .loaded(l) }
        } catch { app.banner = error.plainMessage }
    }

    private func pin(_ c: ConversationSummary) async {
        do {
            _ = try await API.shared.send(API.shared.request("PATCH", "/api/chat/\(c.id)", json: ["pinned": !(c.pinned ?? false)]))
            await load()
        } catch { app.banner = error.plainMessage }
    }
}
