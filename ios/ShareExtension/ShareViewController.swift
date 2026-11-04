import UIKit
import SwiftUI
import UniformTypeIdentifiers

/// "Send to My Graph": photos, PDFs, any file (Word, PowerPoint, Excel…), text and links go to the library of a
/// graph you pick, using the session the app saved in the shared Keychain. Files use the normal upload; text becomes
/// a note and a link a saved web page (`POST /api/library/paste`).
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
    enum Phase: Equatable { case loading, signedOut, ready, sending, done(String), failed(String) }

    var phase: Phase = .loading
    var graphs: [GraphSummary] = []
    var graphId: String?
    var visibility = "private"
    var items: [Outgoing] = []
    var skipped: [String] = []
    var progress = 0.0
    var progressLine = ""
    /// Problems with some of the items when others were added.
    var partial: [String] = []
    private weak var context: NSExtensionContext?

    init(context: NSExtensionContext?) { self.context = context }

    var graph: GraphSummary? { graphs.first { $0.id == graphId } }
    var isDone: Bool { if case .done = phase { return true } else { return false } }

    func start() async {
        let input = (context?.inputItems as? [NSExtensionItem]) ?? []
        let providers = input.flatMap { $0.attachments ?? [] }
        let title = input.compactMap { $0.attributedContentText?.string ?? $0.attributedTitle?.string }.first
        (items, skipped) = await SendKit.load(providers, title: title)
        guard CookieVault.hasSession else { phase = .signedOut; return }
        do {
            let r: GraphsResponse = try await API.shared.get("/api/graphs")
            graphs = r.graphs.filter { $0.archivedAt == nil && $0.myRole != "viewer" }
            let last = AppGroup.defaults.string(forKey: Self.lastGraphKey)
            graphId = [last, r.currentGraphId].compactMap { $0 }.first { id in graphs.contains { $0.id == id } } ?? graphs.first?.id
            if graphs.isEmpty { phase = .failed(String(localized: "You can only look at the graphs you're in, so there's nowhere to send this.")); return }
            if items.isEmpty {
                phase = .failed(skipped.isEmpty
                    ? String(localized: "There's nothing here My Graph can save. Try a photo, a file, some text or a link.")
                    : String(localized: "That's too large to send. Files can be up to 50 MB."))
                return
            }
            phase = .ready
        } catch let e as APIError {
            if case .unauthorized = e { phase = .signedOut } else { phase = .failed(e.plainMessage) }
        } catch {
            phase = .failed(error.plainMessage)
        }
    }

    static let lastGraphKey = "mg.share.lastGraph"

    func send() async {
        guard let gid = graphId else { return }
        phase = .sending
        progress = 0
        // Pick the graph for this send only; the app keeps working in its own graph.
        CookieVault.setLocal(CookieVault.graph, gid)
        AppGroup.defaults.set(gid, forKey: Self.lastGraphKey)
        let s = await SendKit.send(items, visibility: visibility) { [weak self] p, line in
            self?.progress = p
            if !line.isEmpty { self?.progressLine = line }
        }
        if s.allFailed { phase = .failed(s.errors.first ?? String(localized: "Nothing was added. Please try again.")); return }
        partial = s.errors
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        phase = .done(String(localized: "Added to \(graph?.name ?? "My Graph")"))
        try? await Task.sleep(for: .seconds(partial.isEmpty ? 1.4 : 4))
        context?.completeRequest(returningItems: nil)
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
                    message(icon: "person.crop.circle.badge.exclamationmark", text: String(localized: "Open My Graph and sign in first. Then you can send things here from any app."))
                case .failed(let e):
                    message(icon: "exclamationmark.circle", text: e, tone: .mgDanger)
                case .done(let t):
                    done(t)
                case .sending:
                    sending
                case .ready:
                    form
                }
            }
            .background(Color.mgBg)
            .navigationTitle(Text("Send to My Graph"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if !model.isDone {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { model.cancel() }.disabled(model.phase == .sending)
                    }
                }
                if model.phase == .ready {
                    ToolbarItem(placement: .confirmationAction) {
                        Button { Task { await model.send() } } label: { Text("Send").bold() }
                            .disabled(model.graphId == nil)
                            .accessibilityIdentifier("share.send")
                    }
                }
            }
        }
    }

    private var form: some View {
        Form {
            Section {
                ForEach(Array(model.items.enumerated()), id: \.offset) { _, item in
                    HStack(spacing: 12) {
                        thumbnail(item)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.label).mgFont(.secondary).lineLimit(3)
                            Text(kind(item)).mgFont(.meta).foregroundStyle(Color.mgMuted)
                        }
                    }
                    .listRowBackground(Color.mgSurface)
                }
                if !model.skipped.isEmpty {
                    Text("Too large to send (over 50 MB): \(model.skipped.joined(separator: ", "))")
                        .mgFont(.meta).foregroundStyle(Color.mgDanger)
                        .listRowBackground(Color.mgSurface)
                }
            }
            Section {
                Picker("Graph", selection: $model.graphId) {
                    ForEach(model.graphs) { g in
                        HStack { Circle().fill(GraphColor.dot(g.hue)).frame(width: 9, height: 9); Text(g.name) }.tag(Optional(g.id))
                    }
                }
                .accessibilityIdentifier("share.graph")
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
    }

    private var sending: some View {
        VStack(spacing: 14) {
            ProgressView(value: model.progress)
                .progressViewStyle(.linear)
                .tint(Color.mgAccent)
                .accessibilityIdentifier("share.progress")
            Text(model.progressLine.isEmpty ? String(localized: "Sending…") : model.progressLine)
                .mgFont(.secondary).foregroundStyle(Color.mgMuted).multilineTextAlignment(.center)
            if let g = model.graph {
                HStack(spacing: 6) { Circle().fill(GraphColor.dot(g.hue)).frame(width: 8, height: 8); Text(g.name).mgFont(.meta) }
                    .foregroundStyle(Color.mgMuted)
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func done(_ title: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "checkmark.circle.fill").font(.system(size: 38)).foregroundStyle(Color.mgAccent)
            Text(title).mgFont(.heading).multilineTextAlignment(.center).foregroundStyle(Color.mgFg)
                .accessibilityIdentifier("share.done")
            Text("The assistant is reading it now. What it finds waits for you on Today.")
                .mgFont(.secondary).foregroundStyle(Color.mgMuted).multilineTextAlignment(.center)
            ForEach(model.partial, id: \.self) { e in
                Text(e).mgFont(.meta).foregroundStyle(Color.mgDanger).multilineTextAlignment(.center)
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder private func thumbnail(_ item: Outgoing) -> some View {
        if case .file(let f) = item, f.mime.hasPrefix("image/"), let img = UIImage(data: f.data) {
            Image(uiImage: img).resizable().scaledToFill().frame(width: 44, height: 44).clipShape(RoundedRectangle(cornerRadius: 6))
        } else {
            Image(systemName: item.icon).frame(width: 44, height: 44).background(RoundedRectangle(cornerRadius: 6).fill(Color.mgSurface2)).foregroundStyle(Color.mgMuted)
        }
    }

    private func kind(_ item: Outgoing) -> String {
        switch item {
        case .file(let f): return ByteCountFormatter.string(fromByteCount: Int64(f.data.count), countStyle: .file)
        case .note: return String(localized: "Saved as a note")
        case .link: return String(localized: "Saved as a web page")
        }
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
