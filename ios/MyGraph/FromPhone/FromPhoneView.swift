import SwiftUI
import Photos
import PhotosUI
import CoreLocation

/// More → From this iPhone: four sources (Contacts, Photos, Places, Health), each off until the person turns it on,
/// with what it reads, a Send now and how the last send went. What is sent becomes proposed changes to review.
struct FromPhoneView: View {
    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @State private var model = FromPhoneModel()
    @State private var showPicker = false
    @State private var confirmDelete = false

    private var graphId: String? { app.currentGraphId ?? app.currentGraph?.id }
    private var graphName: String? { app.currentGraph?.name }

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Bring in what's already on this iPhone. Nothing is read until you turn a source on, and you can turn it off at any time.")
                        .mgFont(.body)
                    Text("What arrives is proposed to you as changes. Nothing is added to \(graphName ?? "your graph") until you review and deliver it.")
                        .mgFont(.secondary).foregroundStyle(Color.mgMuted)
                }
                .padding(.vertical, 4)
                .listRowBackground(Color.mgSurface)
            }
            contactsSection
            photosSection
            placesSection
            healthSection
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .navigationTitle(Text("From this iPhone"))
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showPicker) {
            PhotoPicker { results in
                guard let g = graphId else { return }
                Task { await model.sendPicked(results, graphId: g, graphName: graphName) }
            }
            .ignoresSafeArea()
        }
        .onAppear {
            model.reload()
            PlacesMonitor.shared.onChange = { [weak model] in model?.reload() }
        }
        .onDisappear { PlacesMonitor.shared.onChange = nil }
        .task {
            // Debug builds: -MGPhoneSend contacts|health|places turns the source on and sends it.
            guard let s = DebugHooks.phoneSend, let i = PhoneImporter(rawValue: s), let g = graphId else { return }
            try? await Task.sleep(for: .seconds(2))
            await model.setOn(i, true, graphId: g, graphName: graphName)
            switch i {
            case .contacts: await model.sendContacts(graphId: g, graphName: graphName)
            case .health: await model.sendHealth(graphId: g, graphName: graphName)
            case .places: await model.sendPlaces(graphId: g, graphName: graphName)
            case .photos: break
            }
        }
        .onChange(of: scenePhase) { _, p in if p == .active { model.reload() } }
        .confirmationDialog("Delete the visits stored on this iPhone?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete stored visits", role: .destructive) { model.deleteVisits() }
        } message: {
            Text("Visits already sent stay in My Graph; you can remove them there.")
        }
    }

    // MARK: Sources

    private var contactsSection: some View {
        Section {
            toggle(.contacts, "Contacts", systemImage: "person.crop.circle")
            if model.on[.contacts] == true {
                if ContactsSource.status == .limited {
                    Text("My Graph sees only the contacts you shared with it.").mgFont(.secondary).foregroundStyle(Color.mgMuted)
                        .listRowBackground(Color.mgSurface)
                }
                visibilityPicker(.contacts)
                sendRow(.contacts) { g in await model.sendContacts(graphId: g, graphName: graphName) }
            }
            footerRows(.contacts)
        } footer: {
            Text("Names, phone numbers, email and postal addresses, birthdays, workplaces and related names (like “mother”) from your contact cards. Later sends carry only cards that changed.")
        }
    }

    private var photosSection: some View {
        Section {
            toggle(.photos, "Photos", systemImage: "photo.on.rectangle")
            if model.on[.photos] == true {
                visibilityPicker(.photos)
                Button { showPicker = true } label: {
                    Label("Choose photos to add", systemImage: "plus.rectangle.on.rectangle")
                }
                .disabled(model.busy[.photos] != nil || graphId == nil)
                .listRowBackground(Color.mgSurface)
                .accessibilityIdentifier("fromPhone.photos.pick")
                Toggle(isOn: Binding(get: { model.photosLibrary }, set: { v in Task { await model.setPhotosLibrary(v) } })) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Also send details of every photo")
                        Text("When and where each photo was taken, its albums and whether it's a favourite. Only these details, not the images. Needs access to your photo library.")
                            .mgFont(.secondary).foregroundStyle(Color.mgMuted)
                    }
                }
                .tint(Color.mgAccent)
                .listRowBackground(Color.mgSurface)
                if model.photosLibrary {
                    if model.photosStatus == .limited {
                        HStack {
                            Text("My Graph sees only the photos you shared with it.").mgFont(.secondary).foregroundStyle(Color.mgMuted)
                            Spacer()
                            Button("Change") { presentLimitedPicker() }.mgFont(.secondaryStrong)
                        }
                        .listRowBackground(Color.mgSurface)
                    }
                    sendRow(.photos, title: "Send photo details now") { g in await model.sendPhotoLibrary(graphId: g, graphName: graphName) }
                } else {
                    statusRows(.photos)
                }
            }
            footerRows(.photos)
        } footer: {
            Text("Pick photos to add them to the library, with when and where they were taken. Faces and people's names are never read; the iPhone doesn't share them with apps.")
        }
    }

    private var placesSection: some View {
        Section {
            toggle(.places, "Places", systemImage: "mappin.and.ellipse")
            if model.on[.places] == true {
                if model.placesAuth != .authorizedAlways {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Visits are noticed only with location access set to “Always”.").mgFont(.secondary).foregroundStyle(Color.mgWarn)
                        Button("Open iOS Settings") { openSettings() }.mgFont(.secondaryStrong)
                    }
                    .listRowBackground(Color.mgSurface)
                }
                if let target = PhoneImportStore.placesGraphId, target != graphId {
                    Text("Visits go to \(PhoneImportStore.placesGraphName ?? String(localized: "the graph you turned Places on in")). Switch to it to send them.")
                        .mgFont(.secondary).foregroundStyle(Color.mgMuted)
                        .listRowBackground(Color.mgSurface)
                }
                Toggle("Pause noticing visits", isOn: Binding(get: { model.placesPaused }, set: { model.setPlacesPaused($0) }))
                    .tint(Color.mgAccent)
                    .listRowBackground(Color.mgSurface)
                Toggle(isOn: Binding(get: { model.placesNames }, set: { model.setPlacesNames($0) })) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Look up place names")
                        Text("Names come from Apple Maps: the visit's position is sent to Apple to find the place's name.")
                            .mgFont(.secondary).foregroundStyle(Color.mgMuted)
                    }
                }
                .tint(Color.mgAccent)
                .listRowBackground(Color.mgSurface)
                visibilityPicker(.places)
                HStack {
                    Text("Stored on this iPhone")
                    Spacer()
                    Text(model.unsentVisits > 0 ? String(localized: "\(model.storedVisits) visits, \(model.unsentVisits) not sent") : String(localized: "\(model.storedVisits) visits"))
                        .foregroundStyle(Color.mgMuted)
                }
                .listRowBackground(Color.mgSurface)
                if model.storedVisits > 0 {
                    Button("Delete stored visits", role: .destructive) { confirmDelete = true }
                        .listRowBackground(Color.mgSurface)
                }
                if PhoneImportStore.placesGraphId == nil || PhoneImportStore.placesGraphId == graphId {
                    sendRow(.places) { g in await model.sendPlaces(graphId: g, graphName: graphName) }
                } else {
                    statusRows(.places)
                }
            }
            footerRows(.places)
        } footer: {
            Text("Notices places where you stay a while (home, school, the doctor) and sends those visits when the app opens, every few hours. Needs location access set to “Always”, so visits are noticed while the app is closed. Visits wait on this iPhone until they're sent. Turning Places off deletes them.")
        }
    }

    private var healthSection: some View {
        Section {
            if HealthSource.available {
                toggle(.health, "Health", systemImage: "heart.text.square")
                if model.on[.health] == true {
                    HStack {
                        Text("Who can see it")
                        Spacer()
                        Text("Only you").foregroundStyle(Color.mgMuted)
                    }
                    .listRowBackground(Color.mgSurface)
                    if !HealthSource.supportsRecords {
                        Text("Health Records (vaccinations, conditions, medications) aren't available on this iPhone or in your country, so only the measurements are sent.")
                            .mgFont(.secondary).foregroundStyle(Color.mgMuted)
                            .listRowBackground(Color.mgSurface)
                    }
                    sendRow(.health) { g in await model.sendHealth(graphId: g, graphName: graphName) }
                    Text("If nothing arrives, check Health → Sharing → Apps → My Graph.")
                        .mgFont(.secondary).foregroundStyle(Color.mgMuted)
                        .listRowBackground(Color.mgSurface)
                }
                footerRows(.health)
            } else {
                HStack(spacing: 12) {
                    Image(systemName: "heart.text.square").foregroundStyle(Color.mgMuted).frame(width: 24)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Health")
                        Text("Apple Health isn't available on this device.").mgFont(.secondary).foregroundStyle(Color.mgMuted)
                    }
                }
                .listRowBackground(Color.mgSurface)
            }
        } footer: {
            Text("Your latest height, weight and resting heart rate, and where Health Records are available: vaccinations, conditions, medications, allergies, lab results and procedures. Always private: only you can see them. You choose each kind in Apple Health's own screen.")
        }
    }

    // MARK: Pieces

    private func toggle(_ i: PhoneImporter, _ title: LocalizedStringKey, systemImage: String) -> some View {
        Toggle(isOn: Binding(get: { model.on[i] == true }, set: { v in
            model.on[i] = v
            Task { await model.setOn(i, v, graphId: graphId, graphName: graphName) }
        })) {
            Label { Text(title).mgFont(.bodyStrong) } icon: { Image(systemName: systemImage).foregroundStyle(Color.mgAccent) }
        }
        .tint(Color.mgAccent)
        .listRowBackground(Color.mgSurface)
        .accessibilityIdentifier("fromPhone.\(i.rawValue).toggle")
    }

    private func visibilityPicker(_ i: PhoneImporter) -> some View {
        Picker("Who can see it", selection: Binding(get: { PhoneImportStore.visibility(i) }, set: { PhoneImportStore.setVisibility(i, $0); model.reload() })) {
            Text("Only you").tag("private")
            Text("Parents").tag("parents")
            Text("Everyone at home").tag("household")
        }
        .listRowBackground(Color.mgSurface)
    }

    @ViewBuilder
    private func sendRow(_ i: PhoneImporter, title: LocalizedStringKey = "Send now", action: @escaping (String) async -> Void) -> some View {
        if let b = model.busy[i] {
            HStack(spacing: 10) { ProgressView(); Text(b).mgFont(.secondary) }
                .listRowBackground(Color.mgSurface)
                .accessibilityIdentifier("fromPhone.\(i.rawValue).busy")
        } else {
            Button { if let g = graphId { Task { await action(g) } } } label: {
                Label(title, systemImage: "arrow.up.circle")
            }
            .disabled(graphId == nil || app.isOffline)
            .listRowBackground(Color.mgSurface)
            .accessibilityIdentifier("fromPhone.\(i.rawValue).send")
        }
        statusRows(i)
    }

    @ViewBuilder
    private func statusRows(_ i: PhoneImporter) -> some View {
        if model.busy[i] != nil, i == .photos, !model.photosLibrary {
            HStack(spacing: 10) { ProgressView(); Text(model.busy[i] ?? "").mgFont(.secondary) }
                .listRowBackground(Color.mgSurface)
        }
        if let o = model.outcome[i] {
            VStack(alignment: .leading, spacing: 6) {
                Text(Self.summary(i, o)).mgFont(.secondary)
                    .foregroundStyle(o.error != nil && o.sent == 0 ? Color.mgDanger : Color.mgFg)
                if let e = o.error, o.sent > 0 { Text(e).mgFont(.secondary).foregroundStyle(Color.mgWarn) }
                Text(Date().timeIntervalSince(o.at) < 60 ? String(localized: "Just now") : Fmt.relative(o.at)).mgFont(.meta).foregroundStyle(Color.mgMuted)
                if o.sent > 0 {
                    Button { router.push(.changes) } label: {
                        Label("Review what it found", systemImage: "arrow.triangle.branch").mgFont(.secondaryStrong)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityIdentifier("fromPhone.\(i.rawValue).review")
                }
            }
            .padding(.vertical, 2)
            .listRowBackground(Color.mgSurface)
            .accessibilityIdentifier("fromPhone.\(i.rawValue).status")
        }
    }

    @ViewBuilder
    private func footerRows(_ i: PhoneImporter) -> some View {
        if let b = model.blocked[i] {
            VStack(alignment: .leading, spacing: 6) {
                Text(b).mgFont(.secondary).foregroundStyle(Color.mgDanger)
                Button("Open iOS Settings") { openSettings() }.mgFont(.secondaryStrong)
            }
            .listRowBackground(Color.mgSurface)
        }
    }

    /// "Sent 312 contacts to Family", "Nothing new since the last send", or what went wrong.
    static func summary(_ i: PhoneImporter, _ o: ImportOutcome) -> String {
        if o.sent == 0 {
            if let e = o.error { return e }
            return String(localized: "Nothing new since the last send.")
        }
        let what: String
        switch i {
        case .contacts: what = String(localized: "Sent \(o.sent) contacts")
        case .photos: what = String(localized: "Sent \(o.sent) photos")
        case .places: what = String(localized: "Sent \(o.sent) visits")
        case .health: what = String(localized: "Sent \(o.sent) health records")
        }
        var s = what
        if let g = o.graphName { s = String(localized: "\(what) to \(g)") }
        if o.left > 0 { s += " · " + String(localized: "\(o.left) still to send") }
        return s
    }

    private func openSettings() {
        if let u = URL(string: UIApplication.openSettingsURLString) { openURL(u) }
    }

    private func presentLimitedPicker() {
        guard let root = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow?.rootViewController }).first else { return }
        var top = root
        while let p = top.presentedViewController { top = p }
        PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: top) { _ in
            Task { @MainActor in model.reload() }
        }
    }
}

/// A row on Library that opens "From this iPhone" while no source is on yet.
struct FromPhoneCard: View {
    @Environment(Router.self) private var router
    var body: some View {
        Button { router.push(.fromPhone) } label: {
            HStack(spacing: 12) {
                Image(systemName: "iphone.and.arrow.forward").font(.system(size: 20)).foregroundStyle(Color.mgAccent).frame(width: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Bring in from this iPhone").mgFont(.bodyStrong).foregroundStyle(Color.mgFg)
                    Text("Contacts, photos, places and health. You choose each one.").mgFont(.secondary).foregroundStyle(Color.mgMuted)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Color.mgMuted)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("library.fromPhone")
    }

    static var shouldShow: Bool { !PhoneImporter.allCases.contains { PhoneImportStore.isOn($0) } }
}
