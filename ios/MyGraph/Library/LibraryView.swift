import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import VisionKit

struct LibraryView: View {
    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
    @State private var items: [LibraryItem]?
    @State private var error: String?
    @State private var query = ""
    @State private var type: String?
    @State private var uploading: String?
    @State private var uploadProgress: Double?
    @State private var uploadNote: String?
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var showPhotos = false
    @State private var showFiles = false
    @State private var showCamera = false
    @State private var showScanner = false
    @State private var visibility = "private"
    @State private var searchTask: Task<Void, Never>?

    private let types: [(String?, LocalizedStringKey)] = [(nil, "All"), ("letter", "Letters"), ("photo", "Photos"), ("scan", "Scans"), ("pdf", "PDFs"), ("mail", "Email"), ("audio", "Audio")]

    var body: some View {
        List {
            Section {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(types, id: \.0) { t in
                            Button { type = t.0 } label: {
                                Text(t.1).mgFont(.secondaryStrong).foregroundStyle(Color.mgFg)
                                    .padding(.horizontal, 11).padding(.vertical, 6)
                                    .background(Capsule().fill(type == t.0 ? Color.mgSurface : Color.mgSurface2))
                                    .overlay(Capsule().stroke(type == t.0 ? Color.mgFg.opacity(0.5) : .clear))
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(type == t.0 ? .isSelected : [])
                        }
                    }
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                if FromPhoneCard.shouldShow {
                    FromPhoneCard().listRowBackground(Color.mgSurface)
                }
                if let u = uploading {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 10) { ProgressView(); Text(u).mgFont(.secondary) }
                        if let p = uploadProgress { ProgressView(value: p).tint(Color.mgAccent) }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("library.sending")
                    .listRowBackground(Color.mgSurface)
                }
                if let n = uploadNote {
                    NoticeBar(text: n.hasPrefix("⚠") ? String(n.dropFirst(2)) : n, tone: n.hasPrefix("⚠") ? .danger : .success)
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("library.note")
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                }
            }
            if let items {
                if items.isEmpty {
                    EmptyStateView(title: query.isEmpty ? "Nothing in the library yet" : "Nothing matches",
                                   message: query.isEmpty ? "Add letters, photos and scans. The assistant reads them and finds dates, people and things to do." : "Try other words.",
                                   systemImage: "books.vertical")
                        .listRowBackground(Color.clear)
                } else {
                    Section {
                        ForEach(items) { item in
                            Button { router.push(.source(item.id)) } label: { LibraryRow(item: item) }
                                .buttonStyle(.plain)
                                .listRowBackground(Color.mgSurface)
                        }
                    }
                }
            } else if let error {
                ErrorStateView(message: error) { await load() }.listRowBackground(Color.clear)
            } else {
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .searchable(text: $query, prompt: Text("Search letters, photos and notes"))
        .onChange(of: query) { _, _ in
            searchTask?.cancel()
            searchTask = Task { try? await Task.sleep(for: .milliseconds(300)); if !Task.isCancelled { await load() } }
        }
        .onChange(of: type) { _, _ in Task { await load() } }
        .refreshable { await load() }
        .navigationTitle(Text("Library"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                // The system Paste button: no "Allow Paste" prompt, and it greys out when there's nothing to paste.
                PasteButton(supportedContentTypes: Self.pasteTypes) { providers in
                    Task { @MainActor in await paste(providers) }
                }
                .labelStyle(.iconOnly)
                .buttonBorderShape(.circle)
                .tint(Color.mgFg)
                .disabled(uploading != nil)
                .accessibilityIdentifier("library.paste")
            }
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button { showPhotos = true } label: { Label("Photos", systemImage: "photo.on.rectangle") }
                    Button { showFiles = true } label: { Label("Files", systemImage: "folder") }
                    if UIImagePickerController.isSourceTypeAvailable(.camera) {
                        Button { showCamera = true } label: { Label("Take a photo", systemImage: "camera") }
                    }
                    Button { showScanner = true } label: { Label("Scan a document", systemImage: "doc.viewfinder") }
                        .disabled(!VNDocumentCameraViewController.isSupported)
                    Button { router.push(.fromPhone) } label: { Label("From this iPhone…", systemImage: "iphone.and.arrow.forward") }
                    Section("Who can see it") {
                        Picker("Who can see it", selection: $visibility) {
                            Text("Only you").tag("private")
                            Text("Parents").tag("parents")
                            Text("Everyone at home").tag("household")
                        }
                    }
                } label: { Image(systemName: "plus") }
                .accessibilityLabel(Text("Add to the library"))
            }
        }
        .photosPicker(isPresented: $showPhotos, selection: $photoItems, maxSelectionCount: 20, matching: .any(of: [.images, .screenshots]))
        .onChange(of: photoItems) { _, picked in
            guard !picked.isEmpty else { return }
            Task { await uploadPhotos(picked); photoItems = [] }
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { Task { await uploadFiles(urls) } }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { image in
                guard let data = image.jpegData(compressionQuality: 0.85) else { return }
                Task { await upload([UploadFile(filename: "Photo \(Self.stamp()).jpg", mime: "image/jpeg", data: data)]) }
            }
            .ignoresSafeArea()
        }
        .fullScreenCover(isPresented: $showScanner) {
            DocumentScanner { pdf in
                Task { await upload([UploadFile(filename: "Scan \(Self.stamp()).pdf", mime: "application/pdf", data: pdf)]) }
            }
            .ignoresSafeArea()
        }
        .task { if items == nil { await load() } }
    }

    /// What Paste takes: images, files (PDF, Office, anything), web addresses and text.
    static let pasteTypes: [UTType] = [.image, .pdf, .fileURL, .url, .plainText, .utf8PlainText, .text, .data]

    /// Pastes what's on the clipboard into this graph's library: files upload, a web address is read and saved as a
    /// web page, other text becomes a note (`POST /api/library/paste`).
    private func paste(_ providers: [NSItemProvider]) async {
        uploading = String(localized: "Getting what you copied…")
        uploadNote = nil
        let (items, skipped) = await SendKit.load(providers)
        guard !items.isEmpty else {
            uploading = nil
            uploadNote = "⚠ " + (skipped.isEmpty ? String(localized: "There's nothing on the clipboard My Graph can save. Copy a photo, a file, some text or a link.") : String(localized: "That's too large to add. Files can be up to 50 MB."))
            Haptics.warning()
            return
        }
        await send(items)
    }

    private func send(_ items: [Outgoing]) async {
        uploadProgress = 0
        defer { uploading = nil; uploadProgress = nil }
        let s = await SendKit.send(items, visibility: visibility) { p, line in
            uploadProgress = p
            if !line.isEmpty { uploading = line }
        }
        report(s)
        await load()
    }

    private func report(_ s: SendSummary) {
        let graph = app.currentGraph?.name ?? "My Graph"
        if s.allFailed { uploadNote = "⚠ " + (s.errors.first ?? ""); Haptics.warning(); return }
        if s.added == 0 { uploadNote = String(localized: "Already in the library, so it wasn't added twice."); return }
        Haptics.success()
        let first = String(localized: "Added to \(graph). The assistant is reading it now; what it finds shows up on the item.")
        uploadNote = s.errors.isEmpty ? first : "⚠ " + first + " " + s.errors.joined(separator: " ")
    }

    static func stamp() -> String { Date().formatted(.dateTime.year().month(.twoDigits).day(.twoDigits).hour().minute()) .replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: ".") }

    private func load() async {
        do {
            let q = query.trimmingCharacters(in: .whitespaces)
            let r: LibraryResponse = try await API.shared.get("/api/library", query: ["q": q.isEmpty ? nil : q, "type": type, "limit": "100"])
            items = r.items; error = nil
        } catch {
            if error.isCancellation { return }
            if items == nil { self.error = error.plainMessage } else { app.banner = error.plainMessage }
        }
    }

    private func uploadPhotos(_ picked: [PhotosPickerItem]) async {
        uploading = String(localized: "Getting your photos ready…")
        var files: [UploadFile] = []
        for (i, p) in picked.enumerated() {
            guard let data = try? await p.loadTransferable(type: Data.self) else { continue }
            let type = p.supportedContentTypes.first
            let ext = type?.preferredFilenameExtension ?? "jpg"
            let mime = type?.preferredMIMEType ?? "image/jpeg"
            files.append(UploadFile(filename: "Photo \(Self.stamp())\(picked.count > 1 ? "-\(i + 1)" : "").\(ext)", mime: mime, data: data))
        }
        await upload(files)
    }

    private func uploadFiles(_ urls: [URL]) async {
        var files: [UploadFile] = []
        for u in urls {
            let ok = u.startAccessingSecurityScopedResource()
            defer { if ok { u.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: u) else { continue }
            let mime = UTType(filenameExtension: u.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            files.append(UploadFile(filename: u.lastPathComponent, mime: mime, data: data))
        }
        await upload(files)
    }

    private func upload(_ files: [UploadFile]) async {
        guard !files.isEmpty else { uploading = nil; return }
        uploading = files.count == 1 ? String(localized: "Uploading “\(files[0].filename)”…") : String(localized: "Uploading \(files.count) files…")
        uploadNote = nil
        await send(files.map { .file($0) })
    }
}

struct LibraryRow: View {
    let item: LibraryItem
    var compact = false

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 16))
                .foregroundStyle(Color.mgMuted)
                .frame(width: 36, height: 36)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.mgSurface2))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title).mgFont(.body).foregroundStyle(Color.mgFg).lineLimit(compact ? 1 : 2)
                HStack(spacing: 6) {
                    if let d = item.createdAt { Text(Fmt.relative(d)).mgFont(.meta).foregroundStyle(Color.mgMuted) }
                    status
                    if !compact, let o = item.ownerName, item.isOwner != true { Text(o).mgFont(.meta).foregroundStyle(Color.mgMuted) }
                }
            }
            Spacer(minLength: 0)
            if (item.proposedTotal ?? 0) > 0 {
                StateBadge(text: String(localized: "\(item.proposedTotal!) to review"), tone: .warn)
            }
        }
        .padding(.vertical, compact ? 6 : 2)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var status: some View {
        switch item.status {
        case "pending", "processing": StateBadge(text: String(localized: "Reading…"), tone: .accent)
        case "failed": StateBadge(text: String(localized: "Couldn't read it"), tone: .danger)
        default: EmptyView()
        }
    }

    private var icon: String {
        switch item.docKind ?? item.category {
        case "photo", "image": return "photo"
        case "scan": return "doc.viewfinder"
        case "letter", "pdf": return "doc.richtext"
        case "mail", "email": return "envelope"
        case "audio": return "waveform"
        case "note", "text": return "doc.plaintext"
        default: return "doc"
        }
    }
}
