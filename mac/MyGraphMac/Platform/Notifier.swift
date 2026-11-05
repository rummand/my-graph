import Foundation
import UserNotifications
import AppKit

/// Local notifications: proposals waiting (with a "Review" button that opens them on the web) and sync problems that
/// need the person (a permission, a sign-in). Each problem is shown once until it changes.
enum Notifier {
    static let reviewCategory = "mg.review"
    static let problemCategory = "mg.problem"

    static func setUp(delegate: UNUserNotificationCenterDelegate) {
        let c = UNUserNotificationCenter.current()
        c.delegate = delegate
        let review = UNNotificationAction(identifier: "review", title: L("Review"), options: [.foreground])
        let settings = UNNotificationAction(identifier: "settings", title: L("Open Settings"), options: [.foreground])
        c.setNotificationCategories([
            UNNotificationCategory(identifier: reviewCategory, actions: [review], intentIdentifiers: []),
            UNNotificationCategory(identifier: problemCategory, actions: [settings], intentIdentifiers: []),
        ])
    }

    static func requestPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    static func proposalsWaiting(_ n: Int, path: String) {
        guard n > 0 else { return }
        let content = UNMutableNotificationContent()
        content.title = n == 1 ? L("1 proposal is waiting for you") : L("\(n) proposals are waiting for you")
        content.body = L("Nothing is added to your graph until you approve it.")
        content.categoryIdentifier = reviewCategory
        content.userInfo = ["href": path]
        content.threadIdentifier = "waiting"
        post(id: "waiting", content)
    }

    static func problem(key: String, _ text: String) {
        let seen = UserDefaults.standard.stringArray(forKey: "mg.notifiedProblems") ?? []
        guard !seen.contains(key) else { return }
        UserDefaults.standard.set(Array((seen + [key]).suffix(50)), forKey: "mg.notifiedProblems")
        let content = UNMutableNotificationContent()
        content.title = L("My Graph needs you")
        content.body = text
        content.categoryIdentifier = problemCategory
        content.threadIdentifier = "problems"
        post(id: "problem-\(abs(key.hashValue))", content)
    }

    /// Problems fixed: they may be shown again if they come back.
    static func forgetProblems() { UserDefaults.standard.removeObject(forKey: "mg.notifiedProblems") }

    private static func post(id: String, _ content: UNMutableNotificationContent) {
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
    }
}

/// Opening My Graph on the web, in the person's browser.
enum Web {
    static func open(_ path: String = "/") {
        guard path.hasPrefix("/"), !path.hasPrefix("//") else { return }
        NSWorkspace.shared.open(API.shared.url(path))
    }
}
