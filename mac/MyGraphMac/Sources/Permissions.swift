import Foundation
import AppKit
import Contacts
import EventKit
import Photos
import CoreServices

/// Where a source stands with macOS privacy: what the Sources tab shows next to the switch, and which button helps.
enum Permission: Equatable {
    case granted
    /// Not asked yet: the app asks when the person turns the source on.
    case notAsked
    case denied
    /// Messages, Calls and Voice Memos live behind Full Disk Access, which only the person can give in System Settings.
    case needsFullDiskAccess
    /// Notes is read through Automation (Apple Events); macOS asks once.
    case needsAutomation
    /// Photos: only some photos are shared with the app.
    case limited
    /// Nothing to ask (watched folders the person picked).
    case notNeeded
    /// The app it reads isn't on this Mac (no Messages database, no Voice Memos folder).
    case unavailable

    var isUsable: Bool { self == .granted || self == .limited || self == .notNeeded }

    var label: String {
        switch self {
        case .granted: return L("Allowed")
        case .notAsked: return L("Not asked yet")
        case .denied: return L("Not allowed")
        case .needsFullDiskAccess: return L("Needs Full Disk Access")
        case .needsAutomation: return L("Needs permission to read Notes")
        case .limited: return L("Some photos only")
        case .notNeeded: return L("No permission needed")
        case .unavailable: return L("Not found on this Mac")
        }
    }
}

enum Permissions {
    // MARK: Full Disk Access

    /// Files only Full Disk Access opens. The first that exists decides; when none exists, Messages' folder listing does.
    static var fullDiskAccessProbes: [String] {
        let home = NSHomeDirectory()
        return [home + "/Library/Messages/chat.db",
                home + "/Library/Application Support/CallHistoryDB/CallHistory.storedata",
                home + "/Library/Safari/Bookmarks.plist",
                "/Library/Application Support/com.apple.TCC/TCC.db"]
    }

    static var hasFullDiskAccess: Bool {
        let fm = FileManager.default
        for p in fullDiskAccessProbes where fm.fileExists(atPath: p) {
            if let h = FileHandle(forReadingAtPath: p) { try? h.close(); return true }
            return false
        }
        // Without access, ~/Library/Messages can't even be listed.
        return (try? fm.contentsOfDirectory(atPath: NSHomeDirectory() + "/Library/Messages")) != nil
    }

    static func fileSource(_ path: String) -> Permission {
        let fm = FileManager.default
        if !hasFullDiskAccess { return .needsFullDiskAccess }
        return fm.fileExists(atPath: path) ? .granted : .unavailable
    }

    static func openFullDiskAccess() {
        open("x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles",
             fallback: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
    }

    // MARK: Contacts, Calendar, Reminders, Photos

    static var contacts: Permission {
        switch CNContactStore.authorizationStatus(for: .contacts) {
        case .authorized: return .granted
        case .notDetermined: return .notAsked
        case .limited: return .limited
        default: return .denied
        }
    }

    static func events(_ type: EKEntityType) -> Permission {
        switch EKEventStore.authorizationStatus(for: type) {
        case .fullAccess: return .granted
        case .notDetermined: return .notAsked
        case .writeOnly: return .limited
        default: return .denied
        }
    }

    static var photos: Permission {
        switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
        case .authorized: return .granted
        case .limited: return .limited
        case .notDetermined: return .notAsked
        default: return .denied
        }
    }

    static func openPrivacy(_ pane: String) {
        open("x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?\(pane)",
             fallback: "x-apple.systempreferences:com.apple.preference.security?\(pane)")
    }

    // MARK: Notes (Automation)

    static let notesBundleId = "com.apple.Notes"

    /// Whether this app may send Apple Events to Notes. Doesn't ask (askUserIfNeeded false). Notes must be running for
    /// macOS to answer; when it isn't, the last known answer stays.
    static func notesAutomation(ask: Bool = false) -> Permission {
        let target = NSAppleEventDescriptor(bundleIdentifier: notesBundleId)
        let status = AEDeterminePermissionToAutomateTarget(target.aeDesc, typeWildCard, typeWildCard, ask)
        switch status {
        case noErr:
            UserDefaults.standard.set(true, forKey: "mg.notesAllowed")
            return .granted
        case OSStatus(errAEEventNotPermitted):
            UserDefaults.standard.set(false, forKey: "mg.notesAllowed")
            return .denied
        case OSStatus(errAEEventWouldRequireUserConsent): return .needsAutomation
        default:
            // procNotFound (-600): Notes isn't running.
            if let known = UserDefaults.standard.object(forKey: "mg.notesAllowed") as? Bool { return known ? .granted : .denied }
            return .needsAutomation
        }
    }

    /// Opens Notes in the background if needed and asks macOS for Automation permission (shows the system prompt once).
    static func askNotesAutomation() async -> Permission {
        if NSRunningApplication.runningApplications(withBundleIdentifier: notesBundleId).isEmpty,
           let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: notesBundleId) {
            let cfg = NSWorkspace.OpenConfiguration()
            cfg.activates = false
            cfg.hides = true
            _ = try? await NSWorkspace.shared.openApplication(at: url, configuration: cfg)
            try? await Task.sleep(for: .seconds(1))
        }
        return await Task.detached { notesAutomation(ask: true) }.value
    }

    // MARK: Helpers

    static func open(_ primary: String, fallback: String) {
        if let u = URL(string: primary), NSWorkspace.shared.open(u) { return }
        if let u = URL(string: fallback) { NSWorkspace.shared.open(u) }
    }
}
