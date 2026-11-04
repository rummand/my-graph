import UIKit
import SwiftUI
import UniformTypeIdentifiers

/// "Save to My Graph": photos, PDFs, text and links go to the library of a graph you pick,
/// using the session the app saved in the shared Keychain.
final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        MGFont.register()
        API.shared.persistsCookies = false
        CookieVault.restore()
        let model = ShareModel(context: extensionContext)
        let host = UIHostingController(rootView: ShareView(model: model).mgFont(.body).tint(.mgAccent))
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        host.view.backgroundColor = Palette.bg
        view.addSubview(host.view)
        host.didMove(toParent: self)
        Task { await model.start() }
    }
}

@MainActor
@Observable
final class ShareModel {
    enum Phase: Equatable { case loading, signedOut, ready, saving, done(String), failed(String) }

    var phase: Phase = .loading
    var graphs: [GraphSummary] = []
    var graphId: String?
    var visibility = "private"
    var files: [UploadFile] = []
    var previews: [Preview] = []
    private weak var context: NSExtensionContext?

    struct Preview: Identifiable { let id = UUID(); let name: String; let icon: String; let image: UIImage? }

    init(context: NSExtensionContext?) { self.context = context }

    var graph: GraphSummary? { graphs.first { $0.id == graphId } }

    func start() async {
        await collect()
        guard CookieVault.hasSession else { phase = .signedOut; return }
        do {
            let r: GraphsResponse = try await API.shared.get("/api/graphs")
            graphs = r.graphs.filter { $0.archivedAt == nil && $0.myRole != "viewer" }
            graphId = r.currentGraphId.flatMap { id in graphs.contains { $0.id == id } ? id : nil } ?? graphs.first?.id
            phase = files.isEmpty ? .failed(String(localized: "There's nothing here My Graph can save. Try a photo, a PDF, some text or a link.")) : .ready
        } catch let e as APIError {
            if case .unauthorized = e { phase = .signedOut } else { phase = .failed(e.plainMessage) }
        } catch {
            phase = .failed(error.plainMessage)
        }
    }

    private func collect() async {
        let items = (context?.inputItems as? [NSExtensionItem]) ?? []
        var texts: [String] = []
        for item in items {
            for p in item.attachments ?? [] {
                if p.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                    if let f = await loadFile(p, type: .image) {
                        files.append(f)
                        previews.append(Preview(name: f.filename, icon: "photo", image: UIImage(data: f.data)))
                    }
                } else if p.hasItemConformingToTypeIdentifier(UTType.pdf.identifier) {
                    if let f = await loadFile(p, type: .pdf) { files.append(f); previews.append(Preview(name: f.filename, icon: "doc.richtext", image: nil)) }
                } else if p.hasItemConformingToTypeIdentifier(UTType.url.identifier), !p.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                    if let url = try? await p.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL {
                        let title = item.attributedContentText?.string
                        let body = [title, url.absoluteString].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n\n")
                        let name = String(localized: "Link from \(url.host ?? "the web")") + ".txt"
                        files.append(UploadFile(filename: name, mime: "text/plain", data: Data(body.utf8)))
                        previews.append(Preview(name: url.absoluteString, icon: "link", image: nil))
                    }
                } else if p.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                    if let f = await loadFile(p, type: .data) { files.append(f); previews.append(Preview(name: f.filename, icon: "doc", image: nil)) }
                } else if p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                    if let s = try? await p.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String { texts.append(s) }
                }
            }
        }
        if !texts.isEmpty {
            let body = texts.joined(separator: "\n\n")
            let first = body.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
            let name = String(first.prefix(40)).trimmingCharacters(in: .whitespaces)
            files.append(UploadFile(filename: (name.isEmpty ? String(localized: "Note") : name.replacingOccurrences(of: "/", with: "-")) + ".txt", mime: "text/plain", data: Data(body.utf8)))
            previews.append(Preview(name: String(body.prefix(120)), icon: "text.alignleft", image: nil))
        }
    }

    private func loadFile(_ p: NSItemProvider, type: UTType) async -> UploadFile? {
        await withCheckedContinuation { c in
            _ = p.loadFileRepresentation(for: type, openInPlace: false) { url, _, _ in
                guard let url, let data = try? Data(contentsOf: url) else { c.resume(returning: nil); return }
                let ut = UTType(filenameExtension: url.pathExtension)
                let mime = ut?.preferredMIMEType ?? (type == .pdf ? "application/pdf" : "application/octet-stream")
                var name = p.suggestedName ?? url.deletingPathExtension().lastPathComponent
                if !url.pathExtension.isEmpty, !name.lowercased().hasSuffix("." + url.pathExtension.lowercased()) { name += "." + url.pathExtension }
                c.resume(returning: UploadFile(filename: name, mime: mime, data: data))
            }
        }
    }

    func save() async {
        guard let gid = graphId else { return }
        phase = .saving
        // Pick the graph for this upload only; the app keeps working in its own graph.
        CookieVault.setLocal(CookieVault.graph, gid)
        do {
            let r = try await API.shared.upload(files, visibility: visibility)
            let errors = (r.results ?? []).compactMap(\.error)
            if errors.count == files.count, let e = errors.first { phase = .failed(e); return }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            phase = .done(String(localized: "Saved to \(graph?.name ?? "My Graph"). The assistant is reading it now."))
            try? await Task.sleep(for: .seconds(1.2))
            context?.completeRequest(returningItems: nil)
        } catch {
            phase = .failed(error.plainMessage)
        }
    }

    func cancel() {
        context?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
    }
}

