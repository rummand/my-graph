import XCTest
import UniformTypeIdentifiers
@testable import MyGraph

/// What "Send to My Graph" and Paste send, and how: files upload, links become saved web pages, text becomes a note.
final class SendKitTests: XCTestCase {
    private func file(_ name: String, _ mime: String, _ bytes: Int = 4) -> UploadFile {
        UploadFile(filename: name, mime: mime, data: Data(repeating: 1, count: bytes))
    }

    func testTextThatIsOnlyAWebAddressBecomesALink() {
        let out = SendKit.plan(files: [], urls: [], texts: ["  https://aula.dk/portal/#/news  "])
        XCTAssertEqual(out, [.link(URL(string: "https://aula.dk/portal/#/news")!, title: nil)])
    }

    func testOtherTextBecomesOneNoteTitledByItsFirstLine() {
        let out = SendKit.plan(files: [], urls: [], texts: ["Madpakke fredag\nHusk gummistøvler", "Bus kl. 8"])
        guard case .note(let title, let text) = out.first, out.count == 1 else { return XCTFail("\(out)") }
        XCTAssertEqual(title, "Madpakke fredag")
        XCTAssertEqual(text, "Madpakke fredag\nHusk gummistøvler\n\nBus kl. 8")
    }

    func testASharedLinkTakesThePageTitleAndDropsTextThatRepeatsIt() {
        let u = URL(string: "https://example.com/trip")!
        let out = SendKit.plan(files: [], urls: [u], texts: ["School trip to Lindholm https://example.com/trip"], title: "School trip to Lindholm")
        XCTAssertEqual(out, [.link(u, title: "School trip to Lindholm")])
    }

    func testFilesStayFilesAndComeFirst() {
        let pdf = file("Brev.pdf", "application/pdf")
        let pptx = file("Møde.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation")
        let out = SendKit.plan(files: [pdf, pptx], urls: [URL(string: "https://dr.dk")!], texts: ["Hello"])
        XCTAssertEqual(out.count, 4)
        XCTAssertEqual(out[0], .file(pdf)); XCTAssertEqual(out[1], .file(pptx))
        if case .link = out[2] {} else { XCTFail("third should be the link") }
        if case .note = out[3] {} else { XCTFail("fourth should be the note") }
        XCTAssertEqual(out[1].icon, "rectangle.on.rectangle")
    }

    func testOnlyWebAddressesCount() {
        XCTAssertNil(SendKit.webURL(in: "ftp://example.com/x"))
        XCTAssertNil(SendKit.webURL(in: "see https://example.com"))
        XCTAssertNil(SendKit.webURL(in: "mailto:anna@example.com"))
        XCTAssertNotNil(SendKit.webURL(in: "http://localhost:3917/library"))
    }

    func testLongTitlesAreCutAtAWord() {
        let t = SendKit.noteTitle(String(repeating: "word ", count: 30))
        XCTAssertTrue(t.hasSuffix("…"))
        XCTAssertLessThanOrEqual(t.count, 61)
        XCTAssertFalse(SendKit.noteTitle("\n\n   \n").isEmpty)
    }

    func testPasteBodiesMatchTheServerRoute() {
        let note = SendKit.pasteBody(.note(title: "Bus", text: "Bus kl. 8"), visibility: "household")!
        XCTAssertEqual(note["kind"] as? String, "text")
        XCTAssertEqual(note["title"] as? String, "Bus")
        XCTAssertEqual(note["text"] as? String, "Bus kl. 8")
        XCTAssertEqual(note["visibility"] as? String, "household")
        XCTAssertEqual(note["sensitive"] as? Bool, false)
        // The route is .strict(): no other keys.
        XCTAssertEqual(Set(note.keys), ["kind", "title", "text", "visibility", "sensitive"])

        let link = SendKit.pasteBody(.link(URL(string: "https://dr.dk/a")!, title: nil), visibility: "private")!
        XCTAssertEqual(Set(link.keys), ["kind", "url", "visibility", "sensitive"])
        XCTAssertEqual(link["url"] as? String, "https://dr.dk/a")
        let titled = SendKit.pasteBody(.link(URL(string: "https://dr.dk/a")!, title: "Nyheder"), visibility: "private")!
        XCTAssertEqual(titled["title"] as? String, "Nyheder")
        XCTAssertNil(SendKit.pasteBody(.file(file("a.pdf", "application/pdf")), visibility: "private"))
    }

