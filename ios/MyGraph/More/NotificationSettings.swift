import SwiftUI

/// `GET/PATCH /api/devices/settings`: what the server pushes to this person's iPhones, and their quiet hours.
struct PushSettingsResponse: Decodable {
    struct Settings: Decodable {
        var enabled: Bool
        var categories: [String: Bool]
        var quietHours: Quiet?
    }
    struct Quiet: Decodable { var start: String?; var end: String? }
    var push: Bool
    var remindersByPush: Bool
    var settings: Settings
    var practice: Bool?
}

/// The server-side notification settings, shown in Settings when the server can push. Changes save right away.
struct PushSettingsSection: View {
    @State private var data: PushSettingsResponse?
    @State private var error: String?

    var body: some View {
        Group {
            if let d = data, d.push {
                Section {
                    Toggle("Notifications from My Graph", isOn: bind { $0.settings.enabled } set: { d, v in d.settings.enabled = v; return ["enabled": v] })
                        .listRowBackground(Color.mgSurface)
                    if d.settings.enabled {
                        category("reminders", String(localized: "Reminders when they're due"))
                        category("waiting", String(localized: "Suggestions and changes waiting for you"))
                        category("connections", String(localized: "Connections that need you"))
                        if d.practice == true { category("clinical", String(localized: "Practice: something to review")) }
                    }
                } header: { Text("Sent by My Graph") } footer: {
                    Text("Suggestions and changes come together in one notification, at most as many a day as your assistant may suggest. Anything sensitive only says there is something to look at.")
                }
                if d.settings.enabled {
                    Section {
                        Toggle("Quiet hours", isOn: Binding(get: { d.settings.quietHours != nil }, set: { on in
                            Task { await save(on ? ["quietHours": ["start": "22:00", "end": "07:00"]] : ["quietHours": NSNull()]) }
                        }))
                        .listRowBackground(Color.mgSurface)
                        if let q = d.settings.quietHours {
                            DatePicker("From", selection: clock(q.start ?? "22:00") { s in ["quietHours": ["start": s, "end": q.end ?? "07:00"]] }, displayedComponents: .hourAndMinute)
                                .listRowBackground(Color.mgSurface)
                            DatePicker("Until", selection: clock(q.end ?? "07:00") { s in ["quietHours": ["start": q.start ?? "22:00", "end": s]] }, displayedComponents: .hourAndMinute)
                                .listRowBackground(Color.mgSurface)
                        }
                    } footer: { Text("Nothing arrives in quiet hours. What fell due waits until they end.") }
                }
            }
            if let error {
                Section { Text(error).mgFont(.secondary).foregroundStyle(Color.mgMuted).listRowBackground(Color.mgSurface) }
            }
        }
        .task { await load() }
    }

    private func category(_ key: String, _ label: String) -> some View {
        Toggle(label, isOn: bind { $0.settings.categories[key] ?? true } set: { d, v in d.settings.categories[key] = v; return ["categories": [key: v]] })
            .listRowBackground(Color.mgSurface)
    }

    /// A toggle bound to the loaded settings: flips it at once, then saves the patch it returns.
    private func bind(_ get: @escaping (PushSettingsResponse) -> Bool, set: @escaping (inout PushSettingsResponse, Bool) -> [String: Any]) -> Binding<Bool> {
        Binding(get: { data.map(get) ?? false }, set: { v in
            guard var d = data else { return }
            let patch = set(&d, v)
            data = d
            Task { await save(patch) }
        })
    }

    private func clock(_ hhmm: String, patch: @escaping (String) -> [String: Any]) -> Binding<Date> {
        Binding(get: { Self.date(hhmm) }, set: { d in Task { await save(patch(Self.hhmm(d))) } })
    }

    static func date(_ s: String) -> Date {
        let p = s.split(separator: ":").compactMap { Int($0) }
        return Calendar.current.date(bySettingHour: p.first ?? 22, minute: p.count > 1 ? p[1] : 0, second: 0, of: Date()) ?? Date()
    }

    static func hhmm(_ d: Date) -> String {
        let c = Calendar.current.dateComponents([.hour, .minute], from: d)
        return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
    }

    private func load() async {
        do { data = try await API.shared.get("/api/devices/settings"); error = nil } catch {
            // A server without push settings: nothing to show (local reminders still work).
            if case APIError.notFound = error { data = nil } else if !error.isCancellation { self.error = error.plainMessage }
        }
    }

    private func save(_ patch: [String: Any]) async {
        do {
            let r: PushSettingsResponse = try await API.shared.call("PATCH", "/api/devices/settings", json: patch)
            data = r
            error = nil
            await PushRegistration.apply(remindersByPush: r.remindersByPush)
        } catch {
            self.error = error.plainMessage
            await load()
        }
    }
}