struct ShareView: View {
    @Bindable var model: ShareModel

    var body: some View {
        NavigationStack {
            Group {
                switch model.phase {
                case .loading:
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                case .signedOut:
                    message(icon: "person.crop.circle.badge.exclamationmark", text: String(localized: "Open My Graph and sign in first. Then you can save things here from any app."))
                case .failed(let e):
                    message(icon: "exclamationmark.circle", text: e, tone: .mgDanger)
                case .done(let t):
                    message(icon: "checkmark.circle.fill", text: t, tone: .mgAccent)
                case .ready, .saving:
                    form
                }
            }
            .background(Color.mgBg)
            .navigationTitle(Text("Save to My Graph"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { model.cancel() } }
                if model.phase == .ready || model.phase == .saving {
                    ToolbarItem(placement: .confirmationAction) {
                        Button { Task { await model.save() } } label: {
                            if model.phase == .saving { ProgressView() } else { Text("Save").bold() }
                        }
                        .disabled(model.phase == .saving || model.graphId == nil)
                    }
                }
            }
        }
    }

    private var form: some View {
        Form {
            Section {
                ForEach(model.previews) { p in
                    HStack(spacing: 12) {
                        if let img = p.image {
                            Image(uiImage: img).resizable().scaledToFill().frame(width: 44, height: 44).clipShape(RoundedRectangle(cornerRadius: 6))
                        } else {
                            Image(systemName: p.icon).frame(width: 44, height: 44).background(RoundedRectangle(cornerRadius: 6).fill(Color.mgSurface2)).foregroundStyle(Color.mgMuted)
                        }
                        Text(p.name).mgFont(.secondary).lineLimit(2)
                    }
                    .listRowBackground(Color.mgSurface)
                }
            }
            Section {
                Picker("Graph", selection: $model.graphId) {
                    ForEach(model.graphs) { g in
                        HStack { Circle().fill(GraphColor.dot(g.hue)).frame(width: 9, height: 9); Text(g.name) }.tag(Optional(g.id))
                    }
                }
                .listRowBackground(Color.mgSurface)
                Picker("Who can see it", selection: $model.visibility) {
                    Text("Only you").tag("private")
                    Text("Parents").tag("parents")
                    Text("Everyone at home").tag("household")
                }
                .listRowBackground(Color.mgSurface)
            } footer: {
                Text("It goes to the library. The assistant reads it and suggests dates, people and things to do; nothing is added to your graph until you say so.")
            }
        }
        .scrollContentBackground(.hidden)
        .disabled(model.phase == .saving)
    }

    private func message(icon: String, text: String, tone: Color = .mgMuted) -> some View {
        VStack(spacing: 12) {
            Image(systemName: icon).font(.system(size: 34)).foregroundStyle(tone)
            Text(text).mgFont(.body).multilineTextAlignment(.center).foregroundStyle(Color.mgFg)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