    func testFileNamesKeepTheirExtensionAndMime() {
        let a = SendKit.fileInfo(suggested: "Regnskab", url: URL(fileURLWithPath: "/tmp/x/Regnskab.xlsx"), type: nil)
        XCTAssertEqual(a.name, "Regnskab.xlsx")
        XCTAssertEqual(a.mime, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        let b = SendKit.fileInfo(suggested: nil, url: nil, type: .jpeg)
        XCTAssertTrue(b.name.hasSuffix(".jpeg") || b.name.hasSuffix(".jpg"))
        XCTAssertEqual(b.mime, "image/jpeg")
        let c = SendKit.fileInfo(suggested: "a/b.docx", url: nil, type: UTType("org.openxmlformats.wordprocessingml.document"))
        XCTAssertEqual(c.name, "a-b.docx")
    }

    func testUploadsAreSplitIntoTwenties() {
        let files = (1...45).map { file("\($0).txt", "text/plain") }
        XCTAssertEqual(SendKit.batches(files).map(\.count), [20, 20, 5])
    }

    /// Reads real item providers the way the share sheet and the pasteboard hand them over.
    func testLoadingProviders() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let pdfURL = dir.appendingPathComponent("Invitation.pdf")
        try Data("%PDF-1.4\n%test".utf8).write(to: pdfURL)
        let pdf = NSItemProvider(contentsOf: pdfURL)!
        let text = NSItemProvider(object: "Remember the swimming bag" as NSString)
        let link = NSItemProvider(object: URL(string: "https://www.aula.dk/")! as NSURL)
        let (items, skipped) = await SendKit.load([pdf, text, link])
        XCTAssertTrue(skipped.isEmpty)
        XCTAssertEqual(items.count, 3, "\(items)")
        guard case .file(let f) = items[0] else { return XCTFail("first should be the PDF: \(items)") }
        XCTAssertEqual(f.filename, "Invitation.pdf")
        XCTAssertEqual(f.mime, "application/pdf")
        XCTAssertEqual(items[1], .link(URL(string: "https://www.aula.dk/")!, title: nil))
        XCTAssertEqual(items[2], .note(title: "Remember the swimming bag", text: "Remember the swimming bag"))
    }
}

extension SendKitTests {
    /// Text shared only as the item's content text (no attachment) still becomes a note.
    func testContentTextAloneBecomesANote() async {
        let (items, _) = await SendKit.load([], title: "Shared note 1: bring the blue lunch box")
        XCTAssertEqual(items, [.note(title: "Shared note 1: bring the blue lunch box", text: "Shared note 1: bring the blue lunch box")])
    }
}

final class DictationTests: XCTestCase {
    func testLocales() {
        XCTAssertEqual(Dictation.localeId(for: .da, region: "DK"), "da-DK")
        XCTAssertEqual(Dictation.localeId(for: .en, region: "US"), "en-US")
        XCTAssertEqual(Dictation.localeId(for: .en, region: "DK"), "en-GB")
        XCTAssertEqual(Dictation.localeId(for: .en, region: nil), "en-GB")
    }

    func testHeardTextGoesAfterWhatWasTyped() {
        XCTAssertEqual(Dictation.join("", "Hvornår er turen"), "Hvornår er turen")
        XCTAssertEqual(Dictation.join("@Emma", "hvornår"), "@Emma hvornår")
        XCTAssertEqual(Dictation.join("@Emma ", "hvornår"), "@Emma hvornår")
        XCTAssertEqual(Dictation.join("typed", ""), "typed")
    }
}
