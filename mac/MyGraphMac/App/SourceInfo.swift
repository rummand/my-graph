import Foundation

/// How each source is named and explained to a person. Every explanation says what is read, and that nothing is
/// added to the graph until a person approves it.
enum SourceInfo {
    static func title(_ id: SourceID) -> String {
        switch id {
        case .messages: return L("Messages")
        case .notes: return L("Notes")
        case .contacts: return L("Contacts")
        case .calendar: return L("Calendar")
        case .reminders: return L("Reminders")
        case .photos: return L("Photos")
        case .folders: return L("Folders")
        case .voiceMemos: return L("Voice Memos")
        case .calls: return L("Calls")
        }
    }

    static func symbol(_ id: SourceID) -> String {
        switch id {
        case .messages: return "message"
        case .notes: return "note.text"
        case .contacts: return "person.crop.circle"
        case .calendar: return "calendar"
        case .reminders: return "checklist"
        case .photos: return "photo.on.rectangle"
        case .folders: return "folder"
        case .voiceMemos: return "waveform"
        case .calls: return "phone"
        }
    }

    static func explanation(_ id: SourceID) -> String {
        switch id {
        case .messages:
            return L("Reads the conversations you choose from Messages on this Mac: who wrote what, and when. Attachments are named, not sent. Other conversations are never read.")
        case .notes:
            return L("Reads your notes as plain text from the folders you choose. Locked notes and Recently Deleted are never read.")
        case .contacts:
            return L("Sends names, numbers, email addresses, addresses, birthdays and related names from Contacts. Only cards that changed are sent again.")
        case .calendar:
            return L("Sends events from the last 30 days and the next 120 days. Events you approve in My Graph appear in a “My Graph” calendar here; your own calendars are never changed.")
        case .reminders:
            return L("Sends your reminders. Reminders you approve in My Graph appear in a “My Graph” list; when you tick one off there, My Graph hears about it.")
        case .photos:
            return L("Sends the photos you pick, with when and where they were taken. Sending the details of every photo (no images) is a separate choice.")
        case .folders:
            return L("Sends new and changed files from the folders you pick. Each change becomes a new version of the same document. Hidden files, temporary files and files over 50 MB are skipped.")
        case .voiceMemos:
            return L("Sends your Voice Memos recordings, so they can be transcribed in My Graph.")
        case .calls:
            return L("Sends who you called and who called you, when, and for how long, from this Mac's call history. Never any audio.")
        }
    }

    static let reviewNote = L("Nothing is added to your graph until you approve it in My Graph.")
}
