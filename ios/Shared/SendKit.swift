import Foundation
import UniformTypeIdentifiers

/// One thing on its way into the library: a file (uploaded as it is), a note (text) or a web page (a link the server
/// reads and saves). Used by "Send to My Graph" (the share extension) and by Paste in the Library tab.
enum Outgoing: Equatable {
    case file(UploadFile)
    case note(title: String, text: String)
    case link(URL, title: String?)

    /// What the row shows before sending.
    var label: String {
        switch self {
        case .file(let f): return f.filename
        case .note(_, let text): return String(text.prefix(140))
        case .link(let u, let t): return t.map { "\($0)\n\(u.absoluteString)" } ?? u.absoluteString
        }
    }

    var icon: String {
        switch self {
        case .file(let f):
            if f.mime.hasPrefix("image/") { return "photo" }
            if f.mime == "application/pdf" { return "doc.richtext" }
            if f.mime.contains("presentation") { return "rectangle.on.rectangle" }
            if f.mime.contains("spreadsheet") || f.mime.contains("excel") || f.mime == "text/csv" { return "tablecells" }
            if f.mime.hasPrefix("audio/") { return "waveform" }
            return "doc"
        case .note: return "text.alignleft"
        case .link: return "link"
        }
    }
}

extension UploadFile: Equatable {
    static func == (a: UploadFile, b: UploadFile) -> Bool { a.filename == b.filename && a.mime == b.mime && a.data == b.data }
}

/// How a send went, in words for the person.
struct SendSummary: Equatable {
    var added = 0
    var duplicates = 0
    var errors: [String] = []

    var allFailed: Bool { added == 0 && duplicates == 0 && !errors.isEmpty }
}

enum SendKit {
    /// The server's limits (`src/lib/ingest/mime.ts`, `src/app/api/library/route.ts`, `/api/library/paste`).
    static let maxFileBytes = 50 * 1024 * 1024
    static let maxFilesPerUpload = 20
    static let maxNoteChars = 200_000

    // MARK: Pure rules (unit-tested)

