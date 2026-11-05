import Foundation
import CryptoKit

/// "Bring in from this iPhone": the JSON shapes sent to `POST /api/import/<importer>` and the pure rules around them
/// (limits, dates, batching, what changed since the last send). The shapes mirror `src/lib/importers/schemas.ts`
/// exactly; field names and limits must stay in step with it. Unit-tested in `Tests/PhoneImportTests.swift`.
enum PhoneImporter: String, CaseIterable, Codable, Identifiable {
    case contacts, photos, places, health
    var id: String { rawValue }

    /// The most items one batch may carry (the schema's `max`).
    var maxItems: Int {
        switch self {
        case .contacts, .photos, .health: return 20_000
        case .places: return 50_000
        }
    }
}

// MARK: - Payload items (schemas.ts)

struct ImportLabelled: Codable, Equatable, Hashable {
    var label: String?
    var value: String
}

struct ContactAddress: Codable, Equatable, Hashable {
    var label: String?
    var street: String?
    var city: String?
    var postalCode: String?
    var country: String?
}

struct ContactRelated: Codable, Equatable, Hashable {
    var label: String
    var name: String
}

/// One contact card (`contactsPayload.contacts[]`).
struct ContactItem: Codable, Equatable, Identifiable {
    var id: String
    var name: String
    var givenName: String?
    var familyName: String?
    var nickname: String?
    var emails: [ImportLabelled] = []
    var phones: [ImportLabelled] = []
    /// "YYYY-MM-DD", or "--MM-DD" when the year isn't known.
    var birthday: String?
    var addresses: [ContactAddress] = []
    var organization: String?
    var jobTitle: String?
    var related: [ContactRelated] = []
    var note: String?
}

/// One photo's metadata (`photosPayload.photos[]`).
struct PhotoItem: Codable, Equatable, Identifiable {
    var id: String
    var takenAt: String?
    var lat: Double?
    var lon: Double?
    var placeName: String?
    var albums: [String] = []
    var favorite: Bool?
    var sourceId: String?
}

/// One visit (`placesPayload.visits[]`).
struct VisitItem: Codable, Equatable {
    var arrival: String
    var departure: String?
    var lat: Double
    var lon: Double
    var accuracyM: Double?
    var placeName: String?

    /// The same visit, whatever was added to it later (its departure, its name).
    var key: String { arrival + "@" + String(format: "%.4f,%.4f", lat, lon) }
}

/// One health record (`healthPayload.records[]`).
struct HealthItem: Codable, Equatable, Identifiable {
    enum Kind: String, Codable { case vaccination, condition, medication, allergy, lab, measurement, procedure, visit }
    var id: String
    var type: Kind
    var name: String
    var at: String?
    var value: Double?
    var unit: String?
    var note: String?
}

struct ContactsData: Encodable { let contacts: [ContactItem] }
struct PhotosData: Encodable { let photos: [PhotoItem] }
struct PlacesData: Encodable { let visits: [VisitItem] }
struct HealthData: Encodable { let records: [HealthItem] }

/// The request body: `{ title?, visibility?, data }`.
struct ImportEnvelope<D: Encodable>: Encodable {
    let title: String?
    let visibility: String?
    let data: D
}

// MARK: - Pure rules

enum PhoneImportKit {
    /// The server refuses bodies over 10 MB (10 × 1024 × 1024). Batches stay well under it, leaving room for the
    /// envelope and for JSON escaping differences.
    static let maxBatchBytes = 9 * 1024 * 1024

    /// Text cut to the schema's `max` (JavaScript string length, so UTF-16 units) without splitting a character;
    /// blank text becomes nil.
    static func clip(_ s: String?, _ max: Int) -> String? {
        guard let t = s?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
        if t.utf16.count <= max { return t }
        var out = "", n = 0
        for ch in t {
            let w = String(ch).utf16.count
            if n + w > max { break }
            out.append(ch); n += w
        }
        return out.isEmpty ? nil : out
    }

    /// ISO 8601 with an offset (UTC, "Z"), as the schema's `z.string().datetime({ offset: true })` wants.
    static func iso(_ d: Date?) -> String? {
        guard let d, d != .distantPast, d != .distantFuture else { return nil }
        return isoFormatter.string(from: d)
    }

    nonisolated(unsafe) private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()

