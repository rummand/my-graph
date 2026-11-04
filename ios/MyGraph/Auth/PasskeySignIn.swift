import Foundation
import AuthenticationServices
import UIKit

/// Passkey sign-in against the server's WebAuthn routes:
/// POST /api/auth/passkey/login/options → { challengeId, options } and POST /api/auth/passkey/login/verify.
/// iOS only offers passkeys for a relying party whose domain lists this app in its apple-app-site-association
/// (`webcredentials:`); see ios/README.md for what the server must publish.
@MainActor
final class PasskeySignIn: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    private var continuation: CheckedContinuation<ASAuthorization, Error>?

    struct Options: Decodable {
        let challengeId: String
        let options: PublicKey
        struct PublicKey: Decodable { let challenge: String; let rpId: String? }
    }

    func run() async throws -> Data {
        let (data, _) = try await API.shared.send(API.shared.request("POST", "/api/auth/passkey/login/options"), quietAuth: true)
        let opts = try API.shared.decode(Options.self, from: data)
        guard let challenge = Data(base64URL: opts.options.challenge) else { throw APIError.badResponse }
        let rpId = opts.options.rpId ?? ServerConfig.current.host ?? ""
        if rpId == "localhost" || rpId.isEmpty {
            throw APIError.server(0, String(localized: "Passkeys need the server's real web address. Use your password for the local server."))
        }

        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
        let request = provider.createCredentialAssertionRequest(challenge: challenge)
        let auth = try await perform(request)
        guard let cred = auth.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion else { throw APIError.badResponse }

        let response: [String: Any] = [
            "id": cred.credentialID.base64URL,
            "rawId": cred.credentialID.base64URL,
            "type": "public-key",
            "clientExtensionResults": [String: Any](),
            "authenticatorAttachment": "platform",
            "response": [
                "clientDataJSON": cred.rawClientDataJSON.base64URL,
                "authenticatorData": cred.rawAuthenticatorData.base64URL,
                "signature": cred.signature.base64URL,
                "userHandle": cred.userID.base64URL,
            ],
        ]
        let verify = API.shared.request("POST", "/api/auth/passkey/login/verify", json: ["challengeId": opts.challengeId, "response": response])
        let (out, _) = try await API.shared.send(verify, quietAuth: true)
        return out
    }

    private func perform(_ request: ASAuthorizationRequest) async throws -> ASAuthorization {
        try await withCheckedThrowingContinuation { c in
            continuation = c
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
        }
    }

    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        MainActor.assumeIsolated { continuation?.resume(returning: authorization); continuation = nil }
    }

    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        MainActor.assumeIsolated {
            let ns = error as NSError
            if ns.domain == ASAuthorizationError.errorDomain, ns.code == ASAuthorizationError.Code.canceled.rawValue {
                continuation?.resume(throwing: CancellationError())
            } else if ns.domain == ASAuthorizationError.errorDomain {
                continuation?.resume(throwing: APIError.server(0, String(localized: "This iPhone can't use a passkey for this server yet. Sign in with your password.")))
            } else {
                continuation?.resume(throwing: error)
            }
            continuation = nil
        }
    }

    nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            return scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
        }
    }
}

extension Data {
    init?(base64URL s: String) {
        var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b.count % 4 != 0 { b += "=" }
        self.init(base64Encoded: b)
    }

    var base64URL: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
