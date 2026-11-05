import AppIntents
import Foundation

/// Shortcuts: "Ask My Graph" opens the Ask panel with the question; "Add note to My Graph" saves a note to the library
/// of the current graph (private), like Quick note.
struct AskMyGraphIntent: AppIntent {
    static let title: LocalizedStringResource = LocalizedStringResource("Ask My Graph", table: "Mac")
    static let description = IntentDescription(LocalizedStringResource("Opens My Graph's Ask panel with your question.", table: "Mac"))
    static let openAppWhenRun = true

    @Parameter(title: LocalizedStringResource("Question", table: "Mac"))
    var question: String?

    @MainActor
    func perform() async throws -> some IntentResult {
        Panels.shared.showAsk(question: question?.nilIfBlank)
        return .result()
    }
}

struct AddNoteIntent: AppIntent {
    static let title: LocalizedStringResource = LocalizedStringResource("Add note to My Graph", table: "Mac")
    static let description = IntentDescription(LocalizedStringResource("Saves a note to the library of your current graph. Only you can see it until you share it.", table: "Mac"))

    @Parameter(title: LocalizedStringResource("Note", table: "Mac"), inputOptions: String.IntentInputOptions(multiline: true))
    var text: String

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        CookieVault.restore()
        guard CookieVault.hasSession else {
            throw IntentFailure(L("Sign in to My Graph on this Mac first."))
        }
        let items = SendKit.plan(files: [], urls: [], texts: [text])
        let s = await SendKit.send(items, visibility: "private") { _, _ in }
        if s.allFailed { throw IntentFailure(s.errors.first ?? L("The note couldn't be saved.")) }
        return .result(dialog: IntentDialog(stringLiteral: L("Saved to My Graph.")))
    }
}

struct IntentFailure: LocalizedError {
    let message: String
    init(_ m: String) { message = m }
    var errorDescription: String? { message }
}

struct MyGraphShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: AskMyGraphIntent(), phrases: ["Ask \(.applicationName)"], shortTitle: LocalizedStringResource("Ask My Graph", table: "Mac"),
                    systemImageName: "sparkle.magnifyingglass")
        AppShortcut(intent: AddNoteIntent(), phrases: ["Add a note to \(.applicationName)"],
                    shortTitle: LocalizedStringResource("Add note", table: "Mac"), systemImageName: "square.and.pencil")
    }
}
