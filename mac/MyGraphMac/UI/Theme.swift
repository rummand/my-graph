import SwiftUI
import AppKit

/// DESIGN.md's tokens for the Mac: chrome stays system grey and ink; cobalt is the one hue (links, data, the badge);
/// amber means "needs a decision", brick an error.
extension Color {
    static func dynamic(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(nsColor: NSColor(name: nil) { a in
            NSColor(hex: a.bestMatch(from: [.darkAqua, .vibrantDark]) != nil ? dark : light)
        })
    }

    static let mgAccent = dynamic(0x2F4BB0, 0x8FA3F0)
    static let mgAccentTint = dynamic(0xE6EAFA, 0x1F2742)
    static let mgWarn = dynamic(0x9A5A00, 0xE2A64F)
    static let mgWarnTint = dynamic(0xFBEFD9, 0x33280F)
    static let mgDanger = dynamic(0xB03A2E, 0xEE8073)
    static let mgOK = dynamic(0x2F7A63, 0x74C7A8)

    /// A graph's dot (its hue at a calm saturation).
    static func graph(_ hue: Double) -> Color { Color(hue: (hue.truncatingRemainder(dividingBy: 360)) / 360, saturation: 0.55, brightness: 0.75) }
}

extension NSColor {
    convenience init(hex: UInt32) {
        self.init(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

/// "3 minutes ago", in the app's language.
enum When {
    static func ago(_ d: Date?) -> String? {
        guard let d else { return nil }
        if Date().timeIntervalSince(d) < 60 { return L("just now") }
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .full
        // The language the app's strings are showing in, so the sentence around it matches.
        f.locale = Locale(identifier: AppLanguage.bundle == "da" ? "da_DK" : "en_GB")
        return f.localizedString(for: d, relativeTo: Date())
    }
}