    /// A birthday as the schema wants it: "YYYY-MM-DD", or "--MM-DD" when the card has no year.
    static func birthday(_ c: DateComponents?) -> String? {
        guard let c, let m = c.month, let d = c.day, m != NSDateComponentUndefined, d != NSDateComponentUndefined,
              (1...12).contains(m), (1...31).contains(d) else { return nil }
        if let y = c.year, y != NSDateComponentUndefined, (1...9999).contains(y) {
            return String(format: "%04d-%02d-%02d", y, m, d)
        }
        return String(format: "--%02d-%02d", m, d)
    }

    /// Valid coordinates only (0,0 and out-of-range values mean "no location").
    static func coordinate(_ lat: Double?, _ lon: Double?) -> (Double, Double)? {
        guard let lat, let lon, lat.isFinite, lon.isFinite, (-90...90).contains(lat), (-180...180).contains(lon),
              !(lat == 0 && lon == 0) else { return nil }
        return (lat, lon)
    }

    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return e
    }()

    /// Splits items into batches whose JSON stays under `maxBytes` and that hold at most `maxCount` items each.
    static func batches<T: Encodable>(_ items: [T], maxBytes: Int = maxBatchBytes, maxCount: Int) -> [[T]] {
        var out: [[T]] = [], current: [T] = [], size = 0
        let overhead = 1024
        for item in items {
            let n = ((try? encoder.encode(item))?.count ?? 0) + 1
            if !current.isEmpty, size + n + overhead > maxBytes || current.count >= maxCount {
                out.append(current); current = []; size = 0
            }
            current.append(item); size += n
        }
        if !current.isEmpty { out.append(current) }
        return out
    }

    /// A short fingerprint of an item's content, kept per id so a later send carries only what changed.
    static func fingerprint<T: Encodable>(_ item: T) -> String {
        let data = (try? encoder.encode(item)) ?? Data()
        return SHA256.hash(data: data).prefix(12).map { String(format: "%02x", $0) }.joined()
    }

    /// The items that are new or changed since the ledger (id → fingerprint) was written.
    static func changed<T: Encodable>(_ items: [T], id: (T) -> String, ledger: [String: String]) -> [T] {
        items.filter { ledger[id($0)] != fingerprint($0) }
    }

    /// The request body, as JSON.
    static func body<D: Encodable>(title: String?, visibility: String?, data: D) throws -> Data {
        try encoder.encode(ImportEnvelope(title: title, visibility: visibility, data: data))
    }
}

// MARK: - Visits (pure)

/// A visit kept on this iPhone until it is sent (Application Support, never in the shared container).
struct StoredVisit: Codable, Equatable, Identifiable {
    var arrival: Date
    var departure: Date?
    var lat: Double
    var lon: Double
    var accuracyM: Double?
    var placeName: String?

    /// The same visit seen twice (arrival first, then again with its departure) shares this key.
    var id: String { "\(Int(arrival.timeIntervalSince1970))@\(String(format: "%.4f,%.4f", lat, lon))" }

    /// A CLVisit's values. Arrival is `distantPast` when the visit began before monitoring and departure is
    /// `distantFuture` while you're still there; a visit with neither a usable arrival nor departure is dropped.
    static func from(arrival: Date, departure: Date, lat: Double, lon: Double, accuracy: Double) -> StoredVisit? {
        guard let c = PhoneImportKit.coordinate(lat, lon) else { return nil }
        let dep: Date? = departure == .distantFuture || departure == .distantPast ? nil : departure
        let arr: Date? = arrival == .distantPast || arrival == .distantFuture ? nil : arrival
        guard let start = arr ?? dep else { return nil }
        let acc = accuracy.isFinite && accuracy >= 0 ? min(accuracy, 100_000) : nil
        return StoredVisit(arrival: start, departure: dep, lat: c.0, lon: c.1, accuracyM: acc)
    }

    var item: VisitItem {
        VisitItem(arrival: PhoneImportKit.iso(arrival) ?? "", departure: PhoneImportKit.iso(departure), lat: lat, lon: lon,
                  accuracyM: accuracyM.map { ($0 * 10).rounded() / 10 }, placeName: PhoneImportKit.clip(placeName, 200))
    }
}

enum VisitLog {
    /// How many visits are kept on the phone at most (oldest go first).
    static let maxKept = 5_000

    /// Adds a visit, replacing the earlier copy of the same visit (its departure arrives later), newest last.
    static func record(_ v: StoredVisit, into list: [StoredVisit]) -> [StoredVisit] {
        var out = list
        if let i = out.firstIndex(where: { $0.id == v.id }) {
            var merged = v
            if merged.placeName == nil { merged.placeName = out[i].placeName }
            out[i] = merged
        } else {
            out.append(v)
        }
        out.sort { $0.arrival < $1.arrival }
        if out.count > maxKept { out.removeFirst(out.count - maxKept) }
        return out
    }
}

