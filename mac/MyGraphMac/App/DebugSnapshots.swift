#if DEBUG
import SwiftUI
import AppKit

/// Debug builds: `-MGSnapshot <dir>` renders the menu bar window and each Settings tab into PNGs (light and dark), by
/// drawing the app's own views (no screen recording needed), then quits unless `-MGStay` is given.
@MainActor
enum DebugSnapshots {
    static func runIfAsked() async {
        guard let dir = DebugArgs.value("-MGSnapshot") else {
            if let what = DebugArgs.value("-MGOpen") {
                switch what {
                case "ask": Panels.shared.showAsk(question: DebugArgs.value("-MGAsk"))
                case "note": Panels.shared.showNote()
                default: Panels.shared.showSettings(tab: SettingsTab(rawValue: what) ?? .sources)
                }
            }
            return
        }
        let out = URL(fileURLWithPath: dir, isDirectory: true)
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        try? await Task.sleep(for: .seconds(Double(DebugArgs.value("-MGWait") ?? "6") ?? 6))
        let app = AppModel.shared, sync = SyncEngine.shared
        for (name, appearance) in [("light", NSAppearance.Name.aqua), ("dark", NSAppearance.Name.darkAqua)] {
            let ap = NSAppearance(named: appearance)
            await render(MenuBarView().environment(app).environment(sync), width: 320, appearance: ap, to: out.appendingPathComponent("menu-\(name).png"), material: true)
            for tab in [SettingsTab.account, .sources, .general] {
                let holder = SettingsTabHolder(); holder.tab = tab
                await render(SettingsRoot(holder: holder).environment(app).environment(sync), width: 620, appearance: ap,
                             to: out.appendingPathComponent("settings-\(tab.rawValue)-\(name).png"))
            }
            await render(SourcesList().environment(app).environment(sync).frame(width: 620), width: 620, appearance: ap,
                         to: out.appendingPathComponent("settings-sources-all-\(name).png"))
            await render(AskView().environment(app).frame(width: 620, height: 460), width: 620, appearance: ap, to: out.appendingPathComponent("ask-\(name).png"))
            if let q = DebugArgs.value("-MGAsk"), name == "light" {
                await render(AskView(initial: q).environment(app).frame(width: 620, height: 460), width: 620, appearance: ap,
                             to: out.appendingPathComponent("ask-answer-\(name).png"), wait: 40)
            }
            await render(QuickNoteView(close: {}).environment(app).frame(width: 520, height: 300), width: 520, appearance: ap, to: out.appendingPathComponent("note-\(name).png"))
        }
        print("[snapshot] wrote \(out.path)")
        if !ProcessInfo.processInfo.arguments.contains("-MGStay") { NSApp.terminate(nil) }
    }

    /// Puts the view in an off-screen window, lets it lay out and load, and draws the window's content into a PNG.
    static func render<V: View>(_ view: V, width: CGFloat, appearance: NSAppearance?, to url: URL, material: Bool = false, wait: Double = 1.5) async {
        let host = NSHostingView(rootView: view.background(material ? AnyShapeStyle(.regularMaterial) : AnyShapeStyle(Color(nsColor: .windowBackgroundColor))))
        host.appearance = appearance
        let size = host.fittingSize
        let frame = NSRect(x: 0, y: 0, width: max(width, size.width), height: max(120, size.height))
        let w = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
        w.appearance = appearance
        w.contentView = host
        w.setFrameOrigin(NSPoint(x: -10_000, y: -10_000))
        w.orderFrontRegardless()
        try? await Task.sleep(for: .seconds(wait))
        host.layoutSubtreeIfNeeded()
        let bounds = host.bounds
        guard let rep = host.bitmapImageRepForCachingDisplay(in: bounds) else { return }
        host.cacheDisplay(in: bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: url)
        w.orderOut(nil)
    }
}
#endif
