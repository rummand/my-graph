import Foundation

/// The JSON the Mac app sends to `POST /api/connections/mac/import/<importer>` as `data`. Shapes follow
/// `src/lib/importers/schemas.ts` (imessagePayload, appleNotesPayload, contactsPayload, photosPayload and the Mac's
/// calendar, reminders and calls payloads). Contacts and photos reuse the iPhone's types (PhoneImportKit.swift).
enum MacImporter: String, Codable, CaseIterable {
    case imessage, apple_notes, contacts, photos, calendar, reminders, calls
}

// MARK: Messages

struct MessageParticipant: Codable, Equatable, Hashable {
    var handle: String
    var name: String?
}

struct MessageAttachment: Codable, Equatable {
    var filename: String
    var mime: String?
}

struct MessageItem: Codable, Equatable {
    var id: String
    var at: String
    /// A participant's handle, or "me".
    var from: String
    var text: String
    var attachments: [MessageAttachment] = []
}

struct MessageChat: Codable, Equatable {
    var id: String
    var name: String?
    var participants: [MessageParticipant]
    var messages: [MessageItem]
}

struct IMessageData: Codable, Equatable { var chats: [MessageChat] }

/// A conversation as listed for choosing (no messages): what the Settings picker and the server's catalog show.
struct ChatSummary: Codable, Equatable, Identifiable, Hashable {
    var id: String
    var name: String?
    var participants: [MessageParticipant]
    var count: Int
    var lastAt: String?

    /// What the picker shows: the chat's name, else the people in it.
    var title: String {
        if let n = name, !n.isEmpty { return n }
        let names = participants.map { $0.name ?? $0.handle }
        return names.isEmpty ? id : names.prefix(4).joined(separator: ", ") + (names.count > 4 ? " +\(names.count - 4)" : "")
    }
}

// MARK: Notes

struct NoteItem: Codable, Equatable {
    var id: String
    var title: String
    var folder: String?
    var createdAt: String?
    var updatedAt: String?
    var text: String
}

struct AppleNotesData: Codable, Equatable { var notes: [NoteItem] }

// MARK: Calendar and reminders

struct EventAttendee: Codable, Equatable, Hashable {
    var name: String?
    var email: String?
}

/// One calendar event (EventKit), 30 days back to 120 days ahead.
struct EventItem: Codable, Equatable, Identifiable {
    /// EKEvent.calendarItemExternalIdentifier + the occurrence's start, so each occurrence of a repeating event is its own.
    var id: String
    var calendar: String
    var title: String
    var start: String
    var end: String?
    var allDay: Bool = false
    var location: String?
    var notes: String?
    var url: String?
    var attendees: [EventAttendee]?
}

struct CalendarData: Codable, Equatable { var events: [EventItem] }

struct ReminderItem: Codable, Equatable, Identifiable {
    var id: String
    var list: String
    var title: String
    var due: String?
    var notes: String?
    var done: Bool
    /// EventKit's 0 (none) to 9 (low); 1 is high.
    var priority: Int?
}

struct RemindersData: Codable, Equatable { var reminders: [ReminderItem] }

// MARK: Calls

struct CallItem: Codable, Equatable, Identifiable {
    var id: String
    var at: String
    var durationSec: Int
    /// in | out | missed
    var direction: String
    /// The other side's number, or an email address (FaceTime).
    var handle: String
    /// The name Contacts (or Call History) gives this handle, if any.
    var name: String?
    /// phone | facetime_audio | facetime_video
    var service: String
}

struct CallsData: Codable, Equatable { var calls: [CallItem] }

// MARK: The batch envelope

/// `{ runId, batch, final, …, data }` — one batch of one run. The same `batch` name sent again updates instead of
/// duplicating on the server.
struct MacBatch<D: Encodable>: Encodable {
    var runId: String
    var batch: String
    var final: Bool
    var device: String?
    var phase: String?
    var lastRowId: Int64?
    var covered: [String]?
    var notesCursor: String?
    var data: D
}

/// A batch name the server accepts (`^[A-Za-z0-9._:-]{1,120}$`).
func batchName(_ raw: String) -> String {
    let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:-")
    let s = String(String.UnicodeScalarView(raw.unicodeScalars.map { allowed.contains($0) ? $0 : "-" }))
    return String(s.prefix(120)).nilIfBlank ?? "batch"
}

extension String {
    var nilIfBlank: String? {
        let t = trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }
}
