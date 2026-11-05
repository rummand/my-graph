import Foundation
import Observation
import AppKit

/// Who is signed in on this Mac, which graph they're in, and the session the Ask panel and Quick note use.
/// Background sync doesn't depend on the session: it uses this Mac's own token (MacToken).
@MainActor
@Observable
final class AppModel {
    static let shared = AppModel()

    enum Phase: Equatable { case launching, signedOut, pending, signedIn }

    var phase: Phase = .launching
    var me: Me?
    var graphs: [GraphSummary] = []
    var currentGraphId: String?
    var banner: String?
    var signOutReason: String?
    var deviceProblem: String?

    var currentGraph: GraphSummary? { graphs.first { $0.id == currentGraphId } ?? graphs.first }

    private var observers: [NSObjectProtocol] = []

    init() {
        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: .mgSignedOut, object: nil, queue: .main) { [weak self] note in
            let msg = note.object as? String
            Task { @MainActor in self?.sessionEnded(msg) }
        })
        observers.append(nc.addObserver(forName: .mgPendingApproval, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in if self?.phase == .signedIn { self?.phase = .pending } }
        })
    }

    func bootstrap() async {
        #if DEBUG
        if let s = DebugArgs.value("-MGServer").flatMap(ServerConfig.parse) { ServerConfig.current = s }
        #endif
        CookieVault.restore()
        if CookieVault.hasSession {
            phase = .signedIn
            if let s: SessionStatus = try? await API.shared.get("/api/auth/status") {
                switch s.status {
                case "active": await afterSignIn(register: MacToken.load() == nil)
                case "pending": phase = .pending
                default: CookieVault.clearSession(); phase = MacToken.load() == nil ? .signedOut : .signedIn
                }
            }
        } else {
            #if DEBUG
            if let login = DebugArgs.value("-MGLogin"), let i = login.firstIndex(of: ":") {
                try? await signIn(email: String(login[..<i]), password: String(login[login.index(after: i)...]))
                if phase == .signedIn { return }
            }
            #endif
            // Signed out of the session but this Mac still has its token: syncing goes on; Ask needs a sign-in.
            phase = MacToken.load() == nil ? .signedOut : .signedIn
        }
        if phase == .signedIn { SyncEngine.shared.start() }
    }

    func signIn(email: String, password: String) async throws {
        let req = API.shared.request("POST", "/api/auth/login", json: ["email": email, "password": password])
        let (data, _) = try await API.shared.send(req, quietAuth: true)
        try await finishSignIn(data)
    }

    func signInWithPasskey() async throws {
        let data = try await PasskeySignIn().run()
        try await finishSignIn(data)
    }

    private func finishSignIn(_ data: Data) async throws {
        struct Answer: Decodable { let ok: Bool?; let pending: Bool? }
        let a = try API.shared.decode(Answer.self, from: data)
        CookieVault.persist()
        signOutReason = nil
        if a.pending == true { phase = .pending; return }
        phase = .signedIn
        await afterSignIn(register: true)
    }

    /// After a sign-in (or on launch): graphs, who I am, and this Mac's token for background sync.
    func afterSignIn(register: Bool) async {
        await loadGraphs()
        await loadMe()
        if register { await registerDevice() }
        SyncEngine.shared.start()
        await SyncEngine.shared.refreshSettings()
        Notifier.requestPermission()
        #if !DEBUG
        // Open at login by default (once); the person can turn it off under General.
        if !UserDefaults.standard.bool(forKey: "mg.loginItemOffered") {
            UserDefaults.standard.set(true, forKey: "mg.loginItemOffered")
            LoginItem.set(true)
        }
        #endif
    }

    func registerDevice() async {
        do {
            let a = try await MacAPI.shared.registerDevice(name: DeviceName.current)
            MacToken.save(a.token)
            deviceProblem = nil
            SyncEngine.shared.bind()
        } catch {
            deviceProblem = error.plainMessage
        }
    }

    func checkPending() async {
        guard let s: SessionStatus = try? await API.shared.get("/api/auth/status") else { return }
        if s.status == "active" { phase = .signedIn; await afterSignIn(register: true) }
        if s.status == "none" { phase = .signedOut }
    }

    func signOut() async {
        await MacAPI.shared.forgetDevice()
        _ = try? await API.shared.send(API.shared.request("POST", "/api/auth/logout"), quietAuth: true)
        CookieVault.clearSession()
        SyncEngine.shared.reset()
        me = nil; graphs = []; currentGraphId = nil
        signOutReason = L("You're signed out. Nothing is sent from this Mac until you sign in again.")
        phase = .signedOut
    }

    /// The session ended (401) but the Mac's token may still work: Ask needs a new sign-in, syncing goes on.
    private func sessionEnded(_ message: String?) {
        CookieVault.clearSession()
        signOutReason = message ?? L("Please sign in again.")
        if MacToken.load() == nil { phase = .signedOut }
        me = nil
    }

    var hasSession: Bool { CookieVault.hasSession }

    func loadGraphs() async {
        guard let r: GraphsResponse = try? await API.shared.get("/api/graphs") else { return }
        graphs = r.graphs.filter { $0.archivedAt == nil }
        currentGraphId = r.currentGraphId
    }

    func loadMe() async {
        guard let r: MeResponse = try? await API.shared.get("/api/auth/me") else { return }
        me = r.me
        currentGraphId = currentGraphId ?? r.me.graph?.id
        if !ProcessInfo.processInfo.arguments.contains("-AppleLanguages") { AppLanguage.adopt(r.me.locale) }
    }

    /// Switches the graph for Ask, notes and syncing. This Mac gets a token for the new graph; what it sends goes there.
    func switchGraph(to g: GraphSummary) async {
        guard g.id != currentGraphId else { return }
        do {
            try await API.shared.post("/api/graphs/switch", json: ["graphId": g.id])
            currentGraphId = g.id
            await loadMe()
            await registerDevice()
            await SyncEngine.shared.refreshSettings()
        } catch {
            banner = error.plainMessage
        }
    }
}

#if DEBUG
/// Debug launch arguments (never in Release): -MGServer <url>, -MGLogin email:password, -MGSnapshot <dir>, -MGOpen settings|ask|note.
enum DebugArgs {
    static func value(_ flag: String) -> String? {
        let a = ProcessInfo.processInfo.arguments
        guard let i = a.firstIndex(of: flag), i + 1 < a.count else { return nil }
        return a[i + 1]
    }
}
#endif
