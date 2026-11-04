import Foundation

/// ISO-8601 parsing for the server's dates ("2026-11-04T06:00:00.000Z", "2026-11-16T23:59:00+01:00", "2026-11-16").
enum ISODate {
    nonisolated(unsafe) private static let frac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
    }()
    nonisolated(unsafe) private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime]; return f
    }()
    nonisolated(unsafe) private static let day: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withFullDate]; return f
    }()

    static func parse(_ s: String) -> Date? { frac.date(from: s) ?? plain.date(from: s) ?? day.date(from: s) }
    static func string(_ d: Date) -> String { frac.string(from: d) }
}

// MARK: - Graphs

struct GraphSummary: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let description: String?
    let color: Double?
    let kind: String?
    let myRole: String?
    let memberCount: Int?
    let isFamily: Bool?
    let isCurrent: Bool?
    let archivedAt: String?

    var hue: Double { color ?? 210 }
}

struct GraphsResponse: Codable {
    let graphs: [GraphSummary]
    let currentGraphId: String?
}

// MARK: - Citations and provenance

struct Locator: Codable, Hashable {
    let page: Int?
    let charStart: Int?
    let charEnd: Int?
    let timeStartSec: Double?
}

struct Citation: Codable, Hashable, Identifiable {
    let n: Int?
    let sourceId: String?
    let nodeId: String?
    let edgeId: String?
    let title: String
    let quote: String?
    let locator: Locator?
    let confidence: Double?

    var id: String { "\(n ?? 0)-\(sourceId ?? nodeId ?? edgeId ?? title)" }
}

/// The web's short provenance line ("Added by hand", "school-letter.txt", "Assistant").
struct ProvenanceRef: Codable, Hashable {
    let title: String
    let href: String?
    let detail: String?
    let confidence: Double?

    /// A library source or node this points at, from the web href ("/library/<id>", "/node/<id>").
    var route: Route? { Route.fromWebHref(href) }
}

// MARK: - Today

struct Brief: Codable, Hashable {
    let text: String
    let citations: [Citation]?
    let generatedAt: String?
    let day: String?
}

struct BriefResponse: Codable { let brief: Brief? }

struct Reminder: Codable, Identifiable, Hashable {
    let id: String
    let title: String
    let detail: String?
    let dueAt: Date
    var done: Bool
    let aboutNodeId: String?
    let aboutLabel: String?
    let nodeId: String?
    let sourceId: String?
    let createdByKind: String?
}

struct RemindersResponse: Codable { let reminders: [Reminder] }

struct SuggestionPayload: Codable, Hashable {
    let href: String?
    let label: String?
}

struct Suggestion: Codable, Identifiable, Hashable {
    let id: String
    let kind: String
    let title: String
    let body: String?
    let payload: SuggestionPayload?
    let citations: [Citation]?
    let origin: String?
    let status: String?
    let createdAt: Date?
    /// Written by the server in the reader's language (GET /api/today only).
    let kindLabel: String?
    let originLabel: String?
    let alwaysLabel: String?
}

struct SuggestionsResponse: Codable { let suggestions: [Suggestion] }

struct DecisionResponse: Codable {
    let ok: Bool?
    let href: String?
    let label: String?
}

// MARK: - Change sets (versioning): GET /api/changes, POST /api/changes/:id/deliver|abandon.

struct ChangeReceipt: Codable, Hashable {
    let sourceId: String?
    let quote: String?
    let url: String?
    let conversationId: String?
    let confidence: Double?
}

struct ChangeItem: Codable, Identifiable, Hashable {
    let id: String
    let seq: Int?
    let op: String
    let summary: String?
    let note: String?
    var included: Bool?
    let nodeId: String?
    let receipt: ChangeReceipt?
}

