import Foundation
import Observation

/// One conversation: its messages, and the answer being streamed over SSE
/// (start, step, sources, sensitivity, delta, done, error).
@MainActor
@Observable
final class ChatModel {
    var conversationId: String?
    var title: String?
    var messages: [ChatMessage] = []
    var loading = false
    var loadError: String?

    // The answer in progress.
    var streaming = false
    var liveText = ""
    var liveSteps: [AssistantStep] = []
    var liveSources: [Citation] = []
    var startedAt: Date?
    var sensitivityBadge: String?
    var sendError: String?
    var deciding: Set<String> = []

    private var task: Task<Void, Never>?

    init(conversationId: String?) { self.conversationId = conversationId }

    func load() async {
        guard let id = conversationId else { return }
        loading = true; defer { loading = false }
        do {
            let r: ConversationResponse = try await API.shared.get("/api/chat/\(id)")
            messages = r.conversation.messages
            title = r.conversation.title
            loadError = nil
            if r.conversation.sensitivity == "parents" { sensitivityBadge = String(localized: "Includes parents-only items") }
            if r.conversation.sensitivity == "private" { sensitivityBadge = String(localized: "Includes private items") }
            if messages.last?.role == "assistant" {
                _ = try? await API.shared.send(API.shared.request("PATCH", "/api/chat/\(id)", json: ["unread": false]))
            }
        } catch {
            loadError = error.plainMessage
        }
    }

    func send(_ question: String) {
        let q = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty, !streaming else { return }
        sendError = nil
        let local = ChatMessage(id: "local-\(UUID().uuidString)", role: "user", content: q, createdAt: Date())
        messages.append(local)
        streaming = true; liveText = ""; liveSteps = []; liveSources = []; startedAt = Date()
        var body: [String: Any] = ["question": q]
        if let id = conversationId { body["conversationId"] = id }
        task = Task { await run(body) }
    }

    private func run(_ body: [String: Any]) async {
        defer { streaming = false; startedAt = nil }
        do {
            for try await e in API.shared.events("/api/chat", json: body) {
                handle(e)
            }
        } catch is CancellationError {
            finishStopped()
        } catch {
            sendError = error.plainMessage
            if !liveText.isEmpty { finishStopped() }
        }
    }

    private func handle(_ e: SSEEvent) {
        let data = Data(e.data.utf8)
        switch e.event {
        case "start":
            if let s = try? API.decoder.decode(StartEvent.self, from: data) {
                conversationId = s.conversationId
                if let t = s.title { title = t }
            }
        case "step":
            struct S: Decodable { let step: AssistantStep }
            if let s = try? API.decoder.decode(S.self, from: data) { liveSteps.append(s.step) }
        case "sources":
            struct S: Decodable { let sources: [Citation] }
            if let s = try? API.decoder.decode(S.self, from: data) { liveSources = s.sources }
        case "sensitivity":
            struct S: Decodable { let badge: String? }
            if let s = try? API.decoder.decode(S.self, from: data) { sensitivityBadge = s.badge }
        case "delta":
            struct S: Decodable { let text: String }
            if let s = try? API.decoder.decode(S.self, from: data) { liveText += s.text }
        case "done":
            if let d = try? API.decoder.decode(DoneEvent.self, from: data) {
                if let t = d.title { title = t }
                messages.append(ChatMessage(id: d.messageId, role: "assistant", content: d.text ?? liveText, citations: d.citations,
                                            proposals: d.proposals, steps: d.steps ?? liveSteps, thoughtMs: d.thoughtMs, clarify: d.clarify, createdAt: Date()))
                if d.degraded != nil { sendError = String(localized: "The assistant couldn't be reached, so this answer only lists what was found.") }
                liveText = ""
            }
        case "error":
            struct S: Decodable { let message: String }
            sendError = (try? API.decoder.decode(S.self, from: data))?.message ?? String(localized: "Something went wrong while answering. Please try again.")
        default:
            break
        }
    }

    private func finishStopped() {
        guard !liveText.isEmpty else { return }
        let ms = startedAt.map { Int(Date().timeIntervalSince($0) * 1000) }
        messages.append(ChatMessage(id: "stopped-\(UUID().uuidString)", role: "assistant", content: liveText, citations: liveSources,
                                    proposals: [], steps: liveSteps, thoughtMs: ms, clarify: nil, createdAt: Date()))
        liveText = ""
        // Reload so the saved version (with its real id) replaces the local copy.
        Task { try? await Task.sleep(for: .milliseconds(600)); await load() }
    }

    func stop() {
        if let id = conversationId {
            Task { _ = try? await API.shared.send(API.shared.request("POST", "/api/chat/\(id)/stop")) }
        }
        task?.cancel()
    }

    /// approve | always | deny | undo
    func decide(message: ChatMessage, proposal: Proposal, action: String) async -> String? {
        guard let cid = conversationId else { return nil }
        let key = "\(message.id)#\(proposal.n)"
        deciding.insert(key); defer { deciding.remove(key) }
        struct Out: Decodable { let status: String?; let label: String?; let href: String? }
        do {
            let out: Out = try await API.shared.call("POST", "/api/chat/\(cid)/proposals/\(proposal.n)", json: ["messageId": message.id, "action": action])
            if let mi = messages.firstIndex(where: { $0.id == message.id }), let pi = messages[mi].proposals?.firstIndex(where: { $0.n == proposal.n }) {
                messages[mi].proposals?[pi].status = out.status ?? (action == "deny" ? "dismissed" : action == "undo" ? "undone" : "approved")
                messages[mi].proposals?[pi].result = out.label.map { ProposalResult(href: out.href, label: $0) }
            }
            return nil
        } catch {
            return error.plainMessage
        }
    }
}
