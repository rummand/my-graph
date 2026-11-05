import Foundation

/// Notes (pure parts): which notes to send, given the folders and notes Notes reports (JXA), the folders chosen and the
/// cursor (the newest modification already sent). Locked notes and Recently Deleted are never sent.
enum NotesPick {
    struct Note: Equatable, Codable {
        var id: String
        var title: String
        var createdAt: Date?
        var updatedAt: Date?
        var locked: Bool
    }

    struct Folder: Equatable, Codable {
        var id: String
        var name: String
        var notes: [Note]
    }

    struct Picked: Equatable {
        var folderId: String
        var folder: String
        var note: Note
    }

    /// Folder names Notes uses for Recently Deleted, in the languages people here use.
    static let deletedFolders: Set<String> = ["Recently Deleted", "Senest slettet", "Nyligt raderade", "Nylig slettet", "Zuletzt gelöscht",
                                              "Récemment supprimés", "Eliminados recientemente", "Recentemente eliminati"]

    static func pick(_ folders: [Folder], allowed: [String]?, cursor: Date?) -> (picked: [Picked], newest: Date?) {
        let allow = allowed.map(Set.init)
        var out: [Picked] = []
        var newest = cursor
        var seen = Set<String>()
        for f in folders {
            if deletedFolders.contains(f.name) { continue }
            if let allow, !allow.contains(f.name) { continue }
            for n in f.notes where seen.insert(n.id).inserted {
                if n.locked { continue }
                if let u = n.updatedAt {
                    if newest == nil || u > newest! { newest = u }
                    if let c = cursor, u <= c { continue }
                }
                out.append(Picked(folderId: f.id, folder: f.name, note: n))
            }
        }
        out.sort { ($0.note.updatedAt ?? .distantPast) < ($1.note.updatedAt ?? .distantPast) }
        return (out, newest)
    }

    /// Folder names with their note counts, for the folder picker (no note text).
    static func counts(_ folders: [Folder]) -> [(name: String, count: Int)] {
        var c: [String: Int] = [:]
        var order: [String] = []
        for f in folders where !deletedFolders.contains(f.name) {
            if c[f.name] == nil { order.append(f.name) }
            c[f.name, default: 0] += f.notes.count
        }
        return order.map { ($0, c[$0] ?? 0) }
    }
}
