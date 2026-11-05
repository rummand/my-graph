import SwiftUI
import UIKit
import BackgroundTasks

@main
struct MyGraphApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var app = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        MGFont.register()
        Appearance.apply()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                .environment(\.locale, Locale(identifier: app.locale))
                .mgFont(.body)
                .tint(.mgAccent)
                .task { await app.bootstrap() }
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active, app.phase == .signedIn else { return }
            Task {
                await PushRegistration.registerIfAllowed()
                await ReminderNotifications.refresh()
                BackgroundRefresh.schedule()
            }
        }
        .backgroundTask(.appRefresh(BackgroundRefresh.identifier)) {
            await BackgroundRefresh.run()
        }
    }
}

/// UIKit chrome in the design's type and tokens: navigation bars on the ground, flat tab bar.
enum Appearance {
    static func apply() {
        let nav = UINavigationBarAppearance()
        nav.configureWithTransparentBackground()
        nav.backgroundColor = Palette.bg
        nav.titleTextAttributes = [.font: MGFont.ui(.bodyStrong), .foregroundColor: Palette.fg]
        nav.largeTitleTextAttributes = [.font: MGFont.ui(.title), .foregroundColor: Palette.fg]
        let scrolled = UINavigationBarAppearance()
        scrolled.configureWithDefaultBackground()
        scrolled.titleTextAttributes = nav.titleTextAttributes
        scrolled.largeTitleTextAttributes = nav.largeTitleTextAttributes
        UINavigationBar.appearance().standardAppearance = scrolled
        UINavigationBar.appearance().scrollEdgeAppearance = nav
        UINavigationBar.appearance().compactAppearance = scrolled

        let tabItem = UITabBarItemAppearance()
        tabItem.normal.titleTextAttributes = [.font: MGFont.base(size: 10, weight: 500)]
        tabItem.selected.titleTextAttributes = [.font: MGFont.base(size: 10, weight: 600)]
        let tab = UITabBarAppearance()
        tab.configureWithDefaultBackground()
        tab.stackedLayoutAppearance = tabItem
        tab.inlineLayoutAppearance = tabItem
        tab.compactInlineLayoutAppearance = tabItem
        UITabBar.appearance().standardAppearance = tab
        UITabBar.appearance().scrollEdgeAppearance = tab
    }
}

enum Haptics {
    static func success() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    static func tap() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    static func warning() { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
}
