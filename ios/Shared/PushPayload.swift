import Foundation

/// What a tapped notification asks the app to open. Remote pushes carry `mg: { kind, href, graphId?, id? }` (ids
/// and a path only, never text); local reminder notifications carry `reminderId` and `aboutNodeId`.
struct PushTarget: Equatable {
    /// The web path the server would open ("/people/<id>", "/changes/<id>", "/connections", "/clinical", "/").
    var href: String
    /// The graph it belongs to; the app switches there first when it's another one.
    var graphId: String?
    var kind: String

    /// Parses a notification's userInfo. Nil when it isn't one of ours.
    static func from(userInfo: [AnyHashable: Any]) -> PushTarget? {
        if let mg = userInfo["mg"] as? [String: Any], let href = mg["href"] as? String, href.hasPrefix("/"), !href.hasPrefix("//") {
            let graph = (mg["graphId"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            return PushTarget(href: href, graphId: graph, kind: (mg["kind"] as? String) ?? "other")
        }
        if userInfo["reminderId"] is String {
            let about = (userInfo["aboutNodeId"] as? String) ?? ""
            return PushTarget(href: about.isEmpty ? "/" : "/people/\(about)", graphId: nil, kind: "reminder")
        }
        return nil
    }

    /// Where it opens in the app: a native screen, the Today tab ("/"), or the web for screens the app doesn't have.
    enum Destination: Equatable {
        case today
        case route(Route)
        case web(String)
    }

    var destination: Destination {
        if href == "/" || href.isEmpty { return .today }
        if let r = Route.fromWebHref(href) { return .route(r) }
        return .web(href)
    }
}

/// The device token APNs gave this install, as the hex string the server stores.
enum DeviceToken {
    static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
}
