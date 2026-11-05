import Foundation
import Observation
import Contacts
import Photos
import PhotosUI
import CoreLocation

/// The state behind "Bring in from this iPhone": switches, permissions, and one send at a time per source.
@MainActor
@Observable
final class FromPhoneModel {
    var on: [PhoneImporter: Bool] = [:]
    var busy: [PhoneImporter: String] = [:]
    var outcome: [PhoneImporter: ImportOutcome] = [:]
    /// A permission note under a source ("Not allowed in Settings").
    var blocked: [PhoneImporter: String] = [:]
    var photosLibrary = PhoneImportStore.photosWholeLibrary
    var photosStatus = PhotosSource.status
    var placesNames = PhoneImportStore.placesNames
    var placesPaused = PhoneImportStore.placesPaused
    var placesAuth: CLAuthorizationStatus = PlacesMonitor.shared.authorization
    var storedVisits = 0
    var unsentVisits = 0

    init() { reload() }

    func reload() {
        for i in PhoneImporter.allCases {
            on[i] = PhoneImportStore.isOn(i)
            outcome[i] = PhoneImportStore.lastOutcome(i)
        }
        photosStatus = PhotosSource.status
        placesAuth = PlacesMonitor.shared.authorization
        countVisits()
        if on[.contacts] == true, ContactsSource.status == .denied || ContactsSource.status == .restricted { blocked[.contacts] = Self.deniedText }
    }

    func countVisits() {
        let visits = PhoneImportStore.visits()
        storedVisits = visits.count
        if let g = PhoneImportStore.placesGraphId {
            let ledger = PhoneImportStore.ledger(.places, graphId: g)
            unsentVisits = PhoneImportKit.changed(visits.map(\.item), id: \.key, ledger: ledger).count
        } else {
            unsentVisits = visits.count
        }
    }

    static let deniedText = String(localized: "My Graph isn't allowed to read this. You can change that in iOS Settings.")

    // MARK: Switches

    func setOn(_ i: PhoneImporter, _ value: Bool, graphId: String?, graphName: String?) async {
        blocked[i] = nil
        guard value else {
            PhoneImportStore.setOn(i, false)
            if i == .places { PlacesMonitor.shared.stop() }
            if i == .photos { PhoneImportStore.photosWholeLibrary = false; photosLibrary = false }
            PhoneImportStore.reset(i)
            reload()
            return
        }
        switch i {
        case .contacts:
            let ok = ContactsSource.canRead ? true : await ContactsSource.requestAccess()
            guard ok else { blocked[i] = Self.deniedText; on[i] = false; return }
        case .photos:
            break // Picking photos needs no access; the whole-library option asks on its own.
        case .places:
            PhoneImportStore.placesGraphId = graphId
            PhoneImportStore.placesGraphName = graphName
            PhoneImportStore.setOn(.places, true)
            let s = await PlacesMonitor.shared.turnOn()
            placesAuth = s
            if s == .denied || s == .restricted {
                PhoneImportStore.setOn(.places, false)
                blocked[i] = Self.deniedText; on[i] = false; return
            }
        case .health:
            guard HealthSource.available else { blocked[i] = String(localized: "Apple Health isn't available on this device."); on[i] = false; return }
            do { try await HealthSource.requestAccess() } catch {
                blocked[i] = String(localized: "Apple Health couldn't be opened from this build of the app. Health access may not be set up for it yet.")
                on[i] = false; return
            }
        }
        PhoneImportStore.setOn(i, true)
        on[i] = true
    }

    func setPhotosLibrary(_ value: Bool) async {
        blocked[.photos] = nil
        guard value else { PhoneImportStore.photosWholeLibrary = false; photosLibrary = false; return }
        var s = PhotosSource.status
        if s == .notDetermined { s = await PhotosSource.requestAccess() }
        photosStatus = s
        guard s == .authorized || s == .limited else {
            blocked[.photos] = Self.deniedText; photosLibrary = false; return
        }
        PhoneImportStore.photosWholeLibrary = true
        photosLibrary = true
    }

    func setPlacesNames(_ v: Bool) { PhoneImportStore.placesNames = v; placesNames = v }

    func setPlacesPaused(_ v: Bool) {
        PhoneImportStore.placesPaused = v; placesPaused = v
        if v { PlacesMonitor.shared.stop() } else { PlacesMonitor.shared.resumeIfOn() }
    }

    func deleteVisits() {
        PhoneImportStore.deleteVisits()
        countVisits()
    }

    // MARK: Sending

    private func finish(_ i: PhoneImporter, sent: Int, left: Int, error: String?, graphName: String?) {
        let o = ImportOutcome(at: Date(), sent: sent, left: left, graphName: graphName, error: error)
        PhoneImportStore.setLastOutcome(i, o)
        outcome[i] = o
        busy[i] = nil
        if error == nil && sent > 0 { Haptics.success() }
    }

