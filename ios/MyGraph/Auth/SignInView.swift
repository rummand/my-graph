import SwiftUI
import AuthenticationServices

struct SignInView: View {
    @Environment(AppModel.self) private var app
    @State private var email = ""
    @State private var password = ""
    @State private var busy = false
    @State private var passkeyBusy = false
    @State private var error: String?
    @State private var showServer = false
    @State private var debugServer = false
    @State private var server = ServerConfig.current
    @FocusState private var focus: Field?
    enum Field { case email, password }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 10) {
                    LogoMark()
                        .onLongPressGesture(minimumDuration: 1.2) { debugServer = true; showServer = true; Haptics.tap() }
                        .accessibilityHidden(true)
                    Text("Welcome back").mgFont(.title).foregroundStyle(Color.mgFg)
                    Text("Sign in to your graph.").mgFont(.body).foregroundStyle(Color.mgMuted)
                }
                .padding(.top, 40)

                if let reason = app.signOutReason {
                    NoticeBar(text: reason, tone: .muted)
                }

                Button { Task { await passkey() } } label: {
                    HStack(spacing: 8) {
                        if passkeyBusy { ProgressView().tint(Color.mgBg) } else { Image(systemName: "person.badge.key") }
                        Text(passkeyBusy ? "Waiting for your passkey…" : "Sign in with a passkey")
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(MGButtonStyle(kind: .primary))
                .disabled(busy || passkeyBusy)

                Text("Or use your password").mgFont(.secondary).foregroundStyle(Color.mgMuted)

                VStack(alignment: .leading, spacing: 14) {
                    LabeledField(label: "Email or username") {
                        TextField("", text: $email, prompt: Text(verbatim: "anna@example.com"))
                            .textContentType(.username)
                            .keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .submitLabel(.next)
                            .focused($focus, equals: .email)
                            .onSubmit { focus = .password }
                    }
                    LabeledField(label: "Password") {
                        SecureField("", text: $password)
                            .textContentType(.password)
                            .submitLabel(.go)
                            .focused($focus, equals: .password)
                            .onSubmit { Task { await submit() } }
                    }
                }

                if let error {
                    Text(error).mgFont(.secondary).foregroundStyle(Color.mgDanger)
                        .accessibilityLabel(Text("Error: \(error)"))
                }

                Button { Task { await submit() } } label: {
                    HStack { if busy { ProgressView() }; Text(busy ? "Signing in…" : "Sign in") }.frame(maxWidth: .infinity)
                }
                .buttonStyle(MGButtonStyle(kind: .secondary))
                .disabled(busy || passkeyBusy)

                Button { showServer = true } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "server.rack").font(.system(size: 12))
                        Text("Server: \(server.host ?? "")")
                    }
                    .mgFont(.secondary).foregroundStyle(Color.mgMuted)
                }
                .accessibilityHint(Text("Change which My Graph server to use"))

                Text("Forgot your password? Ask the owner of your household to give you a new one.")
                    .mgFont(.secondary).foregroundStyle(Color.mgMuted)
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 32)
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Color.mgBg.ignoresSafeArea())
        .sheet(isPresented: $showServer, onDismiss: { server = ServerConfig.current }) { ServerSettingsSheet(showDebug: debugServer || ServerConfig.isLocal) }
    }

    private func submit() async {
        let e = email.trimmingCharacters(in: .whitespaces)
        guard !e.isEmpty else { error = String(localized: "Enter your email or username."); focus = .email; return }
        guard !password.isEmpty else { error = String(localized: "Enter your password."); focus = .password; return }
        busy = true; error = nil
        defer { busy = false }
        do {
            try await app.signIn(email: e, password: password)
            password = ""
        } catch {
            self.error = error.plainMessage
            Haptics.warning()
        }
    }

    private func passkey() async {
        passkeyBusy = true; error = nil
        defer { passkeyBusy = false }
        do {
            let data = try await PasskeySignIn().run()
            try app.finishSignIn(data)
        } catch is CancellationError {
        } catch let e as ASAuthorizationError where e.code == .canceled {
        } catch {
            self.error = error.plainMessage
        }
    }
}

struct LabeledField<Content: View>: View {
    let label: LocalizedStringKey
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).mgFont(.secondaryStrong).foregroundStyle(Color.mgFg)
            content
                .mgFont(.body)
                .padding(.horizontal, 12).padding(.vertical, 11)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.mgSurface))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.mgLine, lineWidth: 1))
        }
    }
}

/// The My Graph mark: three linked dots.
struct LogoMark: View {
    var size: CGFloat = 44
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.24, style: .continuous).fill(Color.mgFg)
            Canvas { ctx, s in
                let pts = [CGPoint(x: s.width * 0.30, y: s.height * 0.34), CGPoint(x: s.width * 0.70, y: s.height * 0.30), CGPoint(x: s.width * 0.48, y: s.height * 0.72)]
                var p = Path(); p.move(to: pts[0]); p.addLine(to: pts[1]); p.addLine(to: pts[2]); p.closeSubpath()
                ctx.stroke(p, with: .color(Color.mgBg.opacity(0.6)), lineWidth: s.width * 0.04)
                for (i, pt) in pts.enumerated() {
                    let r = s.width * (i == 2 ? 0.11 : 0.085)
                    ctx.fill(Path(ellipseIn: CGRect(x: pt.x - r, y: pt.y - r, width: r * 2, height: r * 2)), with: .color(i == 2 ? Color.mgAccentTint : Color.mgBg))
                }
            }
        }
        .frame(width: size, height: size)
    }
}

/// Pick the server. The local development server is a hidden option (long-press the logo, or the Debug section).
struct ServerSettingsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var text = ServerConfig.current.absoluteString
    @State private var error: String?
    @State private var checking = false
    @State private var showDebug: Bool

    init(showDebug: Bool = ServerConfig.isLocal) { _showDebug = State(initialValue: showDebug) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://mygraph.example.com", text: $text)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .mgFont(.body)
                } header: { Text("Server address") } footer: {
                    Text("Where your household runs My Graph. Most families use the default.")
                }
                Section {
                    Button("Use the default server") { text = ServerConfig.production.absoluteString }
                    if showDebug {
                        Button("Use the local development server") { text = ServerConfig.local.absoluteString }
                    }
                } footer: {
                    if showDebug { Text(verbatim: ServerConfig.local.absoluteString) }
                }
                if let error { Section { Text(error).foregroundStyle(Color.mgDanger) } }
            }
            .scrollContentBackground(.hidden)
            .background(Color.mgBg)
            .navigationTitle(Text("Server"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await save() } } label: { if checking { ProgressView() } else { Text("Save") } }
                }
            }
        }
        .mgFont(.body)
    }

    private func save() async {
        guard let url = ServerConfig.parse(text) else { error = String(localized: "That doesn't look like a web address."); return }
        checking = true; defer { checking = false }
        var req = URLRequest(url: url.appendingPathComponent("api/health"))
        req.timeoutInterval = 8
        do {
            let (_, resp) = try await URLSession.shared.data(for: req)
            guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw APIError.badResponse }
        } catch {
            self.error = String(localized: "Couldn't reach My Graph at that address. Check it and try again.")
            return
        }
        ServerConfig.current = url
        CookieVault.restore()
        dismiss()
    }
}
