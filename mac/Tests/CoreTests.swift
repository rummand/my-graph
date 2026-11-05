import XCTest

final class AttributedBodyTests: XCTestCase {
    func testReadsTheStringAfterNSString() {
        XCTAssertEqual(AttributedBody.text(Fixture.attributedBody("Hej Ida, ses vi kl. 17?")), "Hej Ida, ses vi kl. 17?")
    }

    func testReadsNSMutableStringAndUnicode() {
        XCTAssertEqual(AttributedBody.text(Fixture.attributedBody("Æbler og 🍎", mutable: true)), "Æbler og 🍎")
    }

    func testTwoByteLength() {
        let long = String(repeating: "abcdefghij", count: 50) // 500 bytes: 0x81 + 2 bytes
        XCTAssertEqual(AttributedBody.text(Fixture.attributedBody(long)), long)
    }

    func testFourByteLength() {
        let huge = String(repeating: "x", count: 70_000) // over 0xFFFF: 0x82 + 4 bytes
        XCTAssertEqual(AttributedBody.text(Fixture.attributedBody(huge))?.count, 70_000)
    }

    func testOddInputIsNilNeverACrash() {
        XCTAssertNil(AttributedBody.text(nil))
        XCTAssertNil(AttributedBody.text(Data()))
        XCTAssertNil(AttributedBody.text(Data("no class name here".utf8)))
        var cut = Fixture.attributedBody("Hello there")
        cut = cut.prefix(cut.count - 12) // the length says more than is left
        XCTAssertNil(AttributedBody.text(cut))
        XCTAssertNil(AttributedBody.text(Data("NSString".utf8) + Data([0x01, 0x94, 0x84, 0x01, 0x2B, 0x90])))
    }

    func testCleanDropsPlaceholdersAndNormalisesLines() {
        XCTAssertEqual(AttributedBody.clean("\u{FFFC} Photo\r\nnext\rline \u{0000}"), "Photo\nnext\nline")
        XCTAssertEqual(AttributedBody.clean(nil), "")
        XCTAssertEqual(AttributedBody.clean(String(repeating: "a", count: 25_000)).count, 20_000)
    }
}

final class AppleTimeTests: XCTestCase {
    func testNanosecondsAndSecondsSince2001() {
        // 2024-01-01T00:00:00Z is 725,760,000 s (8,400 days) after 2001-01-01.
        XCTAssertEqual(AppleTime.iso(AppleTime.messageDate(725_760_000)), "2024-01-01T00:00:00Z")
        XCTAssertEqual(AppleTime.iso(AppleTime.messageDate(725_760_000_000_000_000)), "2024-01-01T00:00:00Z")
        XCTAssertEqual(AppleTime.iso(AppleTime.date(seconds: 725_760_000.5)), "2024-01-01T00:00:00Z")
    }

    func testZeroAndNegativeAreNoDate() {
        XCTAssertNil(AppleTime.messageDate(0))
        XCTAssertNil(AppleTime.messageDate(-5))
        XCTAssertNil(AppleTime.date(seconds: .nan))
    }

    func testRoundTripToNanoseconds() {
        let d = AppleTime.parseISO("2026-11-05T10:00:00Z")!
        XCTAssertEqual(AppleTime.messageDate(AppleTime.nanoseconds(d)), d)
        XCTAssertEqual(AppleTime.parseISO("2026-11-05T10:00:00.123Z").map { Int($0.timeIntervalSince1970) }, Int(d.timeIntervalSince1970))
    }
}

final class CallsTests: XCTestCase {
    func rec(_ pk: Int64, type: Int64 = 1, out: Int64 = 0, answered: Int64 = 1, duration: Double = 61.6, address: String? = "+45 11 22 33 44") -> CallHistory.Record {
        CallHistory.Record(pk: pk, uniqueId: "U\(pk)", date: 725_760_000, duration: duration, originated: out, answered: answered,
                           callType: type, serviceProvider: "com.apple.Telephony", address: address, name: "Ida")
    }

