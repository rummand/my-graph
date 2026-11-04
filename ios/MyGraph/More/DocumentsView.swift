import SwiftUI

/// Documents made from the graph (reports, letters, plans). Read-only on the phone: they're written and published
/// on the web.
struct DocumentsView: View {
    @Environment(\.openURL) private var openURL
    @State private var docs: [DocumentSummary]?
    @State private var error: String?

    var body: some View {
        List {
            if let docs {
                if docs.isEmpty {
                    EmptyStateView(title: "No documents yet",
                                   message: "Documents you or the assistant write from this graph, like a summary for a meeting, show up here. You make them on the web.",
                                   systemImage: "doc.richtext")
                        .listRowBackground(Color.clear)
                }
                let mine = docs.filter { $0.isMine == true }
                let shared = docs.filter { $0.isMine != true }
                if !mine.isEmpty { Section { ForEach(mine) { row($0) } } header: { Text("Yours") } }
                if !shared.isEmpty { Section { ForEach(shared) { row($0) } } header: { Text("Shared with you") } }
            } else if let error {
                ErrorStateView(message: error) { await load() }.listRowBackground(Color.clear)
            } else {
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .refreshable { await load() }
        .navigationTitle(Text("Documents"))
        .task { await load() }
    }

    private func row(_ d: DocumentSummary) -> some View {
        Button { openURL(API.shared.url("/artifacts/\(d.id)")) } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text(d.title).mgFont(.bodyStrong).foregroundStyle(Color.mgFg)
                HStack(spacing: 6) {
                    StateBadge(text: statusLabel(d), tone: d.status == "published" ? .muted : .warn)
                    if let o = d.ownerName, d.isMine != true { Text(o).mgFont(.meta).foregroundStyle(Color.mgMuted) }
                    if let u = d.updatedAt { Text(Fmt.relative(u)).mgFont(.meta).foregroundStyle(Color.mgMuted) }
                }
            }
            .padding(.vertical, 2)
        }
        .listRowBackground(Color.mgSurface)
        .accessibilityHint(Text("Opens on the web"))
    }

    private func statusLabel(_ d: DocumentSummary) -> String {
        if d.drafting == true { return String(localized: "Being written") }
        switch d.status {
        case "published": return String(localized: "Published")
        default: return String(localized: "Draft")
        }
    }

    private func load() async {
        do {
            let r: DocumentsResponse = try await API.shared.get("/api/artifacts")
            docs = r.artifacts; error = nil
        } catch let e as APIError {
            if case .notFound = e { docs = [] } else if docs == nil { error = e.plainMessage }
        } catch {
            if !error.isCancellation, docs == nil { self.error = error.plainMessage }
        }
    }
}
