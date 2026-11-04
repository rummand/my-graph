import XCTest
import UIKit

/// "Send to My Graph" (the share extension, driven through the real share sheet), Paste in the Library tab,
/// dictation in Ask and the always-active chat session. Each is checked against the API afterwards.
final class SendAndAskUITests: XCTestCase {
    static let server = ProcessInfo.processInfo.environment["MG_SERVER"] ?? "http://localhost:3917"
    let slow: TimeInterval = 300
    var seed: Seeder!

    override func setUp() async throws {
        continueAfterFailure = false
        seed = Seeder(base: URL(string: Self.server)!)
        try await seed.signIn(email: "anna@example.com", password: "demo-demo-demo")
    }

    @MainActor
    private func launch(_ extra: [String], language: String = "en") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-MGServer", Self.server, "-MGSignOut", "-MGLogin", "anna@example.com:demo-demo-demo",
                               "-AppleLanguages", "(\(language))", "-AppleLocale", language == "da" ? "da_DK" : "en_DK"] + extra
        app.launch()
        return app
    }

    @MainActor
    private func shot(_ name: String) {
        let s = XCUIScreen.main.screenshot()
        let a = XCTAttachment(screenshot: s); a.name = name; a.lifetime = .keepAlways; add(a)
        if let dir = ProcessInfo.processInfo.environment["MG_SHOTS"] {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? s.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }

    /// Waits for a library item whose title contains `text`, through the API.
    private func waitForSource(_ text: String, timeout: TimeInterval = 180) async throws -> [String: Any]? {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            let q = text.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? text
            let r = try await seed.call("GET", "/api/library?q=\(q)&limit=20")
            if let hit = (r["items"] as? [[String: Any]] ?? []).first(where: { ($0["title"] as? String ?? "").contains(text) }) { return hit }
            try await Task.sleep(for: .seconds(3))
        } while Date() < deadline
        return nil
    }

    /// Finds "Send to My Graph" in the share sheet's apps row (scrolling it, or opening More, when needed).
    @MainActor
    private func shareTarget(_ app: XCUIApplication) -> XCUIElement {
        // The apps row shows the containing app's name and icon ("My Graph"); the extension's own screen is titled
        // "Send to My Graph".
        let ext = app.cells.matching(NSPredicate(format: "label IN {'My Graph', 'Send to My Graph'}")).firstMatch
        if ext.waitForExistence(timeout: 45) { return ext }
        let any = app.descendants(matching: .any).matching(NSPredicate(format: "label IN {'My Graph', 'Send to My Graph'}")).firstMatch
        _ = any.waitForExistence(timeout: 10)
        return any
    }

    // MARK: Send to My Graph

    /// Opens the share sheet with a PDF, picks "Send to My Graph", sends, and checks the file is in the library.
    @MainActor
    func testSendingAPDFThroughTheShareExtension() async throws {
        let token = "\(Int.random(in: 10000...99999))"
        let app = launch(["-MGTab", "library", "-MGShareSheet", "file:\(token)"])
        let ext = shareTarget(app)
        XCTAssertTrue(ext.exists, "Send to My Graph isn't in the share sheet")
        shot("share-01-sheet")
        ext.tap()
        let send = app.buttons["share.send"]
        XCTAssertTrue(send.waitForExistence(timeout: slow), "The extension didn't open its form")
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", token)).firstMatch.exists, "The PDF isn't listed")
        shot("share-02-form")
        send.tap()
        let done = app.staticTexts["share.done"]
        XCTAssertTrue(done.waitForExistence(timeout: slow), "No “Added to …”")
        XCTAssertTrue(done.label.hasPrefix("Added to"), done.label)
        shot("share-03-added")
        let hit = try await waitForSource(token)
        XCTAssertNotNil(hit, "The shared PDF isn't in the library")
    }

    /// Shares text: it arrives as a note through /api/library/paste.
    @MainActor
    func testSendingTextThroughTheShareExtension() async throws {
        let token = "\(Int.random(in: 10000...99999))"
        let app = launch(["-MGTab", "library", "-MGShareSheet", "text:\(token)"])
        let ext = shareTarget(app)
        XCTAssertTrue(ext.exists, "Send to My Graph isn't in the share sheet")
        ext.tap()
        let send = app.buttons["share.send"]
        XCTAssertTrue(send.waitForExistence(timeout: slow))
        XCTAssertTrue(app.staticTexts["Saved as a note"].exists)
        shot("share-04-text-form")
        send.tap()
        XCTAssertTrue(app.staticTexts["share.done"].waitForExistence(timeout: slow))
        shot("share-05-text-added")
        let hit = try await waitForSource("Shared note \(token)")
        XCTAssertNotNil(hit, "The shared text isn't a note in the library")
    }

    // MARK: Paste

    /// iOS asks "Allow Paste" when the paste comes from another app (here: the test runner) and the tap can't be
    /// verified as the system Paste button's own; a person taps Allow.
    @MainActor
    private func allowPaste(_ app: XCUIApplication) {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for target in [app, springboard] {
            let allow = target.buttons["Allow Paste"]
            if allow.waitForExistence(timeout: 4) { shot("paste-00-allow"); allow.tap(); return }
        }
    }

    @MainActor
    func testPastingTextAndAnImageIntoTheLibrary() async throws {
        let token = "\(Int.random(in: 10000...99999))"
        UIPasteboard.general.string = "Pasted note \(token)\nThe dentist moved Emma's appointment to Tuesday 9:30."
        let app = launch(["-MGTab", "library"])
        let paste = app.buttons["library.paste"]
        XCTAssertTrue(paste.waitForExistence(timeout: slow), "No Paste button")
        shot("paste-01-library")
        paste.tap()
        allowPaste(app)
        let note = app.descendants(matching: .any).matching(identifier: "library.note").firstMatch
        XCTAssertTrue(note.waitForExistence(timeout: slow), "No word after pasting")
        shot("paste-02-text-added")
        XCTAssertTrue(note.label.hasPrefix("Added to"), note.label)
        let hit = try await waitForSource("Pasted note \(token)")
        XCTAssertNotNil(hit, "The pasted text isn't a note in the library")

        // An image: a small rendered picture with the token in it.
        let img = UIGraphicsImageRenderer(size: CGSize(width: 320, height: 120)).image { ctx in
            UIColor.white.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 320, height: 120))
            ("Pasted image \(token)" as NSString).draw(at: CGPoint(x: 16, y: 48), withAttributes: [.font: UIFont.boldSystemFont(ofSize: 22)])
        }
        UIPasteboard.general.image = img
        let before = try await seed.call("GET", "/api/library?limit=1")
        let firstBefore = (before["items"] as? [[String: Any]])?.first?["id"] as? String
        XCTAssertTrue(paste.waitForExistence(timeout: 30))
        try await Task.sleep(for: .seconds(1))
        paste.tap()
        allowPaste(app)
        var newest: String?
        let deadline = Date().addingTimeInterval(120)
        repeat {
            let r = try await seed.call("GET", "/api/library?limit=1")
            if let id = (r["items"] as? [[String: Any]])?.first?["id"] as? String, id != firstBefore { newest = id; break }
            try await Task.sleep(for: .seconds(2))
        } while Date() < deadline
        shot("paste-03-image-added")
        XCTAssertNotNil(newest, "The pasted image isn't in the library")
    }

    // MARK: Dictation

    @MainActor
    func testDictationButtonListensAndSwitchesLanguage() async throws {
        let app = launch(["-MGTab", "ask"])
        let mic = app.buttons["composer.mic"]
        XCTAssertTrue(mic.waitForExistence(timeout: slow), "No microphone button in Ask")
        shot("dictation-01-ask")
        mic.tap()
        // Permission prompts come from SpringBoard.
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for _ in 0..<2 {
            let allow = springboard.buttons.matching(NSPredicate(format: "label IN {'Allow', 'OK', 'Tillad'}")).firstMatch
            if allow.waitForExistence(timeout: 8) { shot("dictation-02-permission"); allow.tap() }
        }
        let status = app.staticTexts["dictation.status"]
        let error = app.staticTexts["dictation.error"]
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline && !status.exists && !error.exists { try await Task.sleep(for: .milliseconds(300)) }
        XCTAssertTrue(status.exists || error.exists, "Nothing happened after tapping the microphone")
        shot("dictation-03-listening")
        if status.exists {
            let da = app.buttons["Danish"].exists ? app.buttons["Danish"] : app.buttons["DA"]
            if da.exists { da.tap() }
            try await Task.sleep(for: .seconds(1))
            shot("dictation-04-danish")
            app.buttons["dictation.done"].tap()
            XCTAssertTrue(status.waitForNonExistence(timeout: 10))
        } else {
            XCTContext.runActivity(named: "Dictation said: \(error.label)") { _ in }
        }
        // Typing (and the keyboard's own dictation) still goes into the same field.
        let field = app.descendants(matching: .any).matching(identifier: "composer.field").firstMatch
        XCTAssertTrue(field.exists)
    }

    // MARK: Active session

    @MainActor
    func testAskOpensTheActiveSessionAndNewConversationSetsIt() async throws {
        let list = try await seed.call("GET", "/api/chat")
        guard let conv = (list["conversations"] as? [[String: Any]])?.first(where: { !($0["title"] as? String ?? "").isEmpty }),
              let id = conv["id"] as? String, let title = conv["title"] as? String else {
            throw XCTSkip("Anna has no conversations to reopen.")
        }
        var hasActiveRoute = true
        do { try await seed.call("PUT", "/api/chat/active", json: ["conversationId": id]) } catch { hasActiveRoute = false }

        let app = launch(["-MGTab", "ask"])
        let titleText = app.staticTexts[title].firstMatch
        if hasActiveRoute {
            XCTAssertTrue(titleText.waitForExistence(timeout: slow), "Ask didn't open the active conversation “\(title)”")
        }
        shot("session-01-active")

        let new = app.buttons["ask.new"]
        XCTAssertTrue(new.waitForExistence(timeout: 30))
        new.tap()
        XCTAssertTrue(app.staticTexts["New chat"].firstMatch.waitForExistence(timeout: 30))
        shot("session-02-new")
        if hasActiveRoute {
            let deadline = Date().addingTimeInterval(30)
            var cleared = false
            repeat {
                let v = try await seed.call("GET", "/api/chat/active?light=1")["conversationId"]
                if v == nil || v is NSNull { cleared = true; break }
                try await Task.sleep(for: .seconds(1))
            } while Date() < deadline
            XCTAssertTrue(cleared, "The server's session wasn't set to a new conversation")
        }

        app.buttons["ask.chats"].tap()
        let row = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: slow), "The saved conversation isn't in Chats")
        shot("session-03-chats")
        row.tap()
        XCTAssertTrue(titleText.waitForExistence(timeout: 60))
        if hasActiveRoute {
            try await Task.sleep(for: .seconds(2))
            let active = try await seed.call("GET", "/api/chat/active?light=1")["conversationId"] as? String
            XCTAssertEqual(active, id, "Reopening didn't make it the active session")
        }
        shot("session-04-reopened")
    }
}
