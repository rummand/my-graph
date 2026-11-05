import Foundation
import UserNotifications
import BackgroundTasks
import WidgetKit

/// Local notifications for reminders that fall due. Refreshed when the app opens and by background refresh.
/// When the server pushes reminders to this iPhone (`PushRegistration.serverHandlesReminders`), these stay off.
enum ReminderNotifications {
    private static let prefix = "reminder-"
    private static let declinedKey = "notificationsDeclined"

    /// True when we haven't asked yet and the person hasn't said "Not now".
    static func shouldAsk() async -> Bool {
        if AppGroup.defaults.bool(forKey: declinedKey) { return false }
        let s = await UNUserNotificationCenter.current().notificationSettings()
        return s.authorizationStatus == .notDetermined
    }

    static func declineAsking() { AppGroup.defaults.set(true, forKey: declinedKey) }

    static func requestPermission() async -> Bool {
        let ok = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        if ok { await PushRegistration.registerIfAllowed() }
        return ok
    }

    static func isAuthorized() async -> Bool {
        let s = await UNUserNotificationCenter.current().notificationSettings()
        return s.authorizationStatus == .authorized || s.authorizationStatus == .provisional
    }

    /// Fetches upcoming reminders and schedules them.
    static func refresh() async {
        guard await isAuthorized() else { return }
        guard let r: RemindersResponse = try? await API.shared.get("/api/reminders", query: ["upcoming": "true", "days": "14", "limit": "60"]) else { return }
        await schedule(r.reminders)
    }

    /// Replaces the pending reminder notifications with these (open, due in the future; iOS allows 64 at most).
    static func schedule(_ reminders: [Reminder]) async {
        guard await isAuthorized() else { return }
        if PushRegistration.serverHandlesReminders { removeAll(); return }
        let center = UNUserNotificationCenter.current()
        let now = Date()
        let due = reminders.filter { !$0.done && $0.dueAt > now }.sorted { $0.dueAt < $1.dueAt }.prefix(50)
        let wanted = Set(due.map { prefix + $0.id })
        let pending = await center.pendingNotificationRequests().map(\.identifier).filter { $0.hasPrefix(prefix) }
        center.removePendingNotificationRequests(withIdentifiers: pending.filter { !wanted.contains($0) })
        for r in due {
            let content = UNMutableNotificationContent()
            content.title = r.title
            if let about = r.aboutLabel { content.subtitle = about }
            content.body = r.detail.map(RichText.mentionsToPlain) ?? String(localized: "Due now")
            content.sound = .default
            content.threadIdentifier = "reminders"
            content.userInfo = ["reminderId": r.id, "aboutNodeId": r.aboutNodeId ?? ""]
            let comps = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: r.dueAt)
            let trigger = UNCalendarNotificationTrigger(dateMatching: comps, repeats: false)
            try? await center.add(UNNotificationRequest(identifier: prefix + r.id, content: content, trigger: trigger))
        }
    }

    static func remove(id: String) {
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [prefix + id])
    }

    static func removeAll() {
        let center = UNUserNotificationCenter.current()
        center.getPendingNotificationRequests { reqs in
            center.removePendingNotificationRequests(withIdentifiers: reqs.map(\.identifier).filter { $0.hasPrefix(prefix) })
        }
    }
}

/// BGAppRefreshTask: refresh reminders' notifications and the widget's Next up while the app is closed.
enum BackgroundRefresh {
    static let identifier = (Bundle.main.object(forInfoDictionaryKey: "MGRefreshTask") as? String) ?? "app.mygraph.ios.refresh"

    static func schedule() {
        let req = BGAppRefreshTaskRequest(identifier: identifier)
        req.earliestBeginDate = Date().addingTimeInterval(60 * 60)
        try? BGTaskScheduler.shared.submit(req)
    }

    static func run() async {
        schedule()
        CookieVault.restore()
        guard CookieVault.hasSession else { return }
        await ReminderNotifications.refresh()
        _ = try? await NextUp.fetch()
        WidgetCenter.shared.reloadAllTimelines()
    }
}
