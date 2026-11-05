import Foundation

/// Launch arguments for driving the simulator (Debug builds only), e.g.
/// `xcrun simctl launch booted app.mygraph.ios -MGServer http://localhost:3917 -MGLogin anna@example.com:demo-demo-demo -MGTab people -MGRoute person:<id>`
enum DebugHooks {
    #if DEBUG
    private static func arg(_ name: String) -> String? {
        let a = ProcessInfo.processInfo.arguments
        guard let i = a.firstIndex(of: name), i + 1 < a.count else { return nil }
        return a[i + 1]
    }

    static var server: URL? { arg("-MGServer").flatMap(ServerConfig.parse) }
    static var login: (String, String)? {
        guard let s = arg("-MGLogin"), let i = s.firstIndex(of: ":") else { return nil }
        return (String(s[..<i]), String(s[s.index(after: i)...]))
    }
    static var tab: AppTab? {
        switch arg("-MGTab") {
        case "today": return .today
        case "ask": return .ask
        case "people": return .people
        case "timeline": return .timeline
        case "library": return .library
        default: return nil
        }
    }
    static var route: Route? {
        guard let s = arg("-MGRoute") else { return nil }
        let parts = s.split(separator: ":", maxSplits: 1).map(String.init)
        let id = parts.count > 1 ? parts[1] : nil
        switch parts[0] {
        case "person": return id.map { .person($0) }
        case "node": return id.map { .node($0) }
        case "source": return id.map { .source($0) }
        case "chat": return .chat(id == "new" ? nil : id, UUID())
        case "memory": return .memory
        case "changes": return id.map { .changeSet($0) } ?? .changes
        case "documents": return .documents
        case "phone": return .fromPhone
        case "history": return id.map { .history($0, "") }
        case "settings": return .settings
        case "widget": return .debugWidget
        case "chats": return .conversations
        default: return nil
        }
    }
    static var ask: String? { arg("-MGAsk") }
    static var graphs: Bool { ProcessInfo.processInfo.arguments.contains("-MGGraphs") }
    static var signOut: Bool { ProcessInfo.processInfo.arguments.contains("-MGSignOut") }
    /// "From this iPhone": turn a source on and send it right away (`contacts`, `health`, `places`).
    static var phoneSend: String? { arg("-MGPhoneSend") }
    #else
    static let server: URL? = nil
    static let login: (String, String)? = nil
    static let tab: AppTab? = nil
    static let route: Route? = nil
    static let ask: String? = nil
    static let graphs = false
    static let signOut = false
    static let phoneSend: String? = nil
    #endif
}
