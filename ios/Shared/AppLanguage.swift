import Foundation

/// Which language My Graph speaks on this iPhone, and what the app tells the server (Accept-Language).
///
/// The server's choice wins: a signed-in person's language is saved on their account (Settings on the web or here),
/// and `/api/auth/me` returns it. The app shows that language right away in SwiftUI text and saves it as the app's
/// language, so text built in code follows from the next launch. Before sign-in the app follows the iPhone.
enum AppLanguage {
    static let supported = ["en", "da"]
    private static let key = "mg.serverLocale"

    /// The language the app's strings are in right now (from the bundle, which follows the iPhone or the override).
    static var bundle: String {
        let l = Bundle.main.preferredLocalizations.first ?? "en"
        return supported.contains(l) ? l : "en"
    }

    /// The account's language as last reported by the server, if any.
    static var server: String? {
        get { AppGroup.defaults.string(forKey: key).flatMap { supported.contains($0) ? $0 : nil } }
        set { AppGroup.defaults.set(newValue, forKey: key) }
    }

    /// What screens should use: the account's language, else the bundle's.
    static var current: String { server ?? bundle }

    /// "da, en;q=0.8" — the app's language first, English as the fallback.
    static var acceptLanguage: String { current == "en" ? "en" : "\(current), en;q=0.8" }

    /// Remembers the server's language and makes it the app's language for the next launch (unless a launch
    /// argument chose the language, as screenshots do). Returns true when it differs from what is showing now.
    @discardableResult
    static func adopt(_ locale: String?) -> Bool {
        guard let l = locale, supported.contains(l) else { return false }
        server = l
        if !ProcessInfo.processInfo.arguments.contains("-AppleLanguages") {
            UserDefaults.standard.set([l], forKey: "AppleLanguages")
        }
        return l != bundle
    }

    static func forget() { AppGroup.defaults.removeObject(forKey: key) }
}