    func testMapsDirectionServiceAndDuration() {
        let a = CallHistory.item(rec(1))!
        XCTAssertEqual(a.id, "U1"); XCTAssertEqual(a.at, "2024-01-01T00:00:00Z")
        XCTAssertEqual(a.direction, "in"); XCTAssertEqual(a.service, "phone"); XCTAssertEqual(a.durationSec, 62)
        XCTAssertEqual(CallHistory.item(rec(2, type: 8, out: 1))?.direction, "out")
        XCTAssertEqual(CallHistory.item(rec(2, type: 8, out: 1))?.service, "facetime_video")
        XCTAssertEqual(CallHistory.item(rec(3, type: 16))?.service, "facetime_audio")
        XCTAssertEqual(CallHistory.item(rec(4, answered: 0, duration: 0))?.direction, "missed")
    }

    func testNamesFromContactsWinAndNoHandleIsDropped() {
        XCTAssertEqual(CallHistory.item(rec(1), nameOf: { _ in "Ida Hansen" })?.name, "Ida Hansen")
        XCTAssertEqual(CallHistory.item(rec(1))?.name, "Ida")
        XCTAssertNil(CallHistory.item(rec(5, address: nil)))
        XCTAssertNil(CallHistory.item(CallHistory.Record(pk: 6, date: nil, address: "x")))
    }

    func testReadsAFixtureCallHistoryAfterTheCursor() throws {
        let path = try Fixture.database("CallHistory.storedata", sql: [
            "CREATE TABLE ZCALLRECORD (Z_PK INTEGER PRIMARY KEY, ZUNIQUE_ID TEXT, ZDATE TIMESTAMP, ZDURATION FLOAT, ZORIGINATED INTEGER, ZANSWERED INTEGER, ZCALLTYPE INTEGER, ZSERVICE_PROVIDER TEXT, ZADDRESS TEXT, ZNAME TEXT)",
            "INSERT INTO ZCALLRECORD VALUES (1,'A',725846400,30,0,1,1,'com.apple.Telephony','+4511223344','Ida')",
            "INSERT INTO ZCALLRECORD VALUES (2,'B',725846500,0,0,0,1,'com.apple.Telephony','+4599887766',NULL)",
            "INSERT INTO ZCALLRECORD VALUES (3,'C',725846600,120,1,1,16,'com.apple.FaceTime','ida@example.com',NULL)",
        ])
        let all = try CallHistory.read(path: path, afterPk: 0, since: nil).compactMap { CallHistory.item($0) }
        XCTAssertEqual(all.map(\.id), ["A", "B", "C"])
        XCTAssertEqual(all.map(\.direction), ["in", "missed", "out"])
        XCTAssertEqual(try CallHistory.read(path: path, afterPk: 2, since: nil).map(\.pk), [3])
        let since = AppleTime.date(seconds: 725_846_550)
        XCTAssertEqual(try CallHistory.read(path: path, afterPk: 0, since: since).map(\.pk), [3])
        XCTAssertEqual(try CallHistory.count(path: path), 3)
    }
}

final class MessagesTests: XCTestCase {
    func chatDB() throws -> String {
        try Fixture.database("chat.db", sql: [
            "CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT)",
            "CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, display_name TEXT, chat_identifier TEXT)",
            "CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, date INTEGER, is_from_me INTEGER, handle_id INTEGER, cache_has_attachments INTEGER, associated_message_type INTEGER, item_type INTEGER)",
            "CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER)",
            "CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER)",
            "CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, transfer_name TEXT, filename TEXT, mime_type TEXT)",
            "CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER)",
            "INSERT INTO handle VALUES (1,'+4511223344'),(2,'bo@example.com')",
            "INSERT INTO chat VALUES (1,'iMessage;-;+4511223344',NULL,'+4511223344'),(2,'iMessage;+;chat99','Familien','chat99'),(3,'iMessage;-;quiet',NULL,'quiet')",
            "INSERT INTO chat_handle_join VALUES (1,1),(2,1),(2,2)",
            "INSERT INTO message VALUES (1,'m1','Hej',NULL,\(Fixture.ns("2026-10-01T08:00:00Z")),0,1,0,0,0)",
            "INSERT INTO message VALUES (2,'m2','Hej selv',NULL,\(Fixture.ns("2026-10-01T08:01:00Z")),1,0,0,0,0)",
            "INSERT INTO message VALUES (4,'m4',NULL,NULL,\(Fixture.ns("2026-10-02T08:00:00Z")),0,2,1,0,0)",
            "INSERT INTO message VALUES (5,'m5','Loved “Hej”',NULL,\(Fixture.ns("2026-10-02T08:01:00Z")),0,1,0,2000,0)",
            "INSERT INTO message VALUES (6,'m6',NULL,NULL,\(Fixture.ns("2026-10-02T08:02:00Z")),0,2,0,0,1)",
            "INSERT INTO chat_message_join VALUES (1,1),(1,2),(2,3),(2,4),(1,5),(2,6)",
            "INSERT INTO attachment VALUES (1,'IMG_0001.HEIC','~/Library/Messages/Attachments/x/IMG_0001.HEIC','image/heic')",
            "INSERT INTO message_attachment_join VALUES (4,1)",
        ], blobs: [("INSERT INTO message VALUES (3,'m3',NULL,?,\(Fixture.ns("2026-10-01T09:00:00Z")),0,2,0,0,0)", [Fixture.attributedBody("Kommer I søndag?")])])
    }

