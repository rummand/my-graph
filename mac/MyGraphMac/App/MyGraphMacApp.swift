import SwiftUI
import UserNotifications

@main
struct MyGraphMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var app = AppModel.shared
    @State private var sync = SyncEngine.shared

    var body: some Scene {
        MenuBarExtra {
            MenuBarContent().environment(app).environment(sync)
        } label: {
            MenuBarLabel(waiting: sync.status.waiting, problem: sync.problem != nil, paused: sync.paused)
        }
        .menuBarExtraStyle(.window)
    }
}

/// The menu bar window's content (closes itself when an item opens something).
private struct MenuBarContent: View {
    @Environment(\.dismiss) private var dismiss
    var body: some View { MenuBarView(close: { dismiss() }) }
}

/// The menu bar icon: the graph mark, with the number of proposals waiting beside it.
struct MenuBarLabel: View {
    let waiting: Int
    let problem: Bool
    let paused: Bool

    var body: some View {
        let symbol = paused ? "pause.circle" : (problem ? "exclamationmark.triangle" : "point.3.filled.connected.trianglepath.dotted")
        if waiting > 0 {
            HStack(spacing: 3) {
                Image(systemName: symbol)
                Text("\(waiting)").monospacedDigit()
            }
            .accessibilityLabel(Text(L("My Graph, \(waiting) waiting for you")))
        } else {
            Image(systemName: symbol).accessibilityLabel(Text(L("My Graph")))
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        #if DEBUG
        setvbuf(stdout, nil, _IOLBF, 0)
        #endif
        Notifier.setUp(delegate: self)
        Task { @MainActor in
            Panels.shared.registerHotKeys()
            await AppModel.shared.bootstrap()
            if AppModel.shared.phase == .signedOut { Panels.shared.showSettings(tab: .account) }
            #if DEBUG
            await DebugSnapshots.runIfAsked()
            #endif
        }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        // mygraph-mac://ask?q=…, mygraph-mac://note?q=…, mygraph-mac://settings, mygraph-mac://sync[?source=contacts]
        for u in urls where u.scheme == "mygraph-mac" {
            let items = URLComponents(url: u, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let q = items.first(where: { $0.name == "q" })?.value
            Task { @MainActor in
                switch u.host {
                case "note": Panels.shared.showNote(text: q)
                case "settings": Panels.shared.showSettings()
                case "sync":
                    let source = items.first(where: { $0.name == "source" })?.value.flatMap(SourceID.init(rawValue:))
                    await SyncEngine.shared.sendNow(source)
                #if DEBUG
                case "debug-add-folder":
                    if let p = items.first(where: { $0.name == "path" })?.value { await SyncEngine.shared.addFolder(URL(fileURLWithPath: p)) }
                case "debug-send-sample":
                    if let id = items.first(where: { $0.name == "source" })?.value.flatMap(SourceID.init(rawValue:)) { await DebugSamples.send(id) }
                case "debug-note":
                    let s = await SendKit.send(SendKit.plan(files: [], urls: [], texts: [q ?? "Test note from My Graph for Mac"]), visibility: "private") { _, _ in }
                    print("[debug] note: added \(s.added) duplicates \(s.duplicates) errors \(s.errors)")
                case "debug-dump":
                    SyncEngine.shared.debugDump()
                #endif
                default: Panels.shared.showAsk(question: q)
                }
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        let category = response.notification.request.content.categoryIdentifier
        await MainActor.run {
            if category == Notifier.problemCategory { Panels.shared.showSettings(tab: .sources); return }
            Web.open((info["href"] as? String) ?? "/changes")
        }
    }
}
