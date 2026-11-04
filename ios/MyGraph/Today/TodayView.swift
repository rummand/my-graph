import SwiftUI
import UserNotifications

struct TodayView: View {
    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
    @State private var model = TodayModel()
    @State private var askNotifications = false

    var body: some View {
        ScrollView {
            // A plain VStack: Today is a handful of sections, and a lazy stack's height estimates could loop forever
            // when cards change height (seen under XCUITest while scrolling).
            VStack(alignment: .leading, spacing: 28) {
                header
                if let e = model.error, model.snap != nil {
                    NoticeBar(text: app.isOffline ? offlineText : e, tone: app.isOffline ? .muted : .danger)
                }
                if askNotifications { notificationsCard }
                if let snap = model.snap {
                    connections(snap)
                    waiting(snap)
                    brief(snap)
                    week
                    todos(snap)
                    attention(snap)
                    recent(snap)
                } else if model.loading {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                } else if let e = model.error {
                    ErrorStateView(message: e) { await model.load(app: app) }
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 32)
        }
        .refreshable { await model.load(app: app) }
        .navigationTitle(Text("Today"))
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await model.load(app: app)
            askNotifications = await ReminderNotifications.shouldAsk()
        }
    }

    private var offlineText: String {
        if let d = model.fromCache { return String(localized: "Offline. Showing what was here \(Fmt.relative(d)).") }
        return String(localized: "You're offline. Showing what was saved on this iPhone.")
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            // The server writes the greeting in the account's language; offline, the app writes its own.
            Text(model.snap?.greeting?.text ?? app.firstName.map { "\(Fmt.greeting()), \($0)" } ?? Fmt.greeting())
                .mgFont(.title).foregroundStyle(Color.mgFg)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("today.greeting")
            Text(model.snap?.greeting?.date ?? Fmt.longDate(Date())).mgFont(.body).foregroundStyle(Color.mgMuted)
        }
        .padding(.top, 8)
    }

    // MARK: Notifications

    private var notificationsCard: some View {
        Panel {
            VStack(alignment: .leading, spacing: 10) {
                Text("Get a nudge when something is due").mgFont(.bodyStrong)
                Text("My Graph can remind you on this iPhone when a reminder is due, like a permission slip or a birthday. Nothing else.")
                    .mgFont(.secondary).foregroundStyle(Color.mgMuted)
                HStack(spacing: 8) {
                    Button("Turn on reminders") {
                        Task {
                            _ = await ReminderNotifications.requestPermission()
                            askNotifications = false
                            if let r = model.snap?.reminders { await ReminderNotifications.schedule(r) }
                        }
                    }
                    .buttonStyle(MGButtonStyle(kind: .primary, compact: true))
                    Button("Not now") { ReminderNotifications.declineAsking(); askNotifications = false }
                        .buttonStyle(MGButtonStyle(kind: .ghost, compact: true))
                }
            }
        }
    }

    // MARK: Waiting for you

    @ViewBuilder
    private func waiting(_ snap: TodaySnapshot) -> some View {
        let sets = model.changeSets ?? []
        if !snap.suggestions.isEmpty || !sets.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeader("Waiting for you") {
                    Text("\(snap.suggestions.count + sets.count)").mgFont(.secondaryStrong).foregroundStyle(Color.mgWarn)
                        .accessibilityLabel(Text("\(snap.suggestions.count + sets.count) waiting"))
                }
                ForEach(sets) { c in
                    ChangeSetCard(set: c, busy: model.deciding.contains(c.id), canDecide: app.canWrite, open: { router.push(.changeSet(c.id)) }) { action in
                        Task {
                            if let e = await model.decide(c, action) { app.banner = e; Haptics.warning() } else if action == "deliver" { Haptics.success() }
                        }
                    }
                }
                ForEach(snap.suggestions) { s in
                    SuggestionCard(suggestion: s, busy: model.deciding.contains(s.id), canDecide: app.canWrite) { decision in
                        Task {
                            let (out, err) = await model.decide(s, decision)
                            if let err { app.banner = err; Haptics.warning(); return }
                            if decision != "deny" { Haptics.success() }
                            if decision != "deny", let r = Route.fromWebHref(out?.href) { router.push(r) }
                        }
                    }
                    .transition(.asymmetric(insertion: .identity, removal: .opacity.combined(with: .move(edge: .leading))))
                }
            }
            .animation(.easeOut(duration: 0.22), value: snap.suggestions)
            .animation(.easeOut(duration: 0.22), value: model.changeSets)
        }
    }

    // MARK: Connections that need you

    @ViewBuilder
    private func connections(_ snap: TodaySnapshot) -> some View {
        if let list = snap.connections, !list.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(list) { c in
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: "exclamationmark.arrow.triangle.2.circlepath").foregroundStyle(Color.mgWarn).accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(c.label) needs you").mgFont(.bodyStrong)
                            Text(c.detail ?? String(localized: "Sign in to it again on the web, under Connections, so it can keep bringing things in."))
                                .mgFont(.secondary).foregroundStyle(Color.mgMuted)
                        }
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.mgWarnTint))
                }
            }
        }
    }

    // MARK: Needs attention

    @ViewBuilder
    private func attention(_ snap: TodaySnapshot) -> some View {
        if let a = snap.attention, a.total > 0 {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeader("Needs attention") {
                    Text("\(a.total)").mgFont(.secondaryStrong).foregroundStyle(Color.mgWarn)
                }
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(a.facts) { f in
                        Button { router.push(.node(f.nodeId)) } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(f.text).mgFont(.body).foregroundStyle(Color.mgFg).multilineTextAlignment(.leading)
                                Text(f.sourceTitle.map { String(localized: "Not sure yet · from \($0)") } ?? String(localized: "Not sure yet"))
                                    .mgFont(.meta).foregroundStyle(Color.mgMuted)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, 8)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                    if let n = a.failedUploads, n > 0 {
                        Text(n == 1 ? String(localized: "1 upload couldn't be read") : String(localized: "\(n) uploads couldn't be read"))
                            .mgFont(.secondary).foregroundStyle(Color.mgWarn).padding(.vertical, 8)
                    }
                    if let n = a.duplicates, n > 0 {
                        Text(n == 1 ? String(localized: "1 possible duplicate to check on the web") : String(localized: "\(n) possible duplicates to check on the web"))
                            .mgFont(.secondary).foregroundStyle(Color.mgMuted).padding(.vertical, 8)
                    }
                }
                .padding(.horizontal, 12)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.mgSurface))
            }
        }
    }

    // MARK: Brief

    @ViewBuilder
    private func brief(_ snap: TodaySnapshot) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader("Your brief") {
                if snap.brief != nil {
                    Button { Task { await model.writeBrief(refresh: true) } } label: {
                        Image(systemName: "arrow.clockwise").font(.system(size: 14, weight: .semibold))
                    }
                    .disabled(model.briefBusy)
                    .accessibilityLabel(Text("Write a new brief"))
                }
            }
            Panel {
                if model.briefBusy {
                    HStack(spacing: 10) { ProgressView(); Text("Writing today's brief…").foregroundStyle(Color.mgMuted) }
                } else if let b = snap.brief {
                    VStack(alignment: .leading, spacing: 12) {
                        RichTextView(text: b.text, citations: b.citations ?? [])
                        CitationRow(citations: b.citations ?? [])
                    }
                } else {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("A short read on what matters today, with a source for every line.").mgFont(.secondary).foregroundStyle(Color.mgMuted)
                        Button("Write today's brief") { Task { await model.writeBrief(refresh: false) } }
                            .buttonStyle(MGButtonStyle(kind: .secondary, compact: true))
                            .disabled(app.isOffline)
                    }
                }
                if let e = model.briefError {
                    Text(e).mgFont(.secondary).foregroundStyle(Color.mgDanger).padding(.top, 8)
                }
            }
        }
    }

    // MARK: This week

    @ViewBuilder
    private var week: some View {
        let groups = model.weekGroups
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader("This week")
            if groups.isEmpty {
                Text("Nothing on the calendar for the next seven days.").mgFont(.secondary).foregroundStyle(Color.mgMuted)
            }
            ForEach(groups) { g in
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        if let pid = g.personId { Avatar(name: g.name, id: pid, size: 26) } else {
                            Image(systemName: "house").font(.system(size: 13)).frame(width: 26, height: 26)
                                .background(Circle().fill(Color.mgSurface2)).foregroundStyle(Color.mgMuted).accessibilityHidden(true)
                        }
                        Text(g.name).mgFont(.bodyStrong)
                    }
                    VStack(spacing: 0) {
                        ForEach(g.entries) { e in
                            Button { if let r = e.route { router.push(r) } } label: {
                                HStack(alignment: .firstTextBaseline, spacing: 12) {
                                    Text(Fmt.shortDay(e.at)).mgFont(.secondary).foregroundStyle(Color.mgMuted)
                                        .frame(width: 92, alignment: .leading)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(e.title).mgFont(.body).foregroundStyle(Color.mgFg).multilineTextAlignment(.leading)
                                        if !e.allDay || e.isReminder {
                                            Text(e.isReminder ? String(localized: "Reminder at \(Fmt.time(e.at))") : Fmt.time(e.at))
                                                .mgFont(.meta).foregroundStyle(Color.mgMuted)
                                        }
                                    }
                                    Spacer(minLength: 0)
                                }
                                .padding(.vertical, 8)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .disabled(e.route == nil)
                        }
                    }
                    .padding(.horizontal, 12)
                    .background(
                        RoundedRectangle(cornerRadius: 8).fill(Color.mgSurface)
                            .overlay(alignment: .leading) {
                                if let pid = g.personId { Rectangle().fill(PersonColor.solid(pid)).frame(width: 3).clipShape(RoundedRectangle(cornerRadius: 2)) }
                            }
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                    )
                }
            }
        }
    }

    // MARK: To-dos

    @ViewBuilder
    private func todos(_ snap: TodaySnapshot) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader("To-dos")
            if snap.reminders.isEmpty {
                Text("Nothing to do in the next two weeks. Reminders you or the assistant add show up here.")
                    .mgFont(.secondary).foregroundStyle(Color.mgMuted)
            } else {
                VStack(spacing: 0) {
                    ForEach(snap.reminders) { r in
                        ReminderRow(reminder: r) {
                            Task {
                                Haptics.success()
                                if let e = await model.complete(r) { app.banner = e }
                            }
                        } open: {
                            if let n = r.aboutNodeId { router.push(.person(n)) }
                        }
                        .transition(.asymmetric(insertion: .identity, removal: .opacity.combined(with: .scale(scale: 0.98, anchor: .top))))
                        if r.id != snap.reminders.last?.id { Divider().overlay(Color.mgLine).padding(.leading, 44) }
                    }
                }
                .padding(.horizontal, 12)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.mgSurface))
                .animation(.easeOut(duration: 0.22), value: snap.reminders)
            }
        }
    }

    // MARK: Recently added

    @ViewBuilder
    private func recent(_ snap: TodaySnapshot) -> some View {
        if !snap.recent.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeader("Recently added")
                VStack(spacing: 0) {
                    ForEach(snap.recent) { item in
                        Button { router.push(.source(item.id)) } label: { LibraryRow(item: item, compact: true) }
                            .buttonStyle(.plain)
                    }
                }
            }
        }
    }
}

