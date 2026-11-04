import SwiftUI

/// Lists my graphs; picking one switches through POST /api/graphs/switch.
struct GraphSwitcherSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var switching: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(app.graphs) { g in
                        Button {
                            Task {
                                switching = g.id
                                await app.switchGraph(to: g)
                                switching = nil
                                dismiss()
                            }
                        } label: {
                            HStack(spacing: 12) {
                                Circle().fill(GraphColor.dot(g.hue)).frame(width: 12, height: 12)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(g.name).mgFont(.bodyStrong).foregroundStyle(Color.mgFg)
                                    Text(subtitle(g)).mgFont(.secondary).foregroundStyle(Color.mgMuted)
                                }
                                Spacer()
                                if switching == g.id { ProgressView() }
                                else if g.id == app.currentGraph?.id {
                                    Image(systemName: "checkmark").foregroundStyle(Color.mgAccent).accessibilityLabel(Text("Current graph"))
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .listRowBackground(Color.mgSurface)
                        .accessibilityAddTraits(g.id == app.currentGraph?.id ? .isSelected : [])
                    }
                } footer: {
                    Text("Each graph keeps its own people, files and chats. Switching changes what you see everywhere in the app.")
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.mgBg)
            .navigationTitle(Text("Your graphs"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { await app.loadGraphs() }
        }
        .presentationDetents([.medium, .large])
        .mgFont(.body)
    }

    private func subtitle(_ g: GraphSummary) -> String {
        let n = g.memberCount ?? 1
        let people = n == 1 ? String(localized: "Just you") : String(localized: "\(n) people")
        return "\(roleLabel(g.myRole)), \(people.lowercasedFirst)"
    }

    private func roleLabel(_ r: String?) -> String {
        switch r {
        case "owner": return String(localized: "Owner")
        case "editor": return String(localized: "Can add and edit")
        case "viewer": return String(localized: "Can only look")
        default: return String(localized: "Member")
        }
    }
}

extension String {
    var lowercasedFirst: String { prefix(1).lowercased() + dropFirst() }
}