    func sendContacts(graphId: String, graphName: String?) async {
        guard busy[.contacts] == nil else { return }
        guard ContactsSource.canRead else { blocked[.contacts] = Self.deniedText; return }
        busy[.contacts] = String(localized: "Reading your contacts…")
        do {
            let all = try await ContactsSource.readAll()
            let changed = PhoneImportKit.changed(all, id: \.id, ledger: PhoneImportStore.ledger(.contacts, graphId: graphId))
            busy[.contacts] = String(localized: "Sending \(changed.count) contacts…")
            let r = await PhoneImportClient.send(.contacts, items: changed, id: \.id, title: String(localized: "Contacts from this iPhone"),
                                                 graphId: graphId, wrap: { ContactsData(contacts: $0) })
            finish(.contacts, sent: r.sent, left: r.left, error: r.error, graphName: graphName)
        } catch {
            finish(.contacts, sent: 0, left: 0, error: error.plainMessage, graphName: graphName)
        }
    }

    func sendPhotoLibrary(graphId: String, graphName: String?) async {
        guard busy[.photos] == nil else { return }
        guard PhotosSource.canRead else { blocked[.photos] = Self.deniedText; return }
        busy[.photos] = String(localized: "Reading your photo library…")
        let all = await PhotosSource.readLibrary()
        let changed = PhoneImportKit.changed(all, id: \.id, ledger: PhoneImportStore.ledger(.photos, graphId: graphId))
        busy[.photos] = String(localized: "Sending the details of \(changed.count) photos…")
        let r = await PhoneImportClient.send(.photos, items: changed, id: \.id, title: String(localized: "Photo details from this iPhone"),
                                             graphId: graphId, wrap: { PhotosData(photos: $0) })
        finish(.photos, sent: r.sent, left: r.left, error: r.error, graphName: graphName)
    }

    /// Picked photos: upload each image to the library (20 per request, like Send to My Graph), then send their
    /// details with the uploads' source ids.
    func sendPicked(_ results: [PHPickerResult], graphId: String, graphName: String?) async {
        guard busy[.photos] == nil, !results.isEmpty else { return }
        busy[.photos] = String(localized: "Preparing \(results.count) photos…")
        let (picked, skipped) = await PhotosSource.load(results)
        var items: [PhotoItem] = [], errors: [String] = []
        let visibility = PhoneImportStore.visibility(.photos)
        let batches = SendKit.batches(picked.map(\.file))
        var offset = 0
        for (n, batch) in batches.enumerated() {
            busy[.photos] = batches.count > 1 ? String(localized: "Uploading photos (\(n + 1) of \(batches.count))…") : String(localized: "Uploading \(batch.count) photos…")
            do {
                let r = try await API.shared.upload(batch, visibility: visibility)
                let res = r.results ?? []
                for (k, f) in batch.enumerated() {
                    // Results come back in the order sent; fall back to the file name.
                    let match = res.count == batch.count ? res[k] : res.first { $0.name == f.filename }
                    if let e = match?.error { errors.append(e); continue }
                    var meta = picked[offset + k].meta
                    meta.sourceId = match?.sourceId
                    items.append(meta.item)
                }
            } catch {
                errors.append(error.plainMessage)
            }
            offset += batch.count
        }
        var sent = 0, left = 0, err: String? = errors.first
        if !items.isEmpty {
            busy[.photos] = String(localized: "Sending their details…")
            let r = await PhoneImportClient.send(.photos, items: items, id: \.id, title: String(localized: "Photos from this iPhone"),
                                                 graphId: graphId, wrap: { PhotosData(photos: $0) })
            sent = r.sent; left = r.left; err = r.error ?? err
        }
        if skipped > 0 && err == nil { err = String(localized: "\(skipped) photos couldn't be read and were left out.") }
        finish(.photos, sent: sent, left: left + (errors.isEmpty ? 0 : max(0, picked.count - items.count)), error: err, graphName: graphName)
    }

    func sendPlaces(graphId: String, graphName: String?) async {
        guard busy[.places] == nil else { return }
        busy[.places] = PhoneImportStore.placesNames ? String(localized: "Looking up place names…") : String(localized: "Sending visits…")
        let o = await PlacesSync.send(graphId: graphId, graphName: graphName)
        outcome[.places] = o
        busy[.places] = nil
        countVisits()
        if o.error == nil && o.sent > 0 { Haptics.success() }
    }

    func sendHealth(graphId: String, graphName: String?) async {
        guard busy[.health] == nil else { return }
        busy[.health] = String(localized: "Reading Apple Health…")
        let all = await HealthSource.readAll()
        let changed = PhoneImportKit.changed(all, id: \.id, ledger: PhoneImportStore.ledger(.health, graphId: graphId))
        busy[.health] = String(localized: "Sending \(changed.count) health records…")
        let r = await PhoneImportClient.send(.health, items: changed, id: \.id, title: String(localized: "Health from this iPhone"),
                                             graphId: graphId, wrap: { HealthData(records: $0) })
        finish(.health, sent: r.sent, left: r.left, error: r.error, graphName: graphName)
    }
}
