import SwiftUI
import UIKit

struct RootView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        ZStack {
            Color.mgBg.ignoresSafeArea()
            switch app.phase {
            case .launching:
                ProgressView().accessibilityLabel(Text("Opening My Graph"))
            case .signedOut:
                SignInView()
            case .pending:
                PendingApprovalView()
            case .signedIn:
                MainTabs()
                    .id(app.graphToken)
            }
        }
        .animation(.easeOut(duration: 0.2), value: app.phase)
    }
}

enum AppTab: Hashable { case today, ask, people, timeline, library }

/// Per-tab navigation, so a citation or row can push a screen from anywhere inside the tab.
@MainActor
@Observable
final class Router {
    var path: [Route] = []
    func push(_ r: Route) { path.append(r) }
}

struct MainTabs: View {
    @Environment(AppModel.self) private var app
    @State private var tab: AppTab = .today
    @State private var routers: [AppTab: Router] = [.today: Router(), .ask: Router(), .people: Router(), .timeline: Router(), .library: Router()]

    var body: some View {
        TabView(selection: $tab) {
            Tab(String(localized: "Today"), systemImage: "sun.max", value: AppTab.today) {
                stack(.today) { TodayView() }
            }
            Tab(String(localized: "Ask"), systemImage: "bubble.left.and.text.bubble.right", value: AppTab.ask) {
                stack(.ask) { ActiveChatView() }
            }
            Tab(String(localized: "People"), systemImage: "person.2", value: AppTab.people) {
                stack(.people) { PeopleView() }
            }
            Tab(String(localized: "Timeline"), systemImage: "calendar.day.timeline.left", value: AppTab.timeline) {
                stack(.timeline) { TimelineScreen() }
            }
            Tab(String(localized: "Library"), systemImage: "books.vertical", value: AppTab.library) {
                stack(.library) { LibraryView() }
            }
        }
        .overlay(alignment: .top) {
            if let b = app.banner {
                BannerView(text: b) { app.banner = nil }
                    .padding(.horizontal, 16)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .task { try? await Task.sleep(for: .seconds(4)); app.banner = nil }
            }
        }
        .animation(.easeOut(duration: 0.2), value: app.banner)
        .onReceive(NotificationCenter.default.publisher(for: .mgOpenTarget)) { note in
            guard let t = note.object as? PushTarget else { return }
            Task { await open(t) }
        }
        .task {
            if let t = AppDelegate.pendingTarget { await open(t) }
            if let t = DebugHooks.tab { tab = t }
            if let r = DebugHooks.route { routers[tab]?.push(r) }
            if let q = DebugHooks.ask { tab = .ask; routers[.ask]?.push(.debugAsk(q)) }
            if DebugShare.request != nil { try? await Task.sleep(for: .seconds(1)); DebugShare.presentIfAsked() }
        }
    }

    /// Opens what a tapped notification is about: in its graph (switching first; the new tabs then open it), on the
    /// tab it belongs to, or on the web for screens the app doesn't have (connections, the practice).
    private func open(_ target: PushTarget) async {
        if let g = target.graphId, g != app.currentGraphId {
            AppDelegate.pendingTarget = target
            if await app.switchGraph(id: g) { return }
            AppDelegate.pendingTarget = nil
            tab = .today
            return
        }
        AppDelegate.pendingTarget = nil
        switch target.destination {
        case .today:
            tab = .today
            routers[.today]?.path = []
        case .route(let r):
            let t = Self.tab(for: r)
            tab = t
            routers[t]?.path = [r]
        case .web(let href):
            var c = URLComponents(url: ServerConfig.current, resolvingAgainstBaseURL: false)
            c?.path = href
            if let u = c?.url { await UIApplication.shared.open(u) }
        }
    }

    private static func tab(for r: Route) -> AppTab {
        switch r {
        case .person: return .people
        case .chat, .conversations: return .ask
        case .timeline: return .timeline
        case .source: return .library
        default: return .today
        }
    }

    @ViewBuilder
    private func stack<Content: View>(_ t: AppTab, @ViewBuilder content: () -> Content) -> some View {
        let router = routers[t]!
        RouterStack(router: router, content: content())
    }
}

private struct RouterStack<Content: View>: View {
    @Bindable var router: Router
    let content: Content

    var body: some View {
        NavigationStack(path: $router.path) {
            content
                .mgChrome()
                .navigationDestination(for: Route.self) { route in
                    destination(route).mgChrome(showsSwitcher: false)
                }
        }
        .environment(router)
        .environment(\.openURL, OpenURLAction { url in
            if let r = Route.fromAppURL(url) { router.push(r); return .handled }
            return .systemAction
        })
    }