    func testCatalogListsConversationsNewestFirstWithNames() throws {
        let r = try MessagesReader(path: try chatDB())
        let c = try r.catalog(nameOf: { $0 == "+4511223344" ? "Ida Hansen" : nil })
        XCTAssertEqual(c.first?.id, "iMessage;+;chat99")
        XCTAssertEqual(c.first?.name, "Familien")
        XCTAssertEqual(c.first?.participants.count, 2)
        let one = try XCTUnwrap(c.first { $0.id == "iMessage;-;+4511223344" })
        XCTAssertEqual(one.name, "Ida Hansen")
        XCTAssertEqual(one.count, 3)
        XCTAssertEqual(c.last?.id, "iMessage;-;quiet")
        XCTAssertEqual(c.last?.count, 0)
    }

    func testReadsOnlyChosenChatsSkipsTapbacksAndReadsAttributedBody() throws {
        let r = try MessagesReader(path: try chatDB())
        var got: [(String, Int64, MessageItem)] = []
        let n = try r.read(chats: ["iMessage;+;chat99"], fromRowId: 0, toRowId: try r.maxRowId(), since: nil) { got.append(($0, $1, $2)) }
        XCTAssertEqual(n, 2)
        XCTAssertEqual(got.map(\.1), [3, 4])
        XCTAssertEqual(got[0].2.text, "Kommer I søndag?")
        XCTAssertEqual(got[0].2.from, "bo@example.com")
        XCTAssertEqual(got[1].2.attachments, [MessageAttachment(filename: "IMG_0001.HEIC", mime: "image/heic")])
        XCTAssertEqual(got[0].2.at, "2026-10-01T09:00:00Z")
    }

    func testCursorWindowAndSince() throws {
        let r = try MessagesReader(path: try chatDB())
        var ids: [Int64] = []
        try r.read(chats: ["iMessage;-;+4511223344"], fromRowId: 1, toRowId: 6, since: nil) { _, id, _ in ids.append(id) }
        XCTAssertEqual(ids, [2]) // 5 is a tapback
        ids = []
        try r.read(chats: ["iMessage;-;+4511223344", "iMessage;+;chat99"], fromRowId: 0, toRowId: 6,
                   since: AppleTime.parseISO("2026-10-02T00:00:00Z")) { _, id, _ in ids.append(id) }
        XCTAssertEqual(ids, [4])
        XCTAssertEqual(try r.read(chats: [], fromRowId: 0, toRowId: 6, since: nil) { _, _, _ in }, 0)
    }

    func testMissingDatabaseIsMissingNotACrash() {
        XCTAssertThrowsError(try MessagesReader(path: "/nonexistent/folder/chat.db")) { e in
            XCTAssertEqual(e as? SQLiteReader.Failure, .missing("/nonexistent/folder/chat.db"))
        }
    }

    func testBatcherSplitsByBytesIntoContiguousRanges() {
        var b = MessageBatcher(maxBytes: 600, meta: { _ in (name: "Chat", participants: [MessageParticipant(handle: "+45", name: nil)]) })
        var done: [MessageBatcher.Batch] = []
        for i in 1...10 {
            let m = MessageItem(id: "m\(i)", at: "2026-10-01T08:00:00Z", from: "me", text: String(repeating: "x", count: 80))
            if let d = b.add(chat: i % 2 == 0 ? "a" : "b", rowId: Int64(i), message: m) { done.append(d) }
        }
        if let last = b.flush() { done.append(last) }
        XCTAssertGreaterThan(done.count, 1)
        XCTAssertEqual(done.reduce(0) { $0 + $1.count }, 10)
        XCTAssertEqual(done.first?.firstRowId, 1)
        for (x, y) in zip(done, done.dropFirst()) { XCTAssertEqual(x.lastRowId + 1, y.firstRowId) }
        for d in done {
            let size = (try? PhoneImportKit.encoder.encode(d.data).count) ?? 0
            XCTAssertLessThanOrEqual(size, 600)
        }
        XCTAssertNil(b.flush())
    }
}

