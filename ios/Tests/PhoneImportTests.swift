import XCTest
import Contacts
import HealthKit
import ImageIO
import UniformTypeIdentifiers
@testable import MyGraph

/// "Bring in from this iPhone": what is sent to /api/import/<importer>, checked against src/lib/importers/schemas.ts.
final class PhoneImportTests: XCTestCase {
    private func json(_ v: some Encodable) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: PhoneImportKit.encoder.encode(v)) as? [String: Any])
    }

    // MARK: Contacts

    func testAContactCardBecomesTheSchemasShape() throws {
        let c = CNMutableContact()
        c.givenName = "Ida"; c.familyName = "Hansen"; c.nickname = "Mor"
        c.emailAddresses = [CNLabeledValue(label: CNLabelHome, value: "ida@example.dk" as NSString)]
        c.phoneNumbers = [CNLabeledValue(label: CNLabelPhoneNumberMobile, value: CNPhoneNumber(stringValue: "+45 12 34 56 78"))]
        c.birthday = DateComponents(year: 1961, month: 3, day: 9)
        let a = CNMutablePostalAddress(); a.street = "Nørregade 1"; a.city = "Aarhus"; a.postalCode = "8000"; a.country = "Danmark"
        c.postalAddresses = [CNLabeledValue(label: CNLabelHome, value: a)]
        c.organizationName = "Skolen"; c.jobTitle = "Lærer"
        c.contactRelations = [CNLabeledValue(label: CNLabelContactRelationMother, value: CNContactRelation(name: "Else Hansen")),
                              CNLabeledValue(label: "bonusmor", value: CNContactRelation(name: "Grete"))]
        let item = try XCTUnwrap(ContactsSource.item(from: c))
        XCTAssertEqual(item.name, "Ida Hansen")
        XCTAssertEqual(item.givenName, "Ida")
        XCTAssertEqual(item.nickname, "Mor")
        XCTAssertEqual(item.emails.first?.value, "ida@example.dk")
        XCTAssertEqual(item.emails.first?.label, CNLabeledValue<NSString>.localizedString(forLabel: CNLabelHome))
        XCTAssertEqual(item.phones.first?.value, "+45 12 34 56 78")
        XCTAssertEqual(item.birthday, "1961-03-09")
        XCTAssertEqual(item.addresses, [ContactAddress(label: CNLabeledValue<NSString>.localizedString(forLabel: CNLabelHome), street: "Nørregade 1", city: "Aarhus", postalCode: "8000", country: "Danmark")])
        XCTAssertEqual(item.organization, "Skolen")
        XCTAssertEqual(item.jobTitle, "Lærer")
        XCTAssertEqual(item.related.map(\.name), ["Else Hansen", "Grete"])
        XCTAssertEqual(item.related[0].label, CNLabeledValue<NSString>.localizedString(forLabel: CNLabelContactRelationMother))
        XCTAssertEqual(item.related[1].label, "bonusmor", "a custom label is kept as written")
        XCTAssertNil(item.note)

        let obj = try json(ContactsData(contacts: [item]))
        let first = try XCTUnwrap((obj["contacts"] as? [[String: Any]])?.first)
        XCTAssertNil(first["note"], "absent fields are left out, not null")
        XCTAssertEqual(first["familyName"] as? String, "Hansen")
    }

    func testBirthdayWithAndWithoutYear() {
        XCTAssertEqual(PhoneImportKit.birthday(DateComponents(year: 2015, month: 12, day: 1)), "2015-12-01")
        XCTAssertEqual(PhoneImportKit.birthday(DateComponents(month: 2, day: 29)), "--02-29")
        var noYear = DateComponents(month: 7, day: 4); noYear.year = NSDateComponentUndefined
        XCTAssertEqual(PhoneImportKit.birthday(noYear), "--07-04")
        XCTAssertNil(PhoneImportKit.birthday(DateComponents(year: 2000)))
        XCTAssertNil(PhoneImportKit.birthday(nil))
        // The schema's regex (src/lib/importers/schemas.ts).
        let pattern = try! NSRegularExpression(pattern: "^(\\d{4}-|--)\\d{2}-\\d{2}$")
        for s in ["2015-12-01", "--02-29"] { XCTAssertNotNil(pattern.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)), s) }
    }

    func testACardWithoutAnyNameIsSkippedAndACompanyCardUsesItsCompany() {
        XCTAssertNil(ContactsSource.item(from: CNMutableContact()))
        let c = CNMutableContact(); c.organizationName = "Tandlægen"; c.contactType = .organization
        XCTAssertEqual(ContactsSource.item(from: c)?.name, "Tandlægen")
    }

    func testLongTextIsCutToTheSchemasLimitWithoutSplittingACharacter() {
        let s = String(repeating: "å", count: 150) + String(repeating: "👨‍👩‍👧", count: 40)
        let out = PhoneImportKit.clip(s, 200)!
        XCTAssertLessThanOrEqual(out.utf16.count, 200)
        XCTAssertTrue(s.hasPrefix(out))
        XCTAssertNil(PhoneImportKit.clip("   ", 10))
    }

    // MARK: What changed, batching

    func testOnlyChangedItemsAreSentAgain() {
        let a = ContactItem(id: "1", name: "Anna"), b = ContactItem(id: "2", name: "Bo")
        var ledger: [String: String] = [:]
        XCTAssertEqual(PhoneImportKit.changed([a, b], id: \.id, ledger: ledger).count, 2)
        for x in [a, b] { ledger[x.id] = PhoneImportKit.fingerprint(x) }
        XCTAssertTrue(PhoneImportKit.changed([a, b], id: \.id, ledger: ledger).isEmpty)
        var b2 = b; b2.phones = [ImportLabelled(label: nil, value: "12345678")]
        XCTAssertEqual(PhoneImportKit.changed([a, b2], id: \.id, ledger: ledger).map(\.id), ["2"])
    }

    func testBatchesStayUnderTenMegabytesAndTheItemLimit() throws {
        let note = String(repeating: "x", count: 4000)
        let items = (0..<6000).map { ContactItem(id: "id-\($0)", name: "Person \($0)", note: note) }
        let batches = PhoneImportKit.batches(items, maxCount: 20_000)
        XCTAssertGreaterThan(batches.count, 2)
        XCTAssertEqual(batches.flatMap { $0 }.map(\.id), items.map(\.id), "every item once, in order")
        for b in batches {
            let body = try PhoneImportKit.body(title: "Contacts from this iPhone", visibility: "private", data: ContactsData(contacts: b))
            XCTAssertLessThan(body.count, 10 * 1024 * 1024)
        }
        let small = (0..<25).map { ContactItem(id: "\($0)", name: "P\($0)") }
        XCTAssertEqual(PhoneImportKit.batches(small, maxCount: 10).map(\.count), [10, 10, 5])
    }

    func testTheEnvelopeCarriesTitleVisibilityAndData() throws {
        let body = try PhoneImportKit.body(title: "Health from this iPhone", visibility: "private",
                                           data: AnyEncodable(HealthData(records: [HealthItem(id: "x", type: .vaccination, name: "MFR")])))
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(obj["visibility"] as? String, "private")
        let rec = try XCTUnwrap(((obj["data"] as? [String: Any])?["records"] as? [[String: Any]])?.first)
        XCTAssertEqual(rec["type"] as? String, "vaccination")
    }

    // MARK: Photos

    func testPhotoDetailsBecomeThePayload() throws {
        let m = PhotoMeta(id: "ABC/L0/001", takenAt: Date(timeIntervalSince1970: 1_718_985_851), lat: 56.15, lon: 10.2,
                          albums: ["Sommer", "Sommer", "Familie"], favorite: true, sourceId: "0b8f8a3e-2a0c-4c39-9a3e-5d3c1f1f2a10")
        let item = m.item
        XCTAssertEqual(item.id, "ABC/L0/001")
        XCTAssertEqual(item.takenAt, "2024-06-21T16:04:11Z")
        XCTAssertEqual(item.albums, ["Sommer", "Familie"])
        XCTAssertEqual(item.favorite, true)
        XCTAssertEqual(item.sourceId, "0b8f8a3e-2a0c-4c39-9a3e-5d3c1f1f2a10")
        let noPlace = PhotoMeta(id: "x", lat: 0, lon: 0).item
        XCTAssertNil(noPlace.lat); XCTAssertNil(noPlace.lon); XCTAssertNil(noPlace.takenAt)
        let obj = try json(PhotosData(photos: [noPlace]))
        XCTAssertEqual((obj["photos"] as? [[String: Any]])?.first?.keys.sorted(), ["albums", "id"])
    }

    func testExifDateHonoursItsOffset() {
        let d = PhotosSource.exifDate("2024:06:21 18:04:11", offset: "+02:00")
        XCTAssertEqual(PhoneImportKit.iso(d), "2024-06-21T16:04:11Z")
    }

    func testAPhotoIsReadyToUploadAndHEICBecomesJPEGWithItsPlace() throws {
        let heic = try makeImage(type: .heic, size: 64, gps: (55.676, 12.568))
        let out = try XCTUnwrap(PhotosSource.prepare(heic, type: .heic))
        XCTAssertEqual(out.mime, "image/jpeg")
        XCTAssertEqual(out.ext, "jpg")
        let meta = PhotosSource.exifMeta(out.data, id: "p")
        XCTAssertEqual(try XCTUnwrap(meta.lat), 55.676, accuracy: 0.001)
        XCTAssertEqual(try XCTUnwrap(meta.lon), 12.568, accuracy: 0.001)
        let jpeg = try makeImage(type: .jpeg, size: 32, gps: nil)
        XCTAssertEqual(PhotosSource.prepare(jpeg, type: .jpeg)?.data, jpeg, "a small JPEG goes as it is")
    }

    private func makeImage(type: UTType, size: Int, gps: (Double, Double)?) throws -> Data {
        let ctx = try XCTUnwrap(CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                                          space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        ctx.setFillColor(red: 0.2, green: 0.5, blue: 0.3, alpha: 1); ctx.fill(CGRect(x: 0, y: 0, width: size, height: size))
        let img = try XCTUnwrap(ctx.makeImage())
        let data = NSMutableData()
        let dest = try XCTUnwrap(CGImageDestinationCreateWithData(data, type.identifier as CFString, 1, nil))
        var props: [CFString: Any] = [:]
        if let gps {
            props[kCGImagePropertyGPSDictionary] = [kCGImagePropertyGPSLatitude: gps.0, kCGImagePropertyGPSLatitudeRef: "N",
                                                    kCGImagePropertyGPSLongitude: gps.1, kCGImagePropertyGPSLongitudeRef: "E"]
        }
        CGImageDestinationAddImage(dest, img, props as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { throw XCTSkip("This simulator can't write \(type.identifier)") }
        return data as Data
    }

    // MARK: Places

    func testAVisitBecomesThePayloadAndItsDepartureUpdatesTheSameVisit() throws {
        let arrival = Date(timeIntervalSince1970: 1_730_793_600) // 2024-11-05T08:00:00Z
        let open = try XCTUnwrap(StoredVisit.from(arrival: arrival, departure: .distantFuture, lat: 56.1572, lon: 10.2107, accuracy: 35))
        XCTAssertNil(open.departure)
        XCTAssertEqual(open.item, VisitItem(arrival: "2024-11-05T08:00:00Z", departure: nil, lat: 56.1572, lon: 10.2107, accuracyM: 35))
        var log = VisitLog.record(open, into: [])
        let closed = try XCTUnwrap(StoredVisit.from(arrival: arrival, departure: arrival.addingTimeInterval(3600), lat: 56.1572, lon: 10.2107, accuracy: 35))
        log = VisitLog.record(closed, into: log)
        XCTAssertEqual(log.count, 1)
        XCTAssertEqual(log[0].item.departure, "2024-11-05T09:00:00Z")
        XCTAssertEqual(open.item.key, closed.item.key, "the same visit keeps its key")
        XCTAssertNotEqual(PhoneImportKit.fingerprint(open.item), PhoneImportKit.fingerprint(closed.item), "so its departure is sent again")
    }

    func testVisitsWithoutAUsableTimeOrPlaceAreDropped() {
        XCTAssertNil(StoredVisit.from(arrival: .distantPast, departure: .distantFuture, lat: 56, lon: 10, accuracy: 10))
        XCTAssertNil(StoredVisit.from(arrival: Date(), departure: .distantFuture, lat: 0, lon: 0, accuracy: 10))
        let late = StoredVisit.from(arrival: .distantPast, departure: Date(timeIntervalSince1970: 0), lat: 56, lon: 10, accuracy: -1)
        XCTAssertEqual(late?.arrival, Date(timeIntervalSince1970: 0), "a visit that began before monitoring starts at its departure")
        XCTAssertNil(late?.accuracyM)
    }

    // MARK: Health

    func testALatestMeasurementBecomesARecord() throws {
        let type = try XCTUnwrap(HKQuantityType.quantityType(forIdentifier: .bodyMass))
        let at = Date(timeIntervalSince1970: 1_730_793_600)
        let s = HKQuantitySample(type: type, quantity: HKQuantity(unit: .gramUnit(with: .kilo), doubleValue: 71.84), start: at, end: at)
        let r = HealthSource.item(from: s, name: "Weight", unit: .gramUnit(with: .kilo), unitLabel: "kg")
        XCTAssertEqual(r.type, .measurement)
        XCTAssertEqual(r.name, "Weight")
        XCTAssertEqual(r.value, 71.8)
        XCTAssertEqual(r.unit, "kg")
        XCTAssertEqual(r.at, "2024-11-05T08:00:00Z")
        XCTAssertEqual(r.id, s.uuid.uuidString)
    }

    func testHealthRecordsReadTheirDateValueAndNoteFromFHIR() throws {
        let imm = #"{"resourceType":"Immunization","status":"completed","occurrenceDateTime":"2019-04-02","vaccineCode":{"text":"MMR"}}"#
        let f = FHIRSummary.parse(Data(imm.utf8))
        XCTAssertEqual(PhoneImportKit.iso(f.date), "2019-04-02T00:00:00Z")
        let r = HealthSource.item(id: "rec-1", kind: .vaccination, name: "MMR", fhir: f, fallbackDate: nil)
        XCTAssertEqual(r.type, .vaccination)
        XCTAssertEqual(r.note, "completed")

        let lab = #"{"resourceType":"Observation","effectiveDateTime":"2023-01-15T09:30:00+01:00","valueQuantity":{"value":5.4,"unit":"mmol/L"}}"#
        let l = FHIRSummary.parse(Data(lab.utf8))
        XCTAssertEqual(PhoneImportKit.iso(l.date), "2023-01-15T08:30:00Z")
        XCTAssertEqual(l.value, 5.4)
        XCTAssertEqual(l.unit, "mmol/L")

        let allergy = #"{"resourceType":"AllergyIntolerance","clinicalStatus":{"coding":[{"code":"active"}]},"recordedDate":"2010","reaction":[{"manifestation":[{"text":"Hives"}]}]}"#
        let a = FHIRSummary.parse(Data(allergy.utf8))
        XCTAssertEqual(a.note, "active · Hives")
        XCTAssertEqual(PhoneImportKit.iso(a.date), "2010-01-01T00:00:00Z")

        let fallback = Date(timeIntervalSince1970: 1_600_000_000)
        XCTAssertEqual(HealthSource.item(id: "x", kind: .condition, name: "", fhir: FHIRSummary.parse(nil), fallbackDate: fallback).at,
                       PhoneImportKit.iso(fallback))
    }
}
