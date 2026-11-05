import Foundation

/// Writing back what a person approved in My Graph: reminders into a "My Graph" list and events into a "My Graph"
/// calendar that the app made. Nothing else in Calendar or Reminders is ever changed. Pure planning here; EventKit work
/// in Sync/WriteBack.swift.
struct OutboxItem: Codable, Equatable, Identifiable {
    /// The server's id for this item.
    var id: String
    /// reminder | event
    var kind: String
    /// upsert | delete
    var op: String = "upsert"
    /// Changes whenever the server's item changes (a number or a timestamp, compared as text).
    var version: String?
    var title: String?
    var notes: String?
    var url: String?
    /// Reminders: when it is due. Events: when they start and end.
    var dueAt: String?
    var startAt: String?
    var endAt: String?
    var allDay: Bool?
    var location: String?
    var completed: Bool?

    var isReminder: Bool { kind == "reminder" }
}

/// What the app keeps per item it wrote: the EventKit identifier, and the item as last written (to recreate it).
struct OutboxLink: Codable, Equatable {
    var localId: String
    var item: OutboxItem
    /// The person ticked it done in Reminders and the server was told.
    var completedReported: Bool = false
    /// The person deleted the reminder in Reminders: it isn't put back.
    var deletedLocally: Bool = false
}

/// The state of a written item in Calendar or Reminders right now.
struct LocalItemState: Equatable {
    var exists: Bool
    var completed: Bool = false
    var completedAt: Date?
}

enum OutboxOp: Equatable {
    case create(OutboxItem)
    case update(localId: String, OutboxItem)
    case delete(localId: String, serverId: String)
    /// An event in the My Graph calendar was deleted there: it is a mirror, so it is written again.
    case recreate(OutboxItem)
    /// Tell the server: the person ticked this reminder done in Reminders.
    case reportCompleted(serverId: String, at: Date?)
    /// Tell the server: the person deleted this reminder in Reminders (it stays deleted here).
    case reportDeleted(serverId: String)
    /// Already as the server has it.
    case nothing(serverId: String)
}

enum OutboxPlanner {
    /// Plans the EventKit changes for `incoming` (what the server sent since the last ack) and the existing links.
    /// `local` holds the current state of every linked item (by localId).
    static func plan(incoming: [OutboxItem], links: [String: OutboxLink], local: [String: LocalItemState], now: Date = Date()) -> [OutboxOp] {
        var ops: [OutboxOp] = []
        var touched = Set<String>()
        for item in incoming {
            touched.insert(item.id)
            let link = links[item.id]
            if item.op == "delete" {
                if let link, local[link.localId]?.exists == true { ops.append(.delete(localId: link.localId, serverId: item.id)) }
                else { ops.append(.nothing(serverId: item.id)) }
                continue
            }
            guard item.kind == "reminder" || item.kind == "event" else { continue }
            guard let link else { ops.append(.create(item)); continue }
            let state = local[link.localId] ?? LocalItemState(exists: false)
            if !state.exists {
                if item.isReminder {
                    // The person deleted it in Reminders: that was their decision; it is reported, not put back.
                    ops.append(link.deletedLocally ? .nothing(serverId: item.id) : .reportDeleted(serverId: item.id))
                } else if isUpcoming(item, now: now) {
                    ops.append(.recreate(item))
                } else {
                    ops.append(.nothing(serverId: item.id))
                }
                continue
            }
            if item.isReminder, state.completed, !link.completedReported, item.completed != true {
                // Ticked done here before the server's change arrived: the tick wins and is reported.
                ops.append(.reportCompleted(serverId: item.id, at: state.completedAt))
                var kept = item
                kept.completed = true
                if link.item != kept { ops.append(.update(localId: link.localId, kept)) }
                continue
            }
            if link.item == item { ops.append(.nothing(serverId: item.id)); continue }
            ops.append(.update(localId: link.localId, item))
        }
        // Changes made on this Mac to items the server didn't send again.
        for (serverId, link) in links.sorted(by: { $0.key < $1.key }) where !touched.contains(serverId) {
            let state = local[link.localId] ?? LocalItemState(exists: false)
            if link.item.isReminder {
                if !state.exists {
                    if !link.deletedLocally { ops.append(.reportDeleted(serverId: serverId)) }
                } else if state.completed && !link.completedReported && link.item.completed != true {
                    ops.append(.reportCompleted(serverId: serverId, at: state.completedAt))
                }
            } else if !state.exists && link.item.op != "delete" && isUpcoming(link.item, now: now) {
                ops.append(.recreate(link.item))
            }
        }
        return ops
    }

    /// Events that have started aren't put back (the server stops sending them; it isn't a deletion).
    static func isUpcoming(_ item: OutboxItem, now: Date) -> Bool {
        guard let s = AppleTime.parseISO(item.startAt) else { return true }
        return (AppleTime.parseISO(item.endAt) ?? s) >= now
    }
}
