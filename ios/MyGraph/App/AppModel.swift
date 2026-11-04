import Foundation
import Observation
import SwiftUI
import WidgetKit

/// Who is signed in, which graph they're working in, and the app-wide state that follows from it.
@MainActor
@Observable
final class AppModel {
    enum Phase: Equatable { case launching, signedOut, pending, signedIn }

    var phase: Phase = .launching
    var signOutReason: String?
    var graphs: [GraphSummary] = []
    var currentGraphId: String?
    /// The viewer's name and person node, from `/api/auth/me` (cached for offline starts).
    var myName: String?
    var myPersonId: String?
    /// Changes whenever the graph changes, so screens reload.
    var graphToken = UUID()
    var isOffline = false
    var banner: String?
    /// Who is signed in, from `/api/auth/me`.
    var me: Me?
    /// The account's language ("en" or "da"); screens use it through `\.locale`.
    var locale: String = AppLanguage.current
    /// The account's language differs from what the app's strings were loaded in: some text follows after a restart.
    var languageNeedsRestart = false
    /// Members of a graph who are viewers can't deliver or approve.
    var canWrite: Bool { (me?.graph?.role ?? currentGraph?.myRole) != "viewer" }

    var currentGraph: GraphSummary? { graphs.first { $0.id == currentGraphId } ?? graphs.first }
    var firstName: String? { myName?.split(separator: " ").first.map(String.init) }

    private var observers: [NSObjectProtocol] = []

    init() {
        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: .mgSignedOut, object: nil, queue: .main) { [weak self] note in
            let msg = note.object as? String
            Task { @MainActor in self?.handleSignedOut(message: msg) }
        })
        observers.append(nc.addObserver(forName: .mgPendingApproval, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in if self?.phase == .signedIn { self?.phase = .pending } }
        })
        if let cached = DiskCache.load(GraphsResponse.self, key: "graphs")?.value {
            graphs = cached.graphs; currentGraphId = cached.currentGraphId
        }
        myName = AppGroup.defaults.string(forKey: "myName")
        myPersonId = AppGroup.defaults.string(forKey: "myPersonId")
    }

    /// On launch: put the saved session back and ask the server what state it is in.
    func bootstrap() async {
        if let s = DebugHooks.server, s != ServerConfig.current { ServerConfig.current = s }
        CookieVault.restore()
        if DebugHooks.signOut, CookieVault.hasSession { clearLocal() }
        guard CookieVault.hasSession else {
            if let (e, p) = DebugHooks.login {
                do { try await signIn(email: e, password: p) } catch { print("[debug] sign-in failed: \(error.plainMessage)") }
                if phase == .signedIn || phase == .pending { return }
            }
            phase = .signedOut; return
        }
        // A saved session opens straight into what's cached; the server check runs alongside.
        phase = .signedIn
        do {
            let s: SessionStatus = try await API.shared.get("/api/auth/status")
            #if DEBUG
            print("[debug] session status: \(s.status)")
            #endif
            switch s.status {
            case "active": isOffline = false; await loadGraphs(); await loadMe()
            case "pending": phase = .pending
            default: clearLocal(); phase = .signedOut
            }
        } catch {
            if error.isOffline { isOffline = true }
        }
    }

    func signIn(email: String, password: String) async throws {
        let req = API.shared.request("POST", "/api/auth/login", json: ["email": email, "password": password])
        let (data, _) = try await API.shared.send(req, quietAuth: true)
        try finishSignIn(data)
    }

    func finishSignIn(_ data: Data) throws {
        struct Answer: Decodable { let ok: Bool?; let pending: Bool? }
        let a = try API.shared.decode(Answer.self, from: data)
        CookieVault.persist()
        signOutReason = nil
        if a.pending == true { phase = .pending; return }
        phase = .signedIn
        graphToken = UUID()
        Task { await loadGraphs(); await loadMe() }
    }

    /// Polls while a parent approves this device.
    func checkPending() async -> Bool {
        guard let s: SessionStatus = try? await API.shared.get("/api/auth/status") else { return false }
        if s.status == "active" { phase = .signedIn; graphToken = UUID(); await loadGraphs(); await loadMe(); return true }
        if s.status == "none" { phase = .signedOut }
        return false
    }

    func signOut() async {
        _ = try? await API.shared.send(API.shared.request("POST", "/api/auth/logout"), quietAuth: true)
        clearLocal()
        signOutReason = String(localized: "You're signed out.")
        phase = .signedOut
    }

    private func handleSignedOut(message: String?) {
        guard phase == .signedIn || phase == .pending else { return }
        clearLocal()
        signOutReason = message ?? String(localized: "Please sign in again.")
        phase = .signedOut
    }

    private func clearLocal() {
        CookieVault.clearSession()
        DiskCache.clear()
        NextUp.clear()
        graphs = []; currentGraphId = nil; myName = nil; myPersonId = nil; me = nil
        AppLanguage.forget(); languageNeedsRestart = false
        AppGroup.defaults.removeObject(forKey: "myName")
        AppGroup.defaults.removeObject(forKey: "myPersonId")
        ReminderNotifications.removeAll()
        WidgetCenter.shared.reloadAllTimelines()
    }

    func loadGraphs() async {
        do {
            let r: GraphsResponse = try await API.shared.get("/api/graphs")
            graphs = r.graphs.filter { $0.archivedAt == nil }
            currentGraphId = r.currentGraphId
            isOffline = false
            DiskCache.save(r, as: "graphs")
        } catch {
            if error.isOffline { isOffline = true }
        }
    }

    func switchGraph(to g: GraphSummary) async {
        guard g.id != currentGraphId else { return }
        do {
            try await API.shared.post("/api/graphs/switch", json: ["graphId": g.id])
            currentGraphId = g.id
            Haptics.success()
            graphToken = UUID()
            await loadGraphs()
            await loadMe()
            WidgetCenter.shared.reloadAllTimelines()
        } catch {
            banner = error.plainMessage
        }
    }

    /// Who is signed in, their language and the graph they're in, in one request.
    func loadMe() async {
        do {
            let r: MeResponse = try await API.shared.get("/api/auth/me")
            apply(me: r.me)
        } catch {
            #if DEBUG
            print("[debug] /api/auth/me failed: \(error.plainMessage)")
            #endif
        }
    }

    func apply(me m: Me) {
        me = m
        rememberMe(name: m.name, personId: m.personNodeId)
        if let g = m.graph { currentGraphId = currentGraphId ?? g.id }
        // A launch argument (-AppleLanguages) picks the language for screenshots; then the iPhone's choice stays.
        let pinned = ProcessInfo.processInfo.arguments.contains("-AppleLanguages")
        if !pinned, let l = m.locale, AppLanguage.supported.contains(l), l != locale || AppLanguage.server != l {
            languageNeedsRestart = AppLanguage.adopt(l)
            locale = l
        }
    }

    /// Saves the language on the account (PATCH /api/settings), so the web and this iPhone agree.
    func setLanguage(_ l: String) async {
        do {
            _ = try await API.shared.send(API.shared.request("PATCH", "/api/settings", json: ["locale": l]))
            languageNeedsRestart = AppLanguage.adopt(l)
            locale = l
            graphToken = UUID()
        } catch {
            banner = error.plainMessage
        }
    }

    func rememberMe(name: String?, personId: String?) {
        if let name { myName = name; AppGroup.defaults.set(name, forKey: "myName") }
        if let personId { myPersonId = personId; AppGroup.defaults.set(personId, forKey: "myPersonId") }
    }
}
