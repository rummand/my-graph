import Foundation
import CoreLocation

/// Places: the visits iOS notices (`startMonitoringVisits`: arriving somewhere, staying, leaving), kept in a small
/// file on this iPhone and sent as `placesPayload` when the app opens or refreshes in the background. Needs "Always"
/// location access, asked for only after the person turns Places on. Place names, when the person wants them, are
/// looked up with Apple Maps (CLGeocoder) on the iPhone before sending.
@MainActor
final class PlacesMonitor: NSObject, CLLocationManagerDelegate {
    static let shared = PlacesMonitor()

    private let manager = CLLocationManager()
    private var authWaiters: [CheckedContinuation<CLAuthorizationStatus, Never>] = []
    /// Called whenever the stored visits or the permission change, so an open screen can refresh.
    var onChange: (() -> Void)?

    override init() {
        super.init()
        manager.delegate = self
    }

    var authorization: CLAuthorizationStatus { manager.authorizationStatus }
    static var available: Bool { CLLocationManager.significantLocationChangeMonitoringAvailable() }

    /// At launch (also when iOS relaunches the app in the background to hand over a visit): listen again.
    func resumeIfOn() {
        guard PhoneImportStore.isOn(.places), !PhoneImportStore.placesPaused else { return }
        if manager.authorizationStatus == .authorizedAlways { manager.startMonitoringVisits() }
    }

    /// Asks for "While using", then "Always" (iOS asks in two steps), and starts listening when allowed.
    func turnOn() async -> CLAuthorizationStatus {
        var status = manager.authorizationStatus
        if status == .notDetermined {
            status = await waitForAuthorization { self.manager.requestWhenInUseAuthorization() }
        }
        if status == .authorizedWhenInUse {
            status = await waitForAuthorization(timeout: 8) { self.manager.requestAlwaysAuthorization() }
        }
        if status == .authorizedAlways, !PhoneImportStore.placesPaused { manager.startMonitoringVisits() }
        return status
    }

    func stop() { manager.stopMonitoringVisits() }

    private func waitForAuthorization(timeout: Double = 120, _ ask: @escaping () -> Void) async -> CLAuthorizationStatus {
        let status: CLAuthorizationStatus = await withCheckedContinuation { c in
            authWaiters.append(c)
            ask()
            // When iOS doesn't show a prompt (already decided, or "Always" offered later), don't wait for ever.
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(timeout))
                self.finishWaiters()
            }
        }
        return status
    }

    private func finishWaiters() {
        let s = manager.authorizationStatus
        let w = authWaiters; authWaiters = []
        w.forEach { $0.resume(returning: s) }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in
            if manager.authorizationStatus != .notDetermined { self.finishWaiters() }
            if manager.authorizationStatus == .authorizedAlways { self.resumeIfOn() }
            self.onChange?()
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
        let v = StoredVisit.from(arrival: visit.arrivalDate, departure: visit.departureDate,
                                 lat: visit.coordinate.latitude, lon: visit.coordinate.longitude, accuracy: visit.horizontalAccuracy)
        Task { @MainActor in
            guard let v, PhoneImportStore.isOn(.places), !PhoneImportStore.placesPaused else { return }
            PhoneImportStore.saveVisits(VisitLog.record(v, into: PhoneImportStore.visits()))
            self.onChange?()
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}
}

enum PlacesSync {
    /// Automatic sends at most this often.
    static let interval: TimeInterval = 6 * 60 * 60
    /// Names looked up per send (Apple Maps limits how fast an app may ask).
    static let maxLookups = 25

    /// Fills in missing place names with Apple Maps (CLGeocoder), a few per send, and stores them.
    static func lookUpNames() async {
        var visits = PhoneImportStore.visits()
        let geocoder = CLGeocoder()
        var done = 0
        for i in visits.indices where visits[i].placeName == nil && done < maxLookups {
            done += 1
            let loc = CLLocation(latitude: visits[i].lat, longitude: visits[i].lon)
            guard let p = try? await geocoder.reverseGeocodeLocation(loc).first else { continue }
            let parts = [p.name, p.locality].compactMap { $0 }.reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
            visits[i].placeName = PhoneImportKit.clip(parts.joined(separator: ", "), 200)
        }
        if done > 0 {
            // Merge into what is stored now (a visit may have arrived meanwhile).
            var current = PhoneImportStore.visits()
            for v in visits where v.placeName != nil { current = VisitLog.record(v, into: current) }
            PhoneImportStore.saveVisits(current)
        }
    }

    /// When the app opens or refreshes in the background: send new visits if Places is on, the graph it was turned
    /// on in is the current one, and the last send is a while ago.
    static func sendIfDue(currentGraphId: String?, graphName: String?) async {
        guard PhoneImportStore.isOn(.places), let target = PhoneImportStore.placesGraphId, target == currentGraphId else { return }
        if let last = PhoneImportStore.lastOutcome(.places), Date().timeIntervalSince(last.at) < interval, last.error == nil { return }
        _ = await send(graphId: target, graphName: graphName ?? PhoneImportStore.placesGraphName)
    }

    /// Sends what changed since the last send.
    @discardableResult
    static func send(graphId: String, graphName: String?) async -> ImportOutcome {
        if PhoneImportStore.placesNames { await lookUpNames() }
        let items = PhoneImportStore.visits().map(\.item)
        let changed = PhoneImportKit.changed(items, id: \.key, ledger: PhoneImportStore.ledger(.places, graphId: graphId))
        let r = await PhoneImportClient.send(.places, items: changed, id: \.key, title: String(localized: "Places from this iPhone"),
                                             graphId: graphId, wrap: { PlacesData(visits: $0) })
        let o = ImportOutcome(at: Date(), sent: r.sent, left: r.left, graphName: graphName, error: r.error)
        PhoneImportStore.setLastOutcome(.places, o)
        return o
    }
}