final class BatchingTests: XCTestCase {
    func testBatchesStayUnderTheByteLimitAndKeepEveryItem() throws {
        let items = (0..<2000).map { CallItem(id: "c\($0)", at: "2026-11-01T09:12:00Z", durationSec: $0, direction: "in", handle: "+4511223344", name: "Ida", service: "phone") }
        let batches = PhoneImportKit.batches(items, maxBytes: 50_000, maxCount: 20_000)
        XCTAssertGreaterThan(batches.count, 1)
        XCTAssertEqual(batches.flatMap { $0 }.map(\.id), items.map(\.id))
        for b in batches {
            let body = try PhoneImportKit.encoder.encode(MacBatch(runId: UUID().uuidString, batch: "x", final: false, device: "Mac", data: CallsData(calls: b)))
            XCTAssertLessThanOrEqual(body.count, 50_000)
        }
    }

    func testEnvelopeShapeMatchesTheContract() throws {
        let b = MacBatch(runId: "6a0c4c9e-1111-4111-8111-111111111111", batch: "cal-1", final: true, device: "Ida's Mac",
                         data: RemindersData(reminders: [ReminderItem(id: "r1", list: "Home", title: "Fix bike", due: "2026-11-09T08:00:00Z", done: false, priority: 1)]))
        let o = try XCTUnwrap(JSONSerialization.jsonObject(with: PhoneImportKit.encoder.encode(b)) as? [String: Any])
        XCTAssertEqual(Set(o.keys), ["runId", "batch", "final", "device", "data"])
        let r = try XCTUnwrap(((o["data"] as? [String: Any])?["reminders"] as? [[String: Any]])?.first)
        XCTAssertEqual(Set(r.keys), ["id", "list", "title", "due", "done", "priority"])
    }

    func testBatchNamesAreWhatTheServerAccepts() {
        XCTAssertEqual(batchName("cal 2026/11 ø"), "cal-2026-11--")
        XCTAssertEqual(batchName(String(repeating: "a", count: 200)).count, 120)
        XCTAssertEqual(batchName(""), "batch")
    }

    func testBackoffGrowsAndIsCapped() {
        XCTAssertEqual(Backoff.delay(failures: 0), 0)
        XCTAssertEqual(Backoff.delay(failures: 1, random: 0.5), 60, accuracy: 0.001)
        XCTAssertEqual(Backoff.delay(failures: 3, random: 0.5), 240, accuracy: 0.001)
        XCTAssertEqual(Backoff.delay(failures: 30, random: 0.5), 6 * 3600, accuracy: 0.001)
    }
}

final class FileVersionsTests: XCTestCase {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    func obs(_ id: String, _ path: String, size: Int64 = 10, at: Date? = nil) -> FileObservation {
        FileObservation(observedId: id, relPath: path, size: size, modifiedAt: at ?? t0)
    }

    func testNewUnchangedMovedAndNewVersion() {
        let first = obs("f:V:1", "Docs/a.txt")
        XCTAssertEqual(FileVersions.decide(first, records: [:], liveIds: ["f:V:1"]), .upload(fileId: "f:V:1", newVersion: false, replacesKey: nil))
        let records = FileVersions.record(.upload(fileId: "f:V:1", newVersion: false, replacesKey: nil), first, into: [:])
        XCTAssertEqual(records["f:V:1"]?.versions, 1)
        XCTAssertEqual(FileVersions.decide(first, records: records, liveIds: ["f:V:1"]), .unchanged(fileId: "f:V:1"))
        XCTAssertEqual(FileVersions.decide(obs("f:V:1", "Docs/b.txt"), records: records, liveIds: ["f:V:1"]), .moved(fileId: "f:V:1"))
        let changed = obs("f:V:1", "Docs/a.txt", size: 12, at: t0.addingTimeInterval(60))
        let d = FileVersions.decide(changed, records: records, liveIds: ["f:V:1"])
        XCTAssertEqual(d, .upload(fileId: "f:V:1", newVersion: true, replacesKey: nil))
        XCTAssertEqual(FileVersions.record(d, changed, into: records)["f:V:1"]?.versions, 2)
    }

