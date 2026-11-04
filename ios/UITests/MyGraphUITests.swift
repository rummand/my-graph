import XCTest

/// Drives the real app against a running server (default http://localhost:3917, override with MG_SERVER) as Anna,
/// and checks every tap against the API afterwards. Seeds what it needs first: a to-do, a chat proposal and a
/// document whose read-through proposes a change set. Screenshots go to MG_SHOTS (if set) and the test report.
final class MyGraphUITests: XCTestCase {
    static let server = ProcessInfo.processInfo.environment["MG_SERVER"] ?? "http://localhost:3917"
    static let email = "anna@example.com"
    static let password = "demo-demo-demo"
    /// The development server can be slow to compile a route the first time.
    let slow: TimeInterval = 300

    var seed: Seeder!

    override func setUp() async throws {
        continueAfterFailure = false
        seed = Seeder(base: URL(string: Self.server)!)
        try await seed.signIn(email: Self.email, password: Self.password)
    }

    @MainActor
    private func launch(_ extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-MGServer", Self.server, "-MGSignOut", "-MGLogin", "\(Self.email):\(Self.password)",
                               "-AppleLanguages", "(en)", "-AppleLocale", "en_DK"] + extra
        app.launch()
        return app
    }

    @MainActor
    private func shot(_ app: XCUIApplication, _ name: String) {
        let s = app.screenshot()
        let a = XCTAttachment(screenshot: s); a.name = name; a.lifetime = .keepAlways; add(a)
        if let dir = ProcessInfo.processInfo.environment["MG_SHOTS"] {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? s.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }

    /// Waits up to `timeout` for an element further down a screen that is still loading: scrolls down in steps, and
    /// back to the top now and then (a lazy stack only builds what is near the screen).
    @MainActor
    private func find(_ el: XCUIElement, in app: XCUIApplication, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        var down = 0
        while Date() < deadline {
            if el.exists && el.isHittable { return true }
            if down < 6 { app.swipeUp(velocity: .slow); down += 1 }
            else {
                for _ in 0..<6 { app.swipeDown(velocity: .fast) }
                down = 0
                _ = el.waitForExistence(timeout: 5)
            }
        }
        return el.exists
    }

    /// Scrolls the screen until the element exists and is on screen.
    @MainActor
    private func reveal(_ el: XCUIElement, in app: XCUIApplication, swipes: Int = 12) {
        var n = 0
        while (!el.exists || !el.isHittable) && n < swipes { app.swipeUp(velocity: .slow); n += 1 }
    }

    // MARK: Suggestions

    @MainActor
    func testApproveAndDenySuggestionsOnToday() async throws {
        let pending = try await seed.pendingSuggestions()
        guard pending.count >= 2 else { throw XCTSkip("Needs two pending suggestions for Anna; found \(pending.count).") }
        // Deny one, approve one that doesn't open another screen (fact, reminder or memory first).
        let deny = pending[0]
        let approve = pending.dropFirst().first { $0.kind != "nudge" } ?? pending[1]

        let app = launch(["-MGTab", "today"])
        XCTAssertTrue(app.staticTexts["today.greeting"].waitForExistence(timeout: slow), "Today never loaded")
        let denyCard = app.otherElements["suggestion.\(deny.id)"]
        XCTAssertTrue(denyCard.waitForExistence(timeout: slow), "The suggestion to deny isn't on Today")
        shot(app, "01-today-waiting")
        denyCard.buttons["suggestion.deny"].tap()
        XCTAssertTrue(denyCard.waitForNonExistence(timeout: 120), "The denied card stayed")

        let approveCard = app.otherElements["suggestion.\(approve.id)"]
        reveal(approveCard, in: app)
        XCTAssertTrue(approveCard.waitForExistence(timeout: 30))
        approveCard.buttons["suggestion.approve"].tap()
        XCTAssertTrue(approveCard.waitForNonExistence(timeout: 120), "The approved card stayed")
        shot(app, "02-today-after-decisions")

        let d = try await seed.suggestionStatus(deny.id)
        let a = try await seed.suggestionStatus(approve.id)
        XCTAssertEqual(d, "denied")
        XCTAssertEqual(a, "approved")
    }

    // MARK: To-dos

    @MainActor
    func testTickingATodoMarksItDone() async throws {
        let title = "UI test: water the plants \(Int.random(in: 1000...9999))"
        let id = try await seed.createReminder(title: title, dueIn: 3 * 3600)

        let app = launch(["-MGTab", "today"])
        XCTAssertTrue(app.staticTexts["today.greeting"].waitForExistence(timeout: slow), "Today never loaded")
        let tick = app.buttons["todo.tick.\(id)"]
        XCTAssertTrue(find(tick, in: app, timeout: slow), "The new to-do isn't on Today")
        shot(app, "03-todo-before")
        tick.tap()
        XCTAssertTrue(tick.waitForNonExistence(timeout: 120), "The ticked to-do stayed")
        shot(app, "04-todo-after")
        let done = try await seed.reminderDone(id)
        XCTAssertTrue(done, "The server doesn't have the to-do as done")
    }

    // MARK: Chat proposal

    @MainActor
    func testApprovingAChatProposal() async throws {
        let chat = try await seed.chatWithProposal()
        guard let conversationId = chat else { throw XCTSkip("The assistant didn't propose anything for the seeded question.") }

        let app = launch(["-MGTab", "ask", "-MGRoute", "chat:\(conversationId)"])
        let approve = app.buttons["proposal.approve"].firstMatch
        XCTAssertTrue(approve.waitForExistence(timeout: slow), "No proposal to approve in the chat")
        reveal(approve, in: app, swipes: 4)
        shot(app, "05-chat-proposal")
        approve.tap()
        XCTAssertTrue(app.staticTexts["proposal.approved"].firstMatch.waitForExistence(timeout: 120)
                      || app.otherElements["proposal.approved"].firstMatch.exists, "The proposal didn't turn approved")
        shot(app, "06-chat-approved")
        let statuses = try await seed.proposalStatuses(conversationId)
        XCTAssertTrue(statuses.contains("approved"), "Server statuses: \(statuses)")
    }

    // MARK: Change set

    @MainActor
    func testDeliveringAChangeSetWithOneChangeLeftOut() async throws {
        let setId = try await seed.changeSetFromUpload()
        let before = try await seed.changeSet(setId)
        let count = before.changes.count
        XCTAssertGreaterThan(count, 0)

        let app = launch(["-MGTab", "today", "-MGRoute", "changes:\(setId)"])
        let deliver = app.buttons["changeset.detail.deliver"]
        let first = app.buttons["change.tick.\(before.changes.first?.seq ?? 1)"]
        XCTAssertTrue(first.waitForExistence(timeout: slow), "The proposal didn't open")
        shot(app, "07-changeset-detail")

        var leftOut: String?
        if count > 1, let last = before.changes.last {
            let tick = app.buttons["change.tick.\(last.seq)"]
            reveal(tick, in: app)
            if tick.waitForExistence(timeout: 10) {
                tick.tap()
                leftOut = last.id
                // Wait for the server to record the untick before delivering.
                let deadline = Date().addingTimeInterval(120)
                while Date() < deadline, try await seed.changeSet(setId).changes.first(where: { $0.id == last.id })?.included != false {
                    try await Task.sleep(for: .seconds(2))
                }
            }
        }
        reveal(deliver, in: app)
        XCTAssertTrue(deliver.waitForExistence(timeout: 30), "No Deliver button")
        shot(app, "08-changeset-one-left-out")
        deliver.tap()
        let delivered = app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH 'Delivered'")).firstMatch
        XCTAssertTrue(delivered.waitForExistence(timeout: slow), "No sign it was delivered")
        shot(app, "09-changeset-delivered")

        let after = try await seed.changeSet(setId)
        XCTAssertEqual(after.status, "delivered")
        // What was left out doesn't land: the server moves it to a new "Rest of …" proposal.
        if let leftOut {
            XCTAssertFalse(after.changes.contains { $0.id == leftOut && $0.included }, "The left-out change was delivered")
            XCTAssertEqual(after.changes.filter(\.included).count, count - 1)
        }
    }
}