    @ViewBuilder
    private func destination(_ r: Route) -> some View {
        switch r {
        case .person(let id): PersonDetailView(personId: id)
        case .node(let id): NodeDetailView(nodeId: id)
        case .source(let id): LibraryItemView(sourceId: id)
        case .chat(let id, _): ChatView(conversationId: id)
        case .askAbout(let id, let label, let type): ChatView(conversationId: nil, mention: MentionItem(nodeId: id, label: label, type: type, typeLabel: nil, kindLabel: nil, summary: nil, isYou: nil))
        case .memory: MemoryView()
        case .changes: ChangesView()
        case .changeSet(let id): ChangeSetDetailView(changeSetId: id)
        case .history(let id, let label): HistoryView(subjectId: id, subjectName: label)
        case .documents: DocumentsView()
        case .settings: SettingsView()
        case .timeline: TimelineScreen()
        case .conversations: ConversationsView()
        case .debugAsk(let q): ChatView(conversationId: nil, autoAsk: q)
        case .debugWidget:
            VStack(spacing: 16) {
                NextUpView(entry: NextUpEntry(date: Date(), snapshot: NextUp.load(), signedIn: true))
                    .padding(16).frame(width: 170, height: 170).background(RoundedRectangle(cornerRadius: 22).fill(Color.mgSurface))
                NextUpView(entry: NextUpEntry(date: Date(), snapshot: NextUp.load(), signedIn: true))
                    .padding(16).frame(width: 364, height: 170).background(RoundedRectangle(cornerRadius: 22).fill(Color.mgSurface))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity).background(Color.mgBg)
        }
    }
}

extension Route {
    /// Links inside rendered text: mygraph://node/<id>, mygraph://source/<id>, mygraph://person/<id>.
    static func fromAppURL(_ url: URL) -> Route? {
        guard url.scheme == "mygraph" else { return nil }
        let id = url.pathComponents.dropFirst().first
        switch url.host {
        case "node": return id.map { .node($0) }
        case "source": return id.map { .source($0) }
        case "person": return id.map { .person($0) }
        case "chat": return .chat(id, UUID())
        default: return nil
        }
    }

    var appURL: URL? {
        switch self {
        case .node(let id): return URL(string: "mygraph://node/\(id)")
        case .source(let id): return URL(string: "mygraph://source/\(id)")
        case .person(let id): return URL(string: "mygraph://person/\(id)")
        default: return nil
        }
    }
}

/// The graph switcher (leading) and the account menu with More (trailing) on every tab's root.
private struct ChromeModifier: ViewModifier {
    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
    let showsSwitcher: Bool
    @State private var showGraphs = false

    func body(content: Content) -> some View {
        content
            .background(Color.mgBg.ignoresSafeArea())
            .toolbar {
                if showsSwitcher {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { showGraphs = true } label: { GraphPill(graph: app.currentGraph) }
                            .buttonStyle(.plain)
                            .accessibilityLabel(Text("Graph: \(app.currentGraph?.name ?? "My Graph")"))
                            .accessibilityHint(Text("Switch to another graph"))
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            Section(app.myName ?? String(localized: "Signed in")) {
                                Button { router.push(.memory) } label: { Label("Memory", systemImage: "brain") }
                                Button { router.push(.changes) } label: { Label("Changes", systemImage: "arrow.triangle.branch") }
                                Button { router.push(.documents) } label: { Label("Documents", systemImage: "doc.richtext") }
                                Button { router.push(.settings) } label: { Label("Settings", systemImage: "gearshape") }
                            }
                            Button(role: .destructive) { Task { await app.signOut() } } label: {
                                Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                            }
                        } label: {
                            Avatar(name: app.myName ?? "?", id: app.myPersonId, size: 30)
                        }
                        .accessibilityLabel(Text("More"))
                        .accessibilityHint(Text("Memory, changes, documents, settings and sign out"))
                        .accessibilityIdentifier("more.menu")
                    }
                }
            }
            .sheet(isPresented: $showGraphs) { GraphSwitcherSheet() }
            .task { if DebugHooks.graphs && showsSwitcher { showGraphs = true } }
    }
}

extension View {
    func mgChrome(showsSwitcher: Bool = true) -> some View { modifier(ChromeModifier(showsSwitcher: showsSwitcher)) }
}