    func testSafeSaveWithANewInodeIsANewVersionOfTheSameFile() {
        let first = obs("f:V:1", "Docs/a.txt")
        let records = FileVersions.record(.upload(fileId: "f:V:1", newVersion: false, replacesKey: nil), first, into: [:])
        let saved = obs("f:V:2", "Docs/a.txt", size: 11, at: t0.addingTimeInterval(5))
        let d = FileVersions.decide(saved, records: records, liveIds: ["f:V:2"])
        XCTAssertEqual(d, .upload(fileId: "f:V:1", newVersion: true, replacesKey: "f:V:1"))
        let after = FileVersions.record(d, saved, into: records)
        XCTAssertNil(after["f:V:1"])
        XCTAssertEqual(after["f:V:2"]?.fileId, "f:V:1")
        XCTAssertEqual(after["f:V:2"]?.versions, 2)
        // A second file at another path stays its own file.
        XCTAssertEqual(FileVersions.decide(obs("f:V:3", "Docs/c.txt"), records: after, liveIds: ["f:V:2", "f:V:3"]),
                       .upload(fileId: "f:V:3", newVersion: false, replacesKey: nil))
    }

    func testWhatIsSkipped() {
        XCTAssertEqual(FileRules.skip(name: ".DS_Store", isRegularFile: true, isPackage: false, isHidden: true, size: 10), .hidden)
        XCTAssertEqual(FileRules.skip(name: "~$Report.docx", isRegularFile: true, isPackage: false, isHidden: false, size: 10), .temporary)
        XCTAssertEqual(FileRules.skip(name: "movie.mov.crdownload", isRegularFile: true, isPackage: false, isHidden: false, size: 10), .temporary)
        XCTAssertEqual(FileRules.skip(name: "Big.mov", isRegularFile: true, isPackage: false, isHidden: false, size: 51 * 1024 * 1024), .tooLarge)
        XCTAssertEqual(FileRules.skip(name: "Doc.pages", isRegularFile: false, isPackage: true, isHidden: false, size: 10), .package)
        XCTAssertEqual(FileRules.skip(name: "empty.txt", isRegularFile: true, isPackage: false, isHidden: false, size: 0), .empty)
        XCTAssertNil(FileRules.skip(name: "Taxes 2025.pdf", isRegularFile: true, isPackage: false, isHidden: false, size: 2_000))
        XCTAssertEqual(FileRules.fileId(volume: "ABC-1", inode: 42), "f:ABC-1:42")
        XCTAssertFalse(FileVersions.isSettled(modifiedAt: t0, now: t0.addingTimeInterval(1)))
        XCTAssertTrue(FileVersions.isSettled(modifiedAt: t0, now: t0.addingTimeInterval(4)))
    }
}

final class OutboxTests: XCTestCase {
    let now = AppleTime.parseISO("2026-11-05T10:00:00Z")!
    func reminder(_ id: String, title: String = "Buy milk", done: Bool = false, version: String = "1", deleted: Bool = false) -> OutboxItem {
        OutboxItem(id: id, kind: "reminder", op: deleted ? "delete" : "upsert", version: version, title: title, dueAt: "2026-11-07T09:00:00Z", completed: done)
    }
    func event(_ id: String, start: String = "2026-11-20T17:00:00Z", deleted: Bool = false) -> OutboxItem {
        OutboxItem(id: id, kind: "event", op: deleted ? "delete" : "upsert", version: "1", title: "Parents' evening", startAt: start,
                   endAt: start.replacingOccurrences(of: "17:00", with: "18:30"), allDay: false, completed: false)
    }

    func testNewItemsAreCreatedAndUnchangedOnesLeftAlone() {
        let r = reminder("r1"), e = event("e1")
        XCTAssertEqual(OutboxPlanner.plan(incoming: [r, e], links: [:], local: [:], now: now), [.create(r), .create(e)])
        let links = ["r1": OutboxLink(localId: "L1", item: r)]
        XCTAssertEqual(OutboxPlanner.plan(incoming: [r], links: links, local: ["L1": LocalItemState(exists: true)], now: now), [.nothing(serverId: "r1")])
    }