struct ChangeSet: Codable, Identifiable, Hashable {
    let id: String
    let title: String
    let description: String?
    let status: String
    let origin: String?
    let createdAt: Date?
    let deliveredAt: Date?
    let createdByName: String?
    var changes: [ChangeItem]?
    /// Per change: outstanding | landed | conflicted.
    let verdicts: [String: String]?
    var fingerprint: String?
}

struct ChangeSetsResponse: Codable { let changeSets: [ChangeSet] }
struct ChangeSetResponse: Codable { let changeSet: ChangeSet }
struct DeliverResponse: Codable { let ok: Bool?; let applied: Int?; let conflicts: [String]?; let changeSet: ChangeSet? }
struct IncludedResponse: Codable { let ok: Bool?; let fingerprint: String? }

// MARK: - History (GET /api/history?subjectId=)

extension JSONValue {
    /// Short text for a history value, or nil when it isn't worth showing (objects, lists, nothing).
    var shortText: String? {
        switch self {
        case .string(let s):
            if s.count >= 10, s.first?.isNumber == true, let d = ISODate.parse(s) { return d.formatted(date: .abbreviated, time: s.count > 10 ? .shortened : .omitted) }
            return s.count > 80 ? String(s.prefix(79)) + "…" : s
        case .number(let n): return n.rounded() == n ? String(Int(n)) : String(format: "%.2f", n)
        case .bool(let b): return b ? String(localized: "yes") : String(localized: "no")
        case .array(let a):
            let parts = a.compactMap(\.display)
            return parts.isEmpty ? nil : parts.joined(separator: ", ")
        case .null, .object: return nil
        }
    }
}

struct HistoryEvent: Codable, Identifiable, Hashable {
    let id: String
    let subjectType: String
    let subjectId: String
    let subjectName: String?
    let kind: String
    let field: String?
    let fromValue: JSONValue?
    let toValue: JSONValue?
    let actorKind: String
    let actorName: String?
    let changeSetId: String?
    let context: String?
    let at: Date
}

struct HistoryResponse: Codable { let events: [HistoryEvent] }

// MARK: - Documents (artifacts; read-only here)

struct DocumentSummary: Codable, Identifiable, Hashable {
    let id: String
    let kind: String?
    let title: String
    let status: String?
    let visibility: String?
    let designSetName: String?
    let ownerName: String?
    let isMine: Bool?
    let updatedAt: Date?
    let publishedAt: Date?
    let drafting: Bool?
}

struct DocumentsResponse: Codable { let artifacts: [DocumentSummary] }

// MARK: - Me and Today in one request

struct MeGraph: Codable, Hashable {
    let id: String
    let name: String
    let kind: String?
    let role: String?
    let color: Double?
    let memberCount: Int?
    let isFamily: Bool?
}

struct Me: Codable, Hashable {
    let id: String
    let name: String
    let email: String?
    let role: String?
    let personNodeId: String?
    let locale: String?
    let theme: String?
    let timeZone: String?
    let graph: MeGraph?
}

struct MeResponse: Codable { let me: Me }

struct TodayGreeting: Codable, Hashable { let text: String; let date: String }

struct ServerWeekEntry: Codable, Hashable, Identifiable {
    let id: String
    let title: String
    let at: Date
    let allDay: Bool
    let isReminder: Bool
    let nodeId: String?
    let sourceId: String?
    let reminderId: String?
}

struct ServerWeekGroup: Codable, Hashable, Identifiable {
    let id: String
    let personId: String?
    let name: String
    let entries: [ServerWeekEntry]
}

struct TodayWeek: Codable, Hashable {
    let items: [TimelineItem]
    let people: [TimelinePerson]
}

struct ConnectionNeed: Codable, Hashable, Identifiable {
    let id: String
    let label: String
    let detail: String?
}

struct AttentionFactRef: Codable, Hashable, Identifiable {
    let edgeId: String
    let nodeId: String
    let text: String
    let confidence: Double?
    let sourceId: String?
    let sourceTitle: String?
    var id: String { edgeId }
}