struct ReminderRow: View {
    let reminder: Reminder
    let done: () -> Void
    var open: (() -> Void)?
    @State private var ticked = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Button {
                ticked = true
                done()
            } label: {
                Image(systemName: ticked ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 22, weight: .regular))
                    .foregroundStyle(ticked ? Color.mgAccent : Color.mgMuted)
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("Mark done: \(reminder.title)"))
            .accessibilityIdentifier("todo.tick.\(reminder.id)")
            VStack(alignment: .leading, spacing: 3) {
                Text(reminder.title).mgFont(.body).foregroundStyle(Color.mgFg).strikethrough(ticked)
                HStack(spacing: 8) {
                    let overdue = reminder.dueAt < Date()
                    Text(overdue ? String(localized: "Overdue, \(Fmt.when(reminder.dueAt))") : Fmt.when(reminder.dueAt))
                        .mgFont(.meta).foregroundStyle(overdue ? Color.mgWarn : Color.mgMuted)
                    if let about = reminder.aboutLabel, let id = reminder.aboutNodeId {
                        Button { open?() } label: { PersonChip(name: about, id: id) }.buttonStyle(.plain)
                    }
                }
            }
            .padding(.vertical, 6)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .contain)
    }
}

struct SuggestionCard: View {
    let suggestion: Suggestion
    let busy: Bool
    var canDecide = true
    let decide: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                StateBadge(text: suggestion.kindLabel ?? kindLabel, tone: .warn)
                if let o = suggestion.originLabel ?? suggestion.origin.map(originLabel) { Text(o).mgFont(.meta).foregroundStyle(Color.mgMuted) }
            }
            Text(suggestion.title).mgFont(.bodyStrong).foregroundStyle(Color.mgFg)
            if let b = suggestion.body, !b.isEmpty { Text(b).mgFont(.secondary).foregroundStyle(Color.mgMuted) }
            CitationRow(citations: suggestion.citations ?? [])
            if canDecide {
                HStack(spacing: 8) { buttons }
                    .disabled(busy)
            } else {
                Text("Someone who can edit this graph decides on this.").mgFont(.meta).foregroundStyle(Color.mgMuted)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.mgSurface))
        .overlay(alignment: .leading) { Rectangle().fill(Color.mgWarn).frame(width: 3).clipShape(RoundedRectangle(cornerRadius: 2)) }
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("suggestion.\(suggestion.id)")
    }

    @ViewBuilder private var buttons: some View {
        approve
        always
        deny
        if busy { ProgressView().padding(.leading, 4) }
    }
    private var approve: some View {
        Button("Approve") { decide("approve") }.buttonStyle(MGButtonStyle(kind: .primary, compact: true))
            .accessibilityIdentifier("suggestion.approve")
    }
    private var always: some View {
        Button(suggestion.alwaysLabel ?? String(localized: "Always allow")) { decide("always") }.buttonStyle(MGButtonStyle(kind: .secondary, compact: true))
            .accessibilityIdentifier("suggestion.always")
    }
    private var deny: some View {
        Button("Deny") { decide("deny") }.buttonStyle(MGButtonStyle(kind: .ghost, compact: true))
            .accessibilityIdentifier("suggestion.deny")
    }

    private var kindLabel: String {
        switch suggestion.kind {
        case "nudge": return String(localized: "Nudge")
        case "reminder": return String(localized: "Reminder")
        case "fact": return String(localized: "Fact")
        case "memory": return String(localized: "Memory")
        case "wiki": return String(localized: "Wiki note")
        default: return String(localized: "Suggestion")
        }
    }

    private func originLabel(_ o: String) -> String {
        switch o {
        case "heartbeat": return String(localized: "From the daily check-in")
        case "automation": return String(localized: "From an automation")
        case "chat": return String(localized: "From a chat")
        case "keeper": return String(localized: "From the Brain Keeper")
        default: return String(localized: "From the assistant")
        }
    }
}