    func testChangedItemsAreUpdatedAndDeletedOnesRemoved() {
        let r = reminder("r1")
        let links = ["r1": OutboxLink(localId: "L1", item: r)]
        let renamed = reminder("r1", title: "Buy oat milk", version: "2")
        XCTAssertEqual(OutboxPlanner.plan(incoming: [renamed], links: links, local: ["L1": LocalItemState(exists: true)], now: now),
                       [.update(localId: "L1", renamed)])
        XCTAssertEqual(OutboxPlanner.plan(incoming: [reminder("r1", deleted: true)], links: links, local: ["L1": LocalItemState(exists: true)], now: now),
                       [.delete(localId: "L1", serverId: "r1")])
        XCTAssertEqual(OutboxPlanner.plan(incoming: [reminder("r9", deleted: true)], links: links, local: ["L1": LocalItemState(exists: true)], now: now),
                       [.nothing(serverId: "r9")])
    }

    func testTickedDoneOnTheMacIsReportedOnce() {
        let r = reminder("r1")
        var link = OutboxLink(localId: "L1", item: r)
        let done = LocalItemState(exists: true, completed: true, completedAt: now)
        XCTAssertEqual(OutboxPlanner.plan(incoming: [], links: ["r1": link], local: ["L1": done], now: now), [.reportCompleted(serverId: "r1", at: now)])
        link.completedReported = true
        XCTAssertEqual(OutboxPlanner.plan(incoming: [], links: ["r1": link], local: ["L1": done], now: now), [])
    }

    func testATickBeatsAnOlderChangeFromTheServer() {
        let r = reminder("r1")
        let link = OutboxLink(localId: "L1", item: r)
        let changed = reminder("r1", title: "Buy oat milk", version: "2")
        var kept = changed; kept.completed = true
        XCTAssertEqual(OutboxPlanner.plan(incoming: [changed], links: ["r1": link], local: ["L1": LocalItemState(exists: true, completed: true, completedAt: now)], now: now),
                       [.reportCompleted(serverId: "r1", at: now), .update(localId: "L1", kept)])
    }

    func testAReminderDeletedInRemindersIsNotPutBack() {
        let r = reminder("r1")
        var link = OutboxLink(localId: "L1", item: r)
        XCTAssertEqual(OutboxPlanner.plan(incoming: [], links: ["r1": link], local: [:], now: now), [.reportDeleted(serverId: "r1")])
        link.deletedLocally = true
        XCTAssertEqual(OutboxPlanner.plan(incoming: [], links: ["r1": link], local: [:], now: now), [])
        XCTAssertEqual(OutboxPlanner.plan(incoming: [reminder("r1", version: "2")], links: ["r1": link], local: [:], now: now), [.nothing(serverId: "r1")])
    }

    func testAnEventDeletedFromTheMyGraphCalendarIsWrittenAgainButOnlyUpcoming() {
        let e = event("e1")
        let link = OutboxLink(localId: "L2", item: e)
        XCTAssertEqual(OutboxPlanner.plan(incoming: [], links: ["e1": link], local: ["L2": LocalItemState(exists: false)], now: now), [.recreate(e)])
        let past = event("e2", start: "2026-11-01T17:00:00Z")
        XCTAssertEqual(OutboxPlanner.plan(incoming: [], links: ["e2": OutboxLink(localId: "L3", item: past)], local: [:], now: now), [])
    }

    func testOutboxWireMapsToItems() throws {
        let json = """
        {"items":[{"id":"4c39","kind":"reminder","title":"Buy milk","dueAt":"2026-11-07T09:00:00.000Z","done":true,"deleted":false,"updatedAt":"2026-11-05T10:26:17.085Z","url":"https://x/?reminder=4c39"},
                  {"id":"77aa","kind":"reminder","title":"Old","done":false,"deleted":true,"updatedAt":"t2","url":"u"}],"cursor":"38"}
        """
        struct Page: Decodable { let items: [OutboxWire]; let cursor: String? }
        let page = try JSONDecoder().decode(Page.self, from: Data(json.utf8))
        XCTAssertEqual(page.cursor, "38")
        XCTAssertEqual(page.items[0].item.completed, true)
        XCTAssertEqual(page.items[0].item.op, "upsert")
        XCTAssertEqual(page.items[0].item.version, "2026-11-05T10:26:17.085Z")
        XCTAssertEqual(page.items[1].item.op, "delete")
    }
}

