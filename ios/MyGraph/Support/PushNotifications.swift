import Foundation
import UIKit
import UserNotifications

extension Notification.Name {
    /// A notification was tapped; `object` is the `PushTarget` to open.
    static let mgOpenTarget = Notification.Name("mg.openTarget")
}

/// Remote notifications: register with APNs once notifications are allowed and someone is signed in, tell the server
/// the device token (`POST /api/devices`), and forget it on sign-out (`DELETE /api/devices`). When the server says it
/// pushes reminders, the app stops scheduling its own local ones so nothing arrives twice.
enum PushRegistration {
    private static let tokenKey = "pushDeviceToken"
    private static let serverRemindersKey = "pushRemindersByServer"

    /// The server sends reminders as pushes to this iPhone (then local reminder notifications are off).
    static var serverHandlesReminders: Bool { AppGroup.defaults.bool(forKey: serverRemindersKey) }

    static var savedToken: String? { AppGroup.defaults.string(forKey: tokenKey) }

    /// Asks iOS for a device token when notifications are allowed. The answer arrives in the app delegate.
    @MainActor
    static func registerIfAllowed() async {
        guard await ReminderNotifications.isAuthorized() else { return }
        UIApplication.shared.registerForRemoteNotifications()
    }

    /// Called with APNs' token: send it to the server with the app's version and language.
    static func didRegister(token data: Data) {
        let hex = DeviceToken.hex(data)
        AppGroup.defaults.set(hex, forKey: tokenKey)
        Task { await send(hex) }
    }

    static func send(_ hex: String) async {
        guard CookieVault.hasSession else { return }
        struct Answer: Decodable { let push: Bool?; let remindersByPush: Bool? }
        let v = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
        let b = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "1"
        var body: [String: Any] = ["token": hex, "platform": "ios", "appVersion": "\(v) (\(b))", "environment": environment]
        if AppLanguage.supported.contains(AppLanguage.current) { body["locale"] = AppLanguage.current }
        do {
            let a: Answer = try await API.shared.call("POST", "/api/devices", json: body)
            await apply(remindersByPush: a.remindersByPush == true)
        } catch {
            // An older server without /api/devices, or offline: keep local reminders.
            if case APIError.notFound = error { await apply(remindersByPush: false) }
            #if DEBUG
            print("[push] registering the device failed: \(error.plainMessage)")
            #endif
        }
    }

    /// The server changed whether it pushes reminders (registration, or a settings change).
    static func apply(remindersByPush: Bool) async {
        let before = serverHandlesReminders
        AppGroup.defaults.set(remindersByPush, forKey: serverRemindersKey)
        if remindersByPush { ReminderNotifications.removeAll() }
        else if before { await ReminderNotifications.refresh() }
    }

    /// On sign-out, before the session ends: the server stops pushing to this iPhone.
    static func unregister() async {
        if let t = savedToken {
            _ = try? await API.shared.send(API.shared.request("DELETE", "/api/devices", json: ["token": t]), quietAuth: true)
        }
        forgetLocally()
    }

    /// Signed out (or the session ended elsewhere): local reminders are the app's job again until the next sign-in.
    static func forgetLocally() {
        AppGroup.defaults.set(false, forKey: serverRemindersKey)
        UNUserNotificationCenter.current().setBadgeCount(0)
    }

    /// Debug builds talk to the APNs sandbox; App Store and TestFlight builds to production.
    private static var environment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }
}

/// The app delegate: device tokens from APNs, and notification taps (remote and local) for the whole app.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    /// A tap that launched the app, held until the main screen is ready to open it.
    @MainActor static var pendingTarget: PushTarget?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        // Places: iOS relaunches the app in the background to hand over a visit; the delegate must be listening.
        PlacesMonitor.shared.resumeIfOn()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushRegistration.didRegister(token: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // The simulator without a push environment, or no network: local reminders keep working.
        #if DEBUG
        print("[push] APNs registration failed: \(error.localizedDescription)")
        #endif
    }

    /// In the foreground, still show the banner (a reminder falling due while you're in the app).
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    /// A tap opens the screen it is about.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              let target = PushTarget.from(userInfo: response.notification.request.content.userInfo) else { return }
        await MainActor.run {
            AppDelegate.pendingTarget = target
            NotificationCenter.default.post(name: .mgOpenTarget, object: target)
        }
    }
}