struct TodayAttention: Codable, Hashable {
    let facts: [AttentionFactRef]
    let factTotal: Int?
    let failedUploads: Int?
    let duplicates: Int?
    let total: Int
}

struct TodayResponse: Codable {
    let locale: String?
    let greeting: TodayGreeting?
    let me: TodayMe?
    let canWrite: Bool?
    let assistantEnabled: Bool?
    let brief: Brief?
    let reminders: [Reminder]?
    let week: TodayWeek?
    let weekByPerson: [ServerWeekGroup]?
    let suggestions: [Suggestion]?
    let changeSets: [ChangeSet]?
    let recent: [LibraryItem]?
    let connections: [ConnectionNeed]?
    let attention: TodayAttention?
    let failed: [String]?

    struct TodayMe: Codable { let id: String; let name: String; let personNodeId: String? }
}

// MARK: - People

struct PersonRelation: Codable, Hashable {
    let label: String?
    let hops: Int?
    let relation: String?
    let category: String?
}

struct WellbeingPoint: Codable, Hashable {
    let score: Int?
    let at: Date?
    let note: String?
}

struct PersonSummary: Codable, Identifiable, Hashable {
    let id: String
    let label: String
    let kind: String?
    let kindLabel: String?
    let circle: String?
    let visibility: String?
    let sensitive: Bool?
    let householdMember: Bool?
    let isViewer: Bool?
    let relation: PersonRelation?
    let lastContactAt: Date?
    let wellbeing: [WellbeingPoint]?
    let birthday: JSONValue?
    let nextBirthday: JSONValue?
    let openReminders: Int?
}

struct PersonKindOption: Codable, Hashable, Identifiable {
    let key: String
    let label: String
    let circle: String?
    var id: String { key }
}

struct AttentionItem: Codable, Hashable {
    let personId: String
    let label: String
    let reason: String?
    let note: String?
}

struct PeopleOverview: Codable {
    let center: CenterRef?
    let people: [PersonSummary]
    let attention: [AttentionItem]?
    let kinds: [PersonKindOption]?

    struct CenterRef: Codable { let id: String; let label: String; let isViewer: Bool? }
}

struct NodeRef: Codable, Hashable, Identifiable {
    let id: String
    let label: String
    let type: String?
    let kind: String?
    let kindLabel: String?
}

struct RelationshipItem: Codable, Hashable, Identifiable {
    let edgeId: String
    let relation: String?
    let label: String
    let direction: String?
    let other: NodeRef
    let status: String?
    let confidence: Double?
    let citations: [ProvenanceRef]?
    var id: String { edgeId }
}

struct RelationshipGroup: Codable, Hashable, Identifiable {
    let category: String
    let label: String
    let items: [RelationshipItem]
    var id: String { category }
}

struct PersonObservation: Codable, Hashable, Identifiable {
    let id: String
    let kind: String
    let score: Int?
    let note: String?
    let at: Date?
    let authorName: String?
    let visibility: String?
}

struct FeedItem: Codable, Hashable, Identifiable {
    let id: String
    let at: Date?
    let type: String?
    let title: String
    let detail: String?
    let href: String?
    let citations: [ProvenanceRef]?
}

struct AttributeDef: Codable, Hashable {
    let key: String
    let label: String
    let dataType: String?
    let hidden: Bool?
}

struct PersonNodeDetail: Codable, Hashable {
    let id: String
    let label: String
    let kind: String?
    let kindLabel: String?
    let circle: String?
    let visibility: String?
    let sensitive: Bool?
    let isViewer: Bool?
    let relation: PersonRelation?
    let birthday: JSONValue?
    let nextBirthday: JSONValue?
    let openReminders: Int?
    let props: [String: JSONValue]?
    let summary: String?
    let aliases: [String]?
    let canEdit: Bool?
}