final class SettingsShapeTests: XCTestCase {
    func testReadsTheContractsSettings() {
        let json = """
        {"connectionId":"e4","label":"My Graph for Mac","visibility":"private","maxBatchBytes":5000000,
         "messages":{"enabled":true,"chats":["c1"],"backfill":["c1"],"cursor":120,"since":"2025-11-04T10:25:15.160Z","generation":2},
         "notes":{"enabled":false,"folders":null,"cursor":null,"generation":0},
         "sources":{"messages":true,"notes":false,"contacts":true,"calendar":false,"reminders":true,"photos":false,"files":true,"voiceMemos":false,"calls":true},
         "writeBack":{"reminders":true,"events":false},"folders":["Documents/Taxes"],"graph":{"id":"g1","name":"Family","kind":"family"},
         "cursors":{"calls":"2026-11-01T09:12:00.000Z"},"uploadMaxBytes":52428800}
        """
        let s = MacSettings(json: Data(json.utf8))
        XCTAssertTrue(s.isOn(.messages)); XCTAssertTrue(s.isOn(.contacts)); XCTAssertTrue(s.isOn(.folders)); XCTAssertTrue(s.isOn(.calls))
        XCTAssertFalse(s.isOn(.notes)); XCTAssertFalse(s.isOn(.voiceMemos))
        XCTAssertEqual(s.chats, ["c1"]); XCTAssertEqual(s.serverCursor[.messages], "120"); XCTAssertEqual(s.generation[.messages], 2)
        XCTAssertNil(s.noteFolders)
        XCTAssertTrue(s.writeBackReminders); XCTAssertFalse(s.writeBackEvents)
        XCTAssertEqual(s.folderLabels, ["Documents/Taxes"])
        XCTAssertEqual(s.graphName, "Family")
        XCTAssertEqual(AppleTime.iso(s.callsSince), "2026-11-01T09:12:00Z")
        XCTAssertEqual(s.maxBatchBytes, 5_000_000)
        XCTAssertEqual(SourceID.folders.serverKey, "files")
        XCTAssertEqual(SourceID(serverKey: "voiceMemos"), .voiceMemos)
    }

    func testReadsTheStatus() {
        let json = """
        {"waiting":3,"lastImports":[{"sourceId":"68e1","title":"Reminders from Ida's MacBook Air: 2 reminders","kind":"reminders","status":"processing","at":"2026-11-05T10:26:18.286Z"}],
         "graph":{"id":"g","name":"Family"},"connection":{"id":"c","status":"ok"}}
        """
        let s = MacStatus(json: Data(json.utf8))
        XCTAssertEqual(s.waiting, 3)
        XCTAssertEqual(s.lastImports.first?.kind, "reminders")
        XCTAssertEqual(s.connectionStatus, "ok")
    }
}

final class NotesPickTests: XCTestCase {
    func testPicksChangedNotesInChosenFoldersOnly() {
        let d = { (s: String) in AppleTime.parseISO(s)! }
        let folders = [
            NotesPick.Folder(id: "f1", name: "Family", notes: [
                .init(id: "n1", title: "Old", createdAt: nil, updatedAt: d("2026-01-01T00:00:00Z"), locked: false),
                .init(id: "n2", title: "New", createdAt: nil, updatedAt: d("2026-10-01T00:00:00Z"), locked: false),
                .init(id: "n3", title: "Secret", createdAt: nil, updatedAt: d("2026-10-02T00:00:00Z"), locked: true),
            ]),
            NotesPick.Folder(id: "f2", name: "Work", notes: [.init(id: "n4", title: "W", createdAt: nil, updatedAt: d("2026-10-03T00:00:00Z"), locked: false)]),
            NotesPick.Folder(id: "f3", name: "Senest slettet", notes: [.init(id: "n5", title: "Gone", createdAt: nil, updatedAt: d("2026-10-04T00:00:00Z"), locked: false)]),
        ]
        let r = NotesPick.pick(folders, allowed: ["Family"], cursor: d("2026-06-01T00:00:00Z"))
        XCTAssertEqual(r.picked.map(\.note.id), ["n2"])
        XCTAssertEqual(r.newest, d("2026-10-01T00:00:00Z")) // locked notes never move the cursor
        XCTAssertEqual(NotesPick.pick(folders, allowed: nil, cursor: nil).picked.map(\.note.id), ["n1", "n2", "n4"])
        XCTAssertEqual(NotesPick.counts(folders).map(\.name), ["Family", "Work"])
    }
}
