import Foundation

/// Notes: read through JavaScript for Automation (`osascript -l JavaScript`, run as a child of this app so macOS asks
/// about "My Graph" controlling Notes). Only the folders chosen; locked notes and Recently Deleted never. Plain text
/// only. Cursor: the newest modification date sent.
struct NotesSource: MacSource {
    let id = SourceID.notes

    func permission() -> Permission { Permissions.notesAutomation() }

    static let listScript = """
    function run(argv) {
      var Notes = Application('Notes');
      var out = [], seen = {};
      function walk(f) {
        var id = f.id(); if (seen[id]) return; seen[id] = true;
        var ids = f.notes.id(), names = f.notes.name(), cr = f.notes.creationDate(), mo = f.notes.modificationDate(), lk = [];
        try { lk = f.notes.passwordProtected(); } catch (e) { lk = []; }
        var notes = [];
        for (var i = 0; i < ids.length; i++) notes.push({ id: ids[i], title: names[i], createdAt: cr[i], updatedAt: mo[i], locked: !!lk[i] });
        out.push({ id: id, name: f.name(), notes: notes });
        var subs = f.folders(); for (var k = 0; k < subs.length; k++) walk(subs[k]);
      }
      var accounts = Notes.accounts();
      for (var a = 0; a < accounts.length; a++) { var fs = accounts[a].folders(); for (var j = 0; j < fs.length; j++) walk(fs[j]); }
      return JSON.stringify(out);
    }
    """

    static let bodiesScript = """
    function run(argv) {
      var Notes = Application('Notes');
      var want = JSON.parse(argv[0]); var fid = argv[1]; var out = {}; var w = {};
      for (var i = 0; i < want.length; i++) w[want[i]] = true;
      try { var f = Notes.folders.byId(fid); var ids = f.notes.id(); var texts = f.notes.plaintext();
        for (var j = 0; j < ids.length; j++) if (w[ids[j]]) out[ids[j]] = texts[j]; } catch (e) {}
      for (var k = 0; k < want.length; k++) if (!(want[k] in out)) { try { out[want[k]] = Notes.notes.byId(want[k]).plaintext(); } catch (e) {} }
      return JSON.stringify(out);
    }
    """

    /// Every folder with its notes' ids, titles and dates (no text).
    func folders() async throws -> [NotesPick.Folder] {
        let data = try await Self.jxa(Self.listScript, args: [])
        struct F: Decodable { let id: String; let name: String; let notes: [N] }
        struct N: Decodable { let id: String; let title: String?; let createdAt: String?; let updatedAt: String?; let locked: Bool? }
        let list = try JSONDecoder().decode([F].self, from: data)
        return list.map { f in
            NotesPick.Folder(id: f.id, name: f.name, notes: f.notes.map {
                NotesPick.Note(id: $0.id, title: $0.title ?? "", createdAt: AppleTime.parseISO($0.createdAt),
                               updatedAt: AppleTime.parseISO($0.updatedAt), locked: $0.locked ?? false)
            })
        }
    }

    func bodies(folderId: String, ids: [String]) async throws -> [String: String] {
        let want = String(data: try JSONEncoder().encode(ids), encoding: .utf8) ?? "[]"
        let data = try await Self.jxa(Self.bodiesScript, args: [want, folderId])
        return (try? JSONDecoder().decode([String: String].self, from: data)) ?? [:]
    }

    func run(_ ctx: SyncContext) async throws -> SourceResult {
        let all = try await folders()
        var settings = ctx.settings
        let counts = NotesPick.counts(all)
        if let fresh = try? await ctx.reportCatalog(folders: counts, canRead: ["notes": true]) {
            settings.noteFolders = fresh.noteFolders
            settings.serverCursor[.notes] = fresh.serverCursor[.notes]; settings.generation[.notes] = fresh.generation[.notes]
        }
        guard settings.isOn(.notes) else { return SourceResult(sent: 0) }
        let allowed = settings.noteFolders
        let local = ctx.store.load()[.notes]
        let generation = settings.generation[.notes] ?? 0
        var cursor = AppleTime.parseISO(settings.serverCursor[.notes])
        if cursor == nil, local.generation == generation { cursor = AppleTime.parseISO(local.cursor) }
        let (picked, newest) = NotesPick.pick(all, allowed: allowed, cursor: cursor)

        var notes: [NoteItem] = []
        let byFolder = Dictionary(grouping: picked, by: \.folderId)
        var texts: [String: String] = [:]
        for (fid, list) in byFolder {
            for chunk in stride(from: 0, to: list.count, by: 200).map({ Array(list[$0..<min($0 + 200, list.count)]) }) {
                texts.merge(try await bodies(folderId: fid, ids: chunk.map(\.note.id))) { a, _ in a }
            }
        }
        for p in picked {
            guard let text = texts[p.note.id] else { continue }
            notes.append(NoteItem(id: String(p.note.id.prefix(300)), title: String(p.note.title.prefix(500)), folder: String(p.folder.prefix(300)),
                                  createdAt: AppleTime.iso(p.note.createdAt), updatedAt: AppleTime.iso(p.note.updatedAt),
                                  text: String(text.replacingOccurrences(of: "\r\n", with: "\n").prefix(500_000))))
        }
        let batches = PhoneImportKit.batches(notes, maxBytes: ctx.maxBytes, maxCount: 20_000)
        let list = batches.isEmpty ? [[]] : batches
        for (i, b) in list.enumerated() {
            let final = i == list.count - 1
            let label = b.isEmpty ? "n-none" : "n-\(b.first?.updatedAt ?? "")-\(b.last?.updatedAt ?? "")-\(b.count)"
            let batch = MacBatch(runId: ctx.runId, batch: batchName(label), final: final, device: ctx.device,
                                 notesCursor: final ? AppleTime.iso(newest) : nil, data: AppleNotesData(notes: b))
            _ = try await ctx.api.importBatch(.apple_notes, batch)
        }
        ctx.store.update { s in s[.notes].cursor = AppleTime.iso(newest); s[.notes].generation = generation }
        return SourceResult(sent: notes.count)
    }

    /// Runs a JXA script with arguments and returns what it printed (JSON). Ten minutes at most.
    static func jxa(_ script: String, args: [String]) async throws -> Data {
        try await Task.detached(priority: .utility) {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
            p.arguments = ["-l", "JavaScript", "-e", script] + args
            let out = Pipe(), err = Pipe()
            p.standardOutput = out
            p.standardError = err
            try p.run()
            let timer = DispatchWorkItem { if p.isRunning { p.terminate() } }
            DispatchQueue.global().asyncAfter(deadline: .now() + 600, execute: timer)
            let data = out.fileHandleForReading.readDataToEndOfFile()
            let errData = err.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            timer.cancel()
            if p.terminationStatus != 0 {
                let text = String(decoding: errData, as: UTF8.self)
                if text.contains("-1743") || text.localizedCaseInsensitiveContains("not authorized") || text.localizedCaseInsensitiveContains("not allowed") {
                    UserDefaults.standard.set(false, forKey: "mg.notesAllowed")
                    throw SourceError.permission(.denied)
                }
                throw SourceError.failed(L("Notes couldn't be read: \(String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200)))"))
            }
            UserDefaults.standard.set(true, forKey: "mg.notesAllowed")
            return data
        }.value
    }
}