struct ChangeSetCard: View {
    let set: ChangeSet
    let busy: Bool
    var canDecide = true
    var open: (() -> Void)?
    let act: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                StateBadge(text: String(localized: "Proposed changes"), tone: .warn)
                if let o = set.origin { Text(ChangeWords.origin(o)).mgFont(.meta).foregroundStyle(Color.mgMuted) }
            }
            Text(set.title).mgFont(.bodyStrong)
            if let d = set.description, !d.isEmpty { Text(d).mgFont(.secondary).foregroundStyle(Color.mgMuted) }
            let changes = (set.changes ?? []).filter { $0.included != false }
            if !changes.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(changes.prefix(4)) { c in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text("•").foregroundStyle(Color.mgMuted)
                            Text(c.summary ?? c.op).mgFont(.secondary)
                        }
                    }
                    if changes.count > 4 { Text("and \(changes.count - 4) more").mgFont(.meta).foregroundStyle(Color.mgMuted) }
                }
            }
            HStack(spacing: 8) {
                if canDecide {
                    Button(changes.count == (set.changes?.count ?? 0) ? String(localized: "Deliver") : String(localized: "Deliver \(changes.count)")) { act("deliver") }
                        .buttonStyle(MGButtonStyle(kind: .primary, compact: true))
                        .disabled(changes.isEmpty)
                        .accessibilityIdentifier("changeset.deliver")
                    Button("Drop") { act("abandon") }.buttonStyle(MGButtonStyle(kind: .ghost, compact: true))
                        .accessibilityIdentifier("changeset.drop")
                }
                if let open {
                    Button("Review") { open() }.buttonStyle(MGButtonStyle(kind: .secondary, compact: true))
                        .accessibilityIdentifier("changeset.review")
                }
                if busy { ProgressView() }
            }
            .disabled(busy)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.mgSurface))
        .overlay(alignment: .leading) { Rectangle().fill(Color.mgWarn).frame(width: 3) }
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("changeset.\(set.id)")
    }
}

/// Plain words for where a proposal came from.
enum ChangeWords {
    static func origin(_ o: String) -> String {
        switch o {
        case "chat": return String(localized: "From a chat")
        case "assistant": return String(localized: "From the assistant")
        case "connector": return String(localized: "From a connection")
        case "web": return String(localized: "From web research")
        case "ingest": return String(localized: "From an upload")
        case "automation": return String(localized: "From an automation")
        case "heartbeat": return String(localized: "From the daily check-in")
        case "keeper": return String(localized: "From the Brain Keeper")
        case "restore": return String(localized: "Bringing back an earlier version")
        default: return String(localized: "From you")
        }
    }
}
