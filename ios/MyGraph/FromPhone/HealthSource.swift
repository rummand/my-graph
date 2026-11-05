import Foundation
import HealthKit

/// Health: what the person lets My Graph read from Apple Health, sent as `healthPayload`, always private (only the
/// person sees it). A few summaries (latest height, weight and resting heart rate, never raw streams) and, where the
/// iPhone supports Health Records, vaccinations, conditions, medications, allergies, lab results and procedures.
/// Health Records exist only in some countries; elsewhere those are simply not offered.
enum HealthSource {
    static var available: Bool { HKHealthStore.isHealthDataAvailable() }

    static let store = HKHealthStore()

    static var supportsRecords: Bool { available && store.supportsHealthRecords() }

    /// The summaries: (type, the name sent, the unit, the unit's label).
    static let summaries: [(HKQuantityTypeIdentifier, String, HKUnit, String)] = [
        (.height, "Height", .meterUnit(with: .centi), "cm"),
        (.bodyMass, "Weight", .gramUnit(with: .kilo), "kg"),
        (.restingHeartRate, "Resting heart rate", HKUnit.count().unitDivided(by: .minute()), "bpm"),
    ]

    static let clinical: [(HKClinicalTypeIdentifier, HealthItem.Kind)] = [
        (.immunizationRecord, .vaccination), (.conditionRecord, .condition), (.medicationRecord, .medication),
        (.allergyRecord, .allergy), (.labResultRecord, .lab), (.procedureRecord, .procedure),
    ]

    static var quantityTypes: Set<HKObjectType> { Set(summaries.compactMap { HKQuantityType.quantityType(forIdentifier: $0.0) }) }
    static var clinicalTypes: Set<HKObjectType> { Set(clinical.compactMap { HKObjectType.clinicalType(forIdentifier: $0.0) }) }

    /// Asks Health for read access: the summaries first, then (where supported) Health Records, which iOS asks
    /// about on its own sheet. iOS never says what was refused; a refused type simply reads as empty.
    static func requestAccess() async throws {
        guard available else { return }
        try await store.requestAuthorization(toShare: [], read: quantityTypes)
        if supportsRecords {
            try await store.requestAuthorization(toShare: [], read: clinicalTypes)
        }
    }

    /// Everything readable, mapped.
    static func readAll() async -> [HealthItem] {
        guard available else { return [] }
        var out: [HealthItem] = []
        for (id, name, unit, label) in summaries {
            guard let type = HKQuantityType.quantityType(forIdentifier: id),
                  let s = await latest(type) else { continue }
            out.append(item(from: s, name: name, unit: unit, unitLabel: label))
        }
        if supportsRecords {
            for (id, kind) in clinical {
                guard let type = HKObjectType.clinicalType(forIdentifier: id) else { continue }
                for r in await records(type) { out.append(item(from: r, kind: kind)) }
            }
        }
        return out
    }

    private static func latest(_ type: HKQuantityType) async -> HKQuantitySample? {
        await withCheckedContinuation { c in
            let sort = NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)
            let q = HKSampleQuery(sampleType: type, predicate: nil, limit: 1, sortDescriptors: [sort]) { _, samples, _ in
                c.resume(returning: samples?.first as? HKQuantitySample)
            }
            store.execute(q)
        }
    }

    private static func records(_ type: HKClinicalType) async -> [HKClinicalRecord] {
        await withCheckedContinuation { c in
            let q = HKSampleQuery(sampleType: type, predicate: nil, limit: 5_000, sortDescriptors: nil) { _, samples, _ in
                c.resume(returning: (samples as? [HKClinicalRecord]) ?? [])
            }
            store.execute(q)
        }
    }

    // MARK: Mapping (pure, unit-tested for quantities; clinical records go through FHIRSummary)

    static func item(from s: HKQuantitySample, name: String, unit: HKUnit, unitLabel: String) -> HealthItem {
        let v = s.quantity.is(compatibleWith: unit) ? s.quantity.doubleValue(for: unit) : nil
        return HealthItem(id: s.uuid.uuidString, type: .measurement, name: name, at: PhoneImportKit.iso(s.endDate),
                          value: v.map { ($0 * 10).rounded() / 10 }, unit: unitLabel)
    }

    static func item(from r: HKClinicalRecord, kind: HealthItem.Kind) -> HealthItem {
        let f = FHIRSummary.parse(r.fhirResource?.data)
        return item(id: r.uuid.uuidString, kind: kind, name: r.displayName, fhir: f, fallbackDate: r.startDate)
    }

    static func item(id: String, kind: HealthItem.Kind, name: String, fhir f: FHIRSummary, fallbackDate: Date?) -> HealthItem {
        HealthItem(id: PhoneImportKit.clip(id, 200) ?? UUID().uuidString, type: kind,
                   name: PhoneImportKit.clip(name, 300) ?? kind.rawValue.capitalized,
                   at: PhoneImportKit.iso(f.date ?? fallbackDate), value: f.value, unit: f.unit, note: f.note)
    }
}