struct PersonDetail: Codable {
    let person: PersonNodeDetail
    let attributes: [AttributeDef]?
    let relationships: [RelationshipGroup]?
    let observations: [PersonObservation]?
    let feed: [FeedItem]?
    let provenance: [ProvenanceRef]?
}

struct CreatePersonResponse: Codable {
    let created: Bool?
    let person: NodeIdRef?
    let id: String?
    struct NodeIdRef: Codable { let id: String }
    var personId: String? { person?.id ?? id }
}

/// Any JSON value (node props).
enum JSONValue: Codable, Hashable {
    case string(String), number(Double), bool(Bool), null, array([JSONValue]), object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .null: try c.encodeNil()
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    var display: String? {
        switch self {
        case .string(let s): return s.isEmpty ? nil : s
        case .number(let n): return n == n.rounded() ? String(Int(n)) : String(n)
        case .bool: return nil
        case .null, .array, .object: return nil
        }
    }
}

// MARK: - Nodes

struct GraphNode: Codable, Hashable, Identifiable {
    let id: String
    let type: String
    let kind: String?
    let label: String
    let summary: String?
    let startAt: Date?
    let endAt: Date?
    let timePrecision: String?
    let visibility: String?
    let sensitive: Bool?
}

struct GraphEdge: Codable, Hashable, Identifiable {
    let id: String
    let fromId: String
    let toId: String
    let relation: String
    let confidence: Double?
    let status: String?
}

struct ProvenanceRow: Codable, Hashable, Identifiable {
    let id: String
    let sourceId: String?
    let sourceTitle: String?
    let quote: String?
    let activity: String?
    let agentType: String?
    let confidence: Double?
    let note: String?
    let createdAt: Date?
}

struct NodeProvenance: Codable {
    let node: [ProvenanceRow]?
    let edges: [String: [ProvenanceRow]]?
}

struct NodeDetail: Codable {
    let node: GraphNode
    let neighbours: [GraphNode]?
    let edges: [GraphEdge]?
    let provenance: NodeProvenance?
}

struct MentionItem: Codable, Hashable, Identifiable {
    let nodeId: String
    let label: String
    let type: String
    let typeLabel: String?
    let kindLabel: String?
    let summary: String?
    let isYou: Bool?
    var id: String { nodeId }
}

struct MentionsResponse: Codable { let items: [MentionItem] }

// MARK: - Timeline

struct TimelinePerson: Codable, Hashable, Identifiable {
    let id: String
    let label: String
    let kind: String?
}

struct TimelineItem: Codable, Hashable, Identifiable {
    let id: String
    let kind: String
    let title: String
    let summary: String?
    let start: Date
    let end: Date?
    let precision: String?
    let status: String?
    let personIds: [String]?
    let nodeId: String?
    let sourceId: String?
    let sensitive: Bool?
}

struct TimelineResponse: Codable {
    let items: [TimelineItem]
    let people: [TimelinePerson]?
    let truncated: Bool?
}

// MARK: - Library

struct LibraryItem: Codable, Hashable, Identifiable {
    let id: String
    let title: String
    let mime: String?
    let category: String?
    let size: Int?
    let status: String?
    let error: String?
    let visibility: String?
    let sensitive: Bool?
    let createdAt: Date?
    let ownerName: String?
    let isOwner: Bool?
    let extraction: String?
    let docKind: String?
    let changeSetId: String?
    let proposedTotal: Int?
    let documentDate: String?
}

struct LibraryResponse: Codable {
    let items: [LibraryItem]
    let total: Int?
}

struct ExtractedFact: Codable, Hashable, Identifiable {
    let edgeId: String
    let relation: String
    let status: String?
    let confidence: Double?
    let quote: String?
    let from: NodeRef
    let to: NodeRef
    var id: String { edgeId }
}

struct ExtractedEntity: Codable, Hashable, Identifiable {
    let id: String
    let label: String
    let type: String
    let summary: String?
}

struct SourceProposal: Codable, Hashable {
    let changeSetId: String?
    let total: Int?
    let counts: [String: Int]?
    let status: String?
}