    /// A web address on its own (what Notes or Messages share as text when you share a link).
    static func webURL(in text: String) -> URL? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, !t.contains(where: \.isWhitespace), let u = URL(string: t),
              let s = u.scheme?.lowercased(), s == "http" || s == "https", let h = u.host, !h.isEmpty else { return nil }
        return u
    }

    /// A note's title: its first line, at most 60 characters, or "Note".
    static func noteTitle(_ text: String) -> String {
        let first = text.split(whereSeparator: \.isNewline).lazy.map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty } ?? ""
        guard !first.isEmpty else { return String(localized: "Note") }
        if first.count <= 60 { return first }
        let cut = first.prefix(60)
        let word = cut.lastIndex(of: " ").map { cut[..<$0] } ?? cut
        return word.trimmingCharacters(in: .whitespaces) + "…"
    }

    /// Turns the pieces found in a share or a paste into what is sent:
    /// files as they are; links as web pages (titled with the text shared beside them, when there is one);
    /// text that is only a web address as a web page; all other text as one note.
    static func plan(files: [UploadFile], urls: [URL], texts: [String], title: String? = nil) -> [Outgoing] {
        var out: [Outgoing] = files.map { .file($0) }
        var links: [URL] = []
        for u in urls where !links.contains(u) { links.append(u) }
        var notes: [String] = []
        for t in texts {
            let trimmed = t.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            if let u = webURL(in: trimmed) { if !links.contains(u) { links.append(u) }; continue }
            // Text that only repeats a shared link plus its page title is the link's title, not a note.
            if let only = links.first, links.count == 1, trimmed.contains(only.absoluteString) {
                let rest = trimmed.replacingOccurrences(of: only.absoluteString, with: "").trimmingCharacters(in: .whitespacesAndNewlines)
                if rest.isEmpty || rest.count <= 300 && !rest.contains("\n") { continue }
            }
            notes.append(trimmed)
        }
        let linkTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        for u in links {
            let t = links.count == 1 && linkTitle != u.absoluteString ? linkTitle : nil
            out.append(.link(u, title: t))
        }
        if !notes.isEmpty {
            let text = notes.joined(separator: "\n\n")
            out.append(.note(title: noteTitle(text), text: String(text.prefix(maxNoteChars))))
        }
        return out
    }

    /// The body for `POST /api/library/paste`.
    static func pasteBody(_ item: Outgoing, visibility: String) -> [String: Any]? {
        switch item {
        case .file: return nil
        case .note(let title, let text):
            return ["kind": "text", "title": String(title.prefix(200)), "text": text, "visibility": visibility, "sensitive": false]
        case .link(let url, let title):
            var b: [String: Any] = ["kind": "url", "url": url.absoluteString, "visibility": visibility, "sensitive": false]
            if let title { b["title"] = String(title.prefix(300)) }
            return b
        }
    }

    /// A file's name with its extension, and its MIME type (from the extension, else the provider's type).
    static func fileInfo(suggested: String?, url: URL?, type: UTType?) -> (name: String, mime: String) {
        let ext = url?.pathExtension.nilIfEmpty ?? type?.preferredFilenameExtension ?? ""
        var name = suggested?.trimmingCharacters(in: .whitespaces).nilIfEmpty
            ?? url?.deletingPathExtension().lastPathComponent.nilIfEmpty
            ?? String(localized: "File")
        name = name.replacingOccurrences(of: "/", with: "-")
        if !ext.isEmpty, !name.lowercased().hasSuffix("." + ext.lowercased()) { name += "." + ext }
        let mime = UTType(filenameExtension: ext)?.preferredMIMEType ?? type?.preferredMIMEType ?? "application/octet-stream"
        return (name, mime)
    }

    /// Splits files into uploads of at most 20 (the server's limit per request).
    static func batches(_ files: [UploadFile]) -> [[UploadFile]] {
        stride(from: 0, to: files.count, by: maxFilesPerUpload).map { Array(files[$0..<min($0 + maxFilesPerUpload, files.count)]) }
    }

    // MARK: Reading what was shared or pasted

    /// Reads item providers (from a share or the pasteboard) into what will be sent.
    /// `title` is the text shared alongside (a page title from Safari).
    static func load(_ providers: [NSItemProvider], title: String? = nil) async -> (items: [Outgoing], skipped: [String]) {
        var files: [UploadFile] = [], urls: [URL] = [], texts: [String] = [], skipped: [String] = []
        for p in providers {
            if p.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) || isFileLike(p) {
                switch await loadFile(p) {
                case .some(.success(let f)): files.append(f); continue
                case .some(.failure(let name)): skipped.append(name); continue
                case .none: break
                }
            }
            if p.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                if let u = await loadURL(p), let s = u.scheme?.lowercased(), s == "http" || s == "https" { urls.append(u); continue }
            }
            if p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) || p.hasItemConformingToTypeIdentifier(UTType.text.identifier) {
                if let s = await loadText(p) { texts.append(s); continue }
            }
        }
        // Some apps share text only as the item's content text, with no attachment.
        if files.isEmpty, urls.isEmpty, texts.isEmpty, skipped.isEmpty, let t = title?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty {
            return (plan(files: [], urls: [], texts: [t]), [])
        }
        return (plan(files: files, urls: urls, texts: texts, title: title), skipped)
    }

    /// Photos, PDFs, Office files and any other data that isn't just text or a link.
    private static func isFileLike(_ p: NSItemProvider) -> Bool {
        p.registeredTypeIdentifiers.contains { id in
            guard let t = UTType(id) else { return false }
            if t.conforms(to: .url) || t.conforms(to: .plainText) || t.conforms(to: .text) && !t.conforms(to: .commaSeparatedText) && !t.conforms(to: .html) { return false }
            return t.conforms(to: .data) || t.conforms(to: .image)
        }
    }

    private enum FileOutcome { case success(UploadFile), failure(String) }

    private static func loadFile(_ p: NSItemProvider) async -> FileOutcome? {
        // Prefer the most specific data type the provider offers (an image or a document, not its file URL).
        let ids = p.registeredTypeIdentifiers
        let typeId = ids.first { id in
            guard let t = UTType(id) else { return false }
            return (t.conforms(to: .data) || t.conforms(to: .image)) && !t.conforms(to: .url) && !t.conforms(to: .plainText)
        } ?? (ids.contains(UTType.fileURL.identifier) ? UTType.data.identifier : nil)
        guard let typeId else { return nil }
        let type = UTType(typeId)
        // The copy handed over can have a generic name ("PDF document.pdf"); the original file's name is better.
        var suggested = p.suggestedName
        if suggested == nil, ids.contains(UTType.fileURL.identifier), let u = await loadURL(p), u.isFileURL {
            suggested = u.deletingPathExtension().lastPathComponent
        }
        return await withCheckedContinuation { c in
            _ = p.loadFileRepresentation(forTypeIdentifier: typeId) { url, _ in
                guard let url else {
                    // Some providers only hand over the bytes (an image copied from a web page).
                    p.loadDataRepresentation(forTypeIdentifier: typeId) { data, _ in
                        guard let data else { c.resume(returning: nil); return }
                        let info = fileInfo(suggested: suggested, url: nil, type: type)
                        c.resume(returning: data.count > maxFileBytes ? .failure(info.name) : .success(UploadFile(filename: info.name, mime: info.mime, data: data)))
                    }
                    return
                }
                let info = fileInfo(suggested: suggested, url: url, type: type)
                let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
                guard size <= maxFileBytes, let data = try? Data(contentsOf: url) else { c.resume(returning: .failure(info.name)); return }
                c.resume(returning: .success(UploadFile(filename: info.name, mime: info.mime, data: data)))
            }
        }
    }

    private static func loadURL(_ p: NSItemProvider) async -> URL? {
        await withCheckedContinuation { c in
            _ = p.loadObject(ofClass: URL.self) { u, _ in c.resume(returning: u) }
        }
    }

    private static func loadText(_ p: NSItemProvider) async -> String? {
        await withCheckedContinuation { c in
            _ = p.loadObject(ofClass: String.self) { s, _ in c.resume(returning: s) }
        }
    }

    // MARK: Sending

    /// Sends everything to the current graph's library: files through the normal upload (`POST /api/library`),
    /// notes and links through `POST /api/library/paste`. `progress` gets 0…1 and a line saying what is happening.
    static func send(_ items: [Outgoing], visibility: String, api: API = .shared,
                     progress: @escaping @MainActor (Double, String) -> Void) async -> SendSummary {
        var summary = SendSummary()
        let files = items.compactMap { if case .file(let f) = $0 { return f } else { return nil } }
        let others = items.filter { if case .file = $0 { return false } else { return true } }
        let fileBytes = max(1, files.reduce(0) { $0 + $1.data.count })
        // Files take their share of the bar by size; each note or link counts as a small file.
        let unit = Double(fileBytes) / Double(max(files.count, 1)) * 0.25
        let total = Double(fileBytes) + unit * Double(others.count)
        var done = 0.0

        for batch in batches(files) {
            let batchBytes = Double(batch.reduce(0) { $0 + $1.data.count })
            let line = batch.count == 1 ? String(localized: "Sending “\(batch[0].filename)”…") : String(localized: "Sending \(batch.count) files…")
            await progress(done / total, line)
            let start = done
            do {
                let r = try await api.upload(batch, visibility: visibility) { sent in
                    Task { @MainActor in progress((start + batchBytes * sent) / total, line) }
                }
                for res in r.results ?? [] {
                    if let e = res.error { summary.errors.append(e) }
                    else if res.duplicate == true { summary.duplicates += 1 }
                    else { summary.added += 1 }
                }
            } catch {
                summary.errors.append(error.plainMessage)
            }
            done += batchBytes
        }

        for item in others {
            guard let body = pasteBody(item, visibility: visibility) else { continue }
            let line: String
            if case .link(let u, _) = item { line = String(localized: "Reading \(u.host ?? u.absoluteString)…") } else { line = String(localized: "Saving the note…") }
            await progress(done / total, line)
            do {
                let (data, _) = try await api.send(api.request("POST", "/api/library/paste", json: body))
                struct Out: Decodable { let duplicate: Bool? }
                if (try? API.decoder.decode(Out.self, from: data))?.duplicate == true { summary.duplicates += 1 } else { summary.added += 1 }
            } catch {
                summary.errors.append(error.plainMessage)
            }
            done += unit
        }
        await progress(1, "")
        return summary
    }
}

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