// MARK: - Photos (pure)

/// What PhotoKit (or the image's own EXIF) tells about one photo, before it becomes a payload item.
struct PhotoMeta: Equatable {
    var id: String
    var takenAt: Date?
    var lat: Double?
    var lon: Double?
    var albums: [String] = []
    var favorite: Bool?
    var sourceId: String?

    var item: PhotoItem {
        let c = PhoneImportKit.coordinate(lat, lon)
        var seen = Set<String>()
        let albums = self.albums.compactMap { PhoneImportKit.clip($0, 200) }.filter { seen.insert($0).inserted }
        return PhotoItem(id: PhoneImportKit.clip(id, 200) ?? "photo", takenAt: PhoneImportKit.iso(takenAt), lat: c?.0, lon: c?.1,
                         albums: Array(albums.prefix(50)), favorite: favorite, sourceId: sourceId)
    }
}

// MARK: - Health (pure)

/// The parts of a FHIR resource (Health Records) that make a record: its date, a lab value and a short note.
struct FHIRSummary: Equatable {
    var date: Date?
    var value: Double?
    var unit: String?
    var note: String?

    static func parse(_ data: Data?) -> FHIRSummary {
        guard let data, let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return FHIRSummary() }
        var s = FHIRSummary()
        let dateKeys = ["occurrenceDateTime", "effectiveDateTime", "onsetDateTime", "performedDateTime", "authoredOn",
                        "recordedDate", "assertedDate", "dateAsserted", "issued", "date"]
        for k in dateKeys {
            if let str = obj[k] as? String, let d = fhirDate(str) { s.date = d; break }
        }
        if s.date == nil {
            for k in ["performedPeriod", "effectivePeriod", "onsetPeriod", "period"] {
                if let p = obj[k] as? [String: Any], let str = p["start"] as? String, let d = fhirDate(str) { s.date = d; break }
            }
        }
        if let q = obj["valueQuantity"] as? [String: Any] {
            s.value = (q["value"] as? NSNumber)?.doubleValue
            s.unit = PhoneImportKit.clip((q["unit"] as? String) ?? (q["code"] as? String), 40)
        }
        var notes: [String] = []
        if let v = obj["valueString"] as? String { notes.append(v) }
        if let status = (obj["status"] as? String) ?? text(obj["clinicalStatus"]) { notes.append(status) }
        if let dose = (obj["dosage"] as? [[String: Any]])?.first?["text"] as? String { notes.append(dose) }
        if let dose = (obj["dosageInstruction"] as? [[String: Any]])?.first?["text"] as? String { notes.append(dose) }
        if let reactions = obj["reaction"] as? [[String: Any]] {
            let r = reactions.flatMap { ($0["manifestation"] as? [Any] ?? []).compactMap { text($0) } }
            if !r.isEmpty { notes.append(r.joined(separator: ", ")) }
        }
        s.note = PhoneImportKit.clip(notes.joined(separator: " · "), 2000)
        return s
    }

    /// A CodeableConcept's words: its text, else the first coding's display.
    private static func text(_ any: Any?) -> String? {
        guard let c = any as? [String: Any] else { return any as? String }
        if let t = c["text"] as? String { return t }
        return (c["coding"] as? [[String: Any]])?.lazy.compactMap { ($0["display"] as? String) ?? ($0["code"] as? String) }.first
    }

    /// FHIR dateTime: "2021", "2021-05", "2021-05-03" or a full timestamp with an offset.
    static func fhirDate(_ s: String) -> Date? {
        let full = ISO8601DateFormatter()
        full.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = full.date(from: s) { return d }
        full.formatOptions = [.withInternetDateTime]
        if let d = full.date(from: s) { return d }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        for fmt in ["yyyy-MM-dd", "yyyy-MM", "yyyy"] {
            f.dateFormat = fmt
            if s.count == fmt.count, let d = f.date(from: s) { return d }
        }
        return nil
    }
}

// MARK: - Results in words

/// How one send went.
struct ImportOutcome: Codable, Equatable {
    var at: Date
    /// Items sent in this run (0 when nothing had changed).
    var sent: Int
    /// Items that are still waiting (a batch failed or the rate limit was reached).
    var left: Int = 0
    var graphName: String?
    var error: String?
}
