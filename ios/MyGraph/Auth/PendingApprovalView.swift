import SwiftUI

/// A child's new device waits for a parent's approval. Polls /api/auth/status and moves on by itself.
struct PendingApprovalView: View {
    @Environment(AppModel.self) private var app
    @State private var cantCheck = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                LogoMark().padding(.top, 48).accessibilityHidden(true)
                Text("Ask a parent to approve this device").mgFont(.title).foregroundStyle(Color.mgFg)
                Text("It's the first time you've signed in on this iPhone, so a parent needs to say it's OK.")
                    .mgFont(.body).foregroundStyle(Color.mgFg)
                Text("A parent can approve it in Settings, under Household members, on their own phone or computer. This screen moves on by itself when they have.")
                    .mgFont(.secondary).foregroundStyle(Color.mgMuted)
                HStack(spacing: 10) {
                    ProgressView()
                    Text(cantCheck ? "Can't check right now. We'll keep trying." : "Waiting for a parent")
                        .mgFont(.secondaryStrong).foregroundStyle(cantCheck ? Color.mgWarn : Color.mgFg)
                }
                .padding(.top, 6)
                .accessibilityElement(children: .combine)
                Button("Sign out") { Task { await app.signOut() } }
                    .buttonStyle(MGButtonStyle(kind: .secondary))
                    .padding(.top, 12)
            }
            .padding(.horizontal, 24)
            .frame(maxWidth: 520, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .background(Color.mgBg.ignoresSafeArea())
        .task {
            while !Task.isCancelled && app.phase == .pending {
                do {
                    let s: SessionStatus = try await API.shared.get("/api/auth/status")
                    cantCheck = false
                    if s.status == "active" { _ = await app.checkPending(); Haptics.success(); break }
                    if s.status == "none" { app.phase = .signedOut; break }
                } catch { cantCheck = true }
                try? await Task.sleep(for: .seconds(4))
            }
        }
    }
}