struct LibraryDetail: Codable {
    let source: Source
    let entities: [ExtractedEntity]?
    let facts: [ExtractedFact]?
    let proposal: SourceProposal?

    struct Source: Codable, Hashable {
        let id: String
        let title: String
        let mime: String?
        let category: String?
        let size: Int?
        let status: String?
        let error: String?
        let visibility: String?
        let createdAt: Date?
        let ownerName: String?
        let docKind: String?
        let textContent: String?
        let nodeId: String?
        let warnings: [String]?
    }
}

struct UploadFile {
    var filename: String
    var mime: String
    var data: Data
}

struct UploadResult: Codable, Hashable {
    let name: String
    let sourceId: String?
    let duplicate: Bool?
    let error: String?
}

struct UploadResponse: Codable {
    let results: [UploadResult]?
    let error: String?
}

// MARK: - Chat

struct ConversationSummary: Codable, Identifiable, Hashable {
    let id: String
    let title: String
    let updatedAt: Date?
    let pinned: Bool?
    let unread: Bool?
    let sensitivity: String?
    let snippet: String?
}

struct ConversationsResponse: Codable { let conversations: [ConversationSummary] }

struct AssistantStep: Codable, Hashable {
    let kind: String?
    let label: String
    let count: Int?
    let ms: Int?
}

struct ProposalResult: Codable, Hashable {
    let href: String?
    let label: String?
}

/// One suggestion card from the assistant (reminder, fact, wiki note or memory).
struct Proposal: Codable, Hashable, Identifiable {
    let type: String
    let n: Int
    var status: String
    let title: String?
    let dueAt: String?
    let aboutPerson: String?
    let detail: String?
    let from: String?
    let relation: String?
    let to: String?
    let quote: String?
    let text: String?
    let kind: String?
    let about: [String]?
    var result: ProposalResult?
    var error: String?
    let auto: String?
    let widens: String?
    let current: [String]?
    let basis: String?
    var id: Int { n }
}

struct Clarify: Codable, Hashable {
    let question: String
    let choices: [String]
}

struct ChatMessage: Codable, Identifiable, Hashable {
    let id: String
    let role: String
    var content: String
    var citations: [Citation]?
    var proposals: [Proposal]?
    var steps: [AssistantStep]?
    var thoughtMs: Int?
    var clarify: Clarify?
    var createdAt: Date?
}

struct Conversation: Codable {
    let id: String
    let title: String
    let sensitivity: String?
    let messages: [ChatMessage]
}

struct ConversationResponse: Codable { let conversation: Conversation }

struct DoneEvent: Codable {
    let messageId: String
    let citations: [Citation]?
    let proposals: [Proposal]?
    let clarify: Clarify?
    let steps: [AssistantStep]?
    let thoughtMs: Int?
    let stopped: Bool?
    let degraded: String?
    let title: String?
    let text: String?
}

struct StartEvent: Codable {
    let conversationId: String
    let userMessageId: String?
    let title: String?
    let isNew: Bool?
}

// MARK: - Memory

struct MemoryAbout: Codable, Hashable { let id: String; let label: String; let type: String? }
struct MemoryFrom: Codable, Hashable { let label: String?; let href: String? }

struct MemoryItem: Codable, Identifiable, Hashable {
    let id: String
    let kind: String
    let text: String
    let status: String?
    let visibility: String?
    let about: [MemoryAbout]?
    let from: MemoryFrom?
    let quote: String?
    let ownerName: String?
    let createdAt: Date?
    let canEdit: Bool?
}

struct MemoryResponse: Codable {
    let memories: [MemoryItem]
    let canAdd: Bool?
}

struct SessionStatus: Codable { let status: String }

struct UserSettings: Codable {
    let locale: String?
    let theme: String?
    let timeZone: String?
}

struct SettingsResponse: Codable { let settings: UserSettings }
