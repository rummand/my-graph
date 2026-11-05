import SwiftUI
import AppKit

/// Saved keyboard shortcuts.
@MainActor
enum Shortcuts {
    static var ask: KeyCombo? {
        get { load("mg.shortcut.ask", default: .askDefault) }
        set { save(newValue, "mg.shortcut.ask"); Panels.shared.registerHotKeys() }
    }
    static var note: KeyCombo? {
        get { load("mg.shortcut.note", default: .noteDefault) }
        set { save(newValue, "mg.shortcut.note"); Panels.shared.registerHotKeys() }
    }

    private static func load(_ key: String, default d: KeyCombo) -> KeyCombo? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return d }
        return try? JSONDecoder().decode(KeyCombo?.self, from: data) ?? nil
    }
    private static func save(_ c: KeyCombo?, _ key: String) {
        UserDefaults.standard.set(try? JSONEncoder().encode(c), forKey: key)
    }
}

/// A floating panel that takes typing without bringing the whole app forward (like Spotlight). Escape closes it.
final class FloatingPanel: NSPanel {
    init(size: NSSize) {
        super.init(contentRect: NSRect(origin: .zero, size: size),
                   styleMask: [.titled, .closable, .fullSizeContentView, .nonactivatingPanel, .resizable], backing: .buffered, defer: false)
        titleVisibility = .hidden
        titlebarAppearsTransparent = true
        isMovableByWindowBackground = true
        level = .floating
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        standardWindowButton(.miniaturizeButton)?.isHidden = true
        standardWindowButton(.zoomButton)?.isHidden = true
    }
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
    override func cancelOperation(_ sender: Any?) { close() }
}

/// The app's windows: Settings, the Ask panel and the Quick note panel.
@MainActor
final class Panels {
    static let shared = Panels()

    private var settingsWindow: NSWindow?
    private var askPanel: FloatingPanel?
    private var notePanel: FloatingPanel?
    private var tab = SettingsTabHolder()

    /// Shortcuts another app already holds (shown under General).
    private(set) var takenShortcuts: Set<String> = []

    func registerHotKeys() {
        takenShortcuts = []
        if !HotKeys.shared.register(1, Shortcuts.ask, action: { Panels.shared.showAsk() }) { takenShortcuts.insert("ask") }
        if !HotKeys.shared.register(2, Shortcuts.note, action: { Panels.shared.showNote() }) { takenShortcuts.insert("note") }
    }

    func showSettings(tab t: SettingsTab? = nil) {
        if let t { tab.tab = t }
        if settingsWindow == nil {
            let root = SettingsRoot(holder: tab).environment(AppModel.shared).environment(SyncEngine.shared)
            let w = NSWindow(contentViewController: NSHostingController(rootView: root))
            w.title = L("My Graph Settings")
            w.styleMask = [.titled, .closable, .miniaturizable]
            w.isReleasedWhenClosed = false
            w.center()
            settingsWindow = w
        }
        NSApp.activate(ignoringOtherApps: true)
        settingsWindow?.makeKeyAndOrderFront(nil)
    }

    func showAsk(question: String? = nil) {
        if askPanel == nil {
            let p = FloatingPanel(size: NSSize(width: 620, height: 460))
            p.contentViewController = NSHostingController(rootView: AskView(initial: question).environment(AppModel.shared))
            p.title = L("Ask My Graph")
            askPanel = p
        } else if let q = question {
            NotificationCenter.default.post(name: .mgAsk, object: q)
        }
        present(askPanel!)
    }

    func showNote(text: String? = nil) {
        if notePanel == nil {
            let p = FloatingPanel(size: NSSize(width: 520, height: 300))
            p.contentViewController = NSHostingController(rootView: QuickNoteView(initial: text, close: { [weak self] in self?.notePanel?.close() })
                .environment(AppModel.shared))
            p.title = L("Quick note")
            notePanel = p
        }
        present(notePanel!)
    }

    private func present(_ p: NSPanel) {
        if !p.isVisible {
            let screen = NSScreen.main?.visibleFrame ?? .zero
            p.setFrameOrigin(NSPoint(x: screen.midX - p.frame.width / 2, y: screen.maxY - p.frame.height - screen.height * 0.18))
        }
        p.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}

extension Notification.Name {
    static let mgAsk = Notification.Name("mg.ask")
}

@Observable
final class SettingsTabHolder { var tab: SettingsTab = .sources }

struct SettingsRoot: View {
    @Bindable var holder: SettingsTabHolder
    var body: some View { SettingsView(tab: $holder.tab) }
}
