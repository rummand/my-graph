import SwiftUI
import UIKit

/// One library item: a preview, what the assistant learned from it, and what it proposes.
struct LibraryItemView: View {
    let sourceId: String
    @Environment(Router.self) private var router
    @Environment(AppModel.self) private var app
    @State private var detail: LibraryDetail?
    @State private var error: String?
    @State private var image: UIImage?
    @State private var previewURL: URL?
    @State private var opening = false
    @State private var showText = false

    var body: some View {
        ScrollView {
            if let d = detail { content(d) }
            else if let error { ErrorStateView(message: error) { await load() }.frame(maxWidth: .infinity) }
            else { ProgressView().padding(.top, 60).frame(maxWidth: .infinity) }
        }
        .background(Color.mgBg)
        .refreshable { await load() }
        .navigationTitle(Text(detail?.source.title ?? ""))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if detail != nil {
                ToolbarItem(placement: .primaryAction) {
                    Button { Task { await openOriginal() } } label: {
                        if opening { ProgressView() } else { Image(systemName: "arrow.up.forward.square") }
                    }
                    .accessibilityLabel(Text("Open the original"))
                }
            }
        }
        .sheet(item: Binding(get: { previewURL.map(IdentifiedURL.init) }, set: { previewURL = $0?.url })) { u in
            QuickLookView(url: u.url).ignoresSafeArea()
        }
        .task { await load() }
    }

    @ViewBuilder
    private func content(_ d: LibraryDetail) -> some View {
        let s = d.source
        VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 6) {
                Text(s.title).mgFont(.title).foregroundStyle(Color.mgFg).accessibilityAddTraits(.isHeader)
                HStack(spacing: 6) {
                    if let c = s.createdAt { Text(String(localized: "Added \(Fmt.relative(c))")).mgFont(.secondary).foregroundStyle(Color.mgMuted) }
                    if let o = s.ownerName { Text(String(localized: "by \(o)")).mgFont(.secondary).foregroundStyle(Color.mgMuted) }
                    StateBadge(text: Fmt.visibilityLabel(s.visibility), tone: .muted)
                }
                if s.status == "pending" || s.status == "processing" {
                    NoticeBar(text: String(localized: "The assistant is still reading this. Pull down to check again."), tone: .warn)
                }
                if s.status == "failed" {
                    NoticeBar(text: s.error ?? String(localized: "This file couldn't be read."), tone: .danger)
                }
            }
            .padding(.top, 8)

            if let image {
                Image(uiImage: image).resizable().scaledToFit()
                    .frame(maxWidth: .infinity, maxHeight: 360)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .onTapGesture { Task { await openOriginal() } }
                    .accessibilityLabel(Text("Photo: \(s.title)"))
                    .accessibilityAddTraits(.isButton)
            }

            if let p = d.proposal, (p.total ?? 0) > 0 {
                VStack(alignment: .leading, spacing: 10) {
                    SectionHeader("Proposed changes")
                    Panel {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(proposalLine(p)).mgFont(.body)
                            Text(proposalStatus(p.status)).mgFont(.secondary).foregroundStyle(p.status == "delivered" ? Color.mgMuted : Color.mgWarn)
                            if p.changeSetId != nil {
                                Button("Review in Changes") { router.push(.changes) }
                                    .buttonStyle(MGButtonStyle(kind: .secondary, compact: true))
                            }
                        }
                    }
                }
            }

            if let ents = d.entities, !ents.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    SectionHeader("What was learned")
                    VStack(spacing: 0) {
                        ForEach(ents) { e in
                            Button { router.push(e.type == "person" ? .person(e.id) : .node(e.id)) } label: {
                                HStack(alignment: .top, spacing: 10) {
                                    if e.type == "person" { Avatar(name: e.label, id: e.id, size: 28) }
                                    else { Circle().fill(Color.nodeType(e.type)).frame(width: 8, height: 8).frame(width: 28, height: 22) }
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(e.label).mgFont(.bodyStrong).foregroundStyle(Color.mgFg)
                                        if let sum = e.summary { Text(sum).mgFont(.secondary).foregroundStyle(Color.mgMuted).lineLimit(3).multilineTextAlignment(.leading) }
                                    }
                                    Spacer(minLength: 0)
                                }
                                .padding(.vertical, 9)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 12)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.mgSurface))
                }
            }

            if let facts = d.facts, !facts.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    SectionHeader("Facts")
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(facts) { f in
                            VStack(alignment: .leading, spacing: 4) {
                                HStack(spacing: 4) {
                                    Text(f.from.label).mgFont(.bodyStrong)
                                    Text(Fmt.relationWord(f.relation)).mgFont(.body).foregroundStyle(Color.mgMuted)
                                    Text(f.to.label).mgFont(.bodyStrong)
                                    Spacer(minLength: 0)
                                    if f.status == "inferred" { StateBadge(text: String(localized: "Inferred"), tone: .inferred) }
                                }
                                if let q = f.quote {
                                    Text("“\(q)”").mgFont(.secondary).foregroundStyle(Color.mgMuted)
                                        .padding(.leading, 10)
                                        .overlay(alignment: .leading) { Rectangle().fill(Color.mgAccent.opacity(0.5)).frame(width: 2) }
                                }
                            }
                            .padding(.vertical, 9)
                        }
                    }
                    .padding(.horizontal, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.mgSurface))
                }
            }

            if let text = s.textContent, !text.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    SectionHeader("Text") {
                        Button(showText ? "Show less" : "Show all") { withAnimation(.easeOut(duration: 0.2)) { showText.toggle() } }
                            .mgFont(.secondaryStrong)
                    }
                    Panel {
                        Text(text).mgFont(.secondary).foregroundStyle(Color.mgFg).lineLimit(showText ? nil : 8).textSelection(.enabled)
                    }
                }
            }

            Button { router.push(.askAbout(id: s.nodeId ?? s.id, label: s.title, type: "document")) } label: {
                Label("Ask about this", systemImage: "sparkle")
            }
            .buttonStyle(MGButtonStyle(kind: .secondary))
            .disabled(s.nodeId == nil)
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 32)
    }

    private func proposalLine(_ p: SourceProposal) -> String {
        let c = p.counts ?? [:]
        var parts: [String] = []
        if let n = c["events"], n > 0 { parts.append(n == 1 ? String(localized: "1 event") : String(localized: "\(n) events")) }
        if let n = c["reminders"], n > 0 { parts.append(n == 1 ? String(localized: "1 reminder") : String(localized: "\(n) reminders")) }
        if let n = c["people"], n > 0 { parts.append(n == 1 ? String(localized: "1 person") : String(localized: "\(n) people")) }
        if let n = c["connections"], n > 0 { parts.append(n == 1 ? String(localized: "1 connection") : String(localized: "\(n) connections")) }
        if parts.isEmpty { return String(localized: "\(p.total ?? 0) changes found in this file") }
        return String(localized: "Found \(ListFormatter.localizedString(byJoining: parts)).")
    }

    private func proposalStatus(_ s: String?) -> String {
        switch s {
        case "delivered": return String(localized: "Added to the graph.")
        case "abandoned": return String(localized: "Dropped.")
        default: return String(localized: "Waiting for you to look it over. Nothing is added until you say so.")
        }
    }

    private func load() async {
        do {
            let d: LibraryDetail = try await API.shared.get("/api/library/\(sourceId)")
            detail = d; error = nil
            if image == nil, d.source.category == "image" || (d.source.mime ?? "").hasPrefix("image/"),
               let (data, _) = try? await API.shared.fileData(sourceId) { image = UIImage(data: data) }
        } catch {
            if !error.isCancellation, detail == nil { self.error = error.plainMessage }
        }
    }

    private func openOriginal() async {
        guard let s = detail?.source else { return }
        opening = true; defer { opening = false }
        do {
            let (data, _) = try await API.shared.fileData(s.id)
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent(s.id, isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let url = dir.appendingPathComponent(s.title.replacingOccurrences(of: "/", with: "-"))
            try data.write(to: url, options: [.atomic, .completeFileProtection])
            previewURL = url
        } catch {
            app.banner = error.plainMessage
        }
    }
}

struct IdentifiedURL: Identifiable { let url: URL; var id: String { url.absoluteString } }
