import XCTest
@testable import MyGraph

/// What a tapped notification opens: remote pushes carry `mg` (ids and a path only), local reminders their ids.
final class PushTargetTests: XCTestCase {
    func testRemoteChangeSetOpensItInItsGraph() {
        let t = PushTarget.from(userInfo: ["aps": ["alert": ["title": "x"]], "mg": ["kind": "waiting", "href": "/changes/c1", "graphId": "g1"]])
        XCTAssertEqual(t, PushTarget(href: "/changes/c1", graphId: "g1", kind: "waiting"))
        XCTAssertEqual(t?.destination, .route(.changeSet("c1")))
    }

    func testReminderAboutAPersonOpensThem() {
        let t = PushTarget.from(userInfo: ["mg": ["kind": "reminder", "href": "/people/p1", "graphId": "g1", "id": "r1"]])
        XCTAssertEqual(t?.destination, .route(.person("p1")))
    }

    func testScreensTheAppDoesntHaveOpenOnTheWeb() {
        XCTAssertEqual(PushTarget.from(userInfo: ["mg": ["kind": "clinical", "href": "/clinical", "graphId": "g2"]])?.destination, .web("/clinical"))
        XCTAssertEqual(PushTarget.from(userInfo: ["mg": ["kind": "connection", "href": "/connections"]])?.destination, .web("/connections"))
    }

    func testHomeOpensToday() {
        XCTAssertEqual(PushTarget.from(userInfo: ["mg": ["kind": "waiting", "href": "/"]])?.destination, .today)
    }

    func testLocalReminderNotifications() {
        XCTAssertEqual(PushTarget.from(userInfo: ["reminderId": "r1", "aboutNodeId": "p1"])?.destination, .route(.person("p1")))
        XCTAssertEqual(PushTarget.from(userInfo: ["reminderId": "r1", "aboutNodeId": ""])?.destination, .today)
    }

    func testIgnoresOthersAndFullURLs() {
        XCTAssertNil(PushTarget.from(userInfo: ["foo": "bar"]))
        XCTAssertNil(PushTarget.from(userInfo: ["mg": ["href": "https://evil.example/x"]]))
    }

    func testDeviceTokenIsLowercaseHex() {
        XCTAssertEqual(DeviceToken.hex(Data([0x00, 0xab, 0xff, 0x10])), "00abff10")
    }

    func testQuietHoursClockRoundTrips() {
        XCTAssertEqual(PushSettingsSection.hhmm(PushSettingsSection.date("22:30")), "22:30")
        XCTAssertEqual(PushSettingsSection.hhmm(PushSettingsSection.date("07:05")), "07:05")
    }
}
