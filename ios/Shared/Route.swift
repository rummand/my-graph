import Foundation

/// Every screen a link, citation or row can open.
enum Route: Hashable {
    case person(String)
    case node(String)
    case source(String)
    case chat(String?, UUID)
    /// A new chat with a person or node already mentioned.
    case askAbout(id: String, label: String, type: String)
    case memory
    case changes
    case settings
    case timeline
    /// Debug builds: open a new chat and ask this right away.
    case debugAsk(String)
    /// Debug builds: the widget's view at its real sizes.
    case debugWidget

    static func newChat() -> Route { .chat(nil, UUID()) }

    /// Maps the web app's hrefs ("/people/<id>", "/node/<id>", "/library/<id>", "/chat/<id>") to native screens.
    static func fromWebHref(_ href: String?) -> Route? {
        guard let href, !href.isEmpty else { return nil }
        let path = href.split(separator: "?").first.map(String.init) ?? href
        let parts = path.split(separator: "/").map(String.init)
        guard let first = parts.first else { return nil }
        let id = parts.count > 1 ? parts[1] : nil
        switch first {
        case "people": return id.map { .person($0) }
        case "node": return id.map { .node($0) }
        case "library": return id.map { .source($0) }
        case "chat": return .chat(id, UUID())
        case "memory": return .memory
        case "timeline": return .timeline
        default: return nil
        }
    }

    /// A citation opens its source document, else the node it points at.
    static func forCitation(_ c: Citation) -> Route? {
        if let s = c.sourceId { return .source(s) }
        if let n = c.nodeId { return .node(n) }
        return nil
    }
}
