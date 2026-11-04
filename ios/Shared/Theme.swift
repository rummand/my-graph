import SwiftUI
import UIKit

/// DESIGN.md tokens, light and dark (src/app/globals.css).
enum Palette {
    static func dynamic(_ light: UInt32, _ dark: UInt32) -> UIColor {
        UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) }
    }

    static let bg = dynamic(0xF1F3EF, 0x121513)
    static let surface = dynamic(0xFFFFFF, 0x1A1E1B)
    static let surface2 = dynamic(0xE7EAE5, 0x232824)
    static let fg = dynamic(0x17201C, 0xE8ECE9)
    static let muted = dynamic(0x5B6660, 0x99A39D)
    static let line = dynamic(0xDCE0DA, 0x2C322E)
    static let accent = dynamic(0x2F4BB0, 0x8FA3F0)
    static let accentFg = dynamic(0xFFFFFF, 0x101523)
    static let accentTint = dynamic(0xE6EAFA, 0x1F2742)
    static let warn = dynamic(0x9A5A00, 0xE2A64F)
    static let warnTint = dynamic(0xFBEFD9, 0x33280F)
    static let danger = dynamic(0xB03A2E, 0xEE8073)
    static let dangerTint = dynamic(0xF9E3DF, 0x3A1F1B)
    static let inferred = dynamic(0x7A4FA0, 0xC4A2E6)
    static let inferredTint = dynamic(0xF1E8F8, 0x2C2238)

    /// People circles (categorical, fixed order).
    static let circles: [String: UIColor] = [
        "family": dynamic(0x2A78D6, 0x4F95E8), "close": dynamic(0xE0622E, 0xE5784A), "school": dynamic(0x1A9E70, 0x36B487),
        "care": dynamic(0xD59200, 0xDCA52D), "social": dynamic(0xD8689A, 0xE086AD), "work": dynamic(0x3F7D1E, 0x6AA846),
        "other": dynamic(0x858D88, 0x858D88),
    ]

    /// Node types, used on chips.
    static let types: [String: UIColor] = [
        "person": dynamic(0x2F7A63, 0x74C7A8), "place": dynamic(0x2F6FA8, 0x84B4E6), "event": dynamic(0xB0631A, 0xE3A45F),
        "topic": dynamic(0x7A4FA0, 0xC4A2E6), "document": dynamic(0x5B6660, 0x99A39D), "source": dynamic(0x858D88, 0x858D88),
    ]
}

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }

    /// hsl(h s% l%) as in CSS.
    convenience init(h: Double, s: Double, l: Double) {
        let c = (1 - abs(2 * l - 1)) * s
        let hp = (h.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360) / 60
        let x = c * (1 - abs(hp.truncatingRemainder(dividingBy: 2) - 1))
        var (r, g, b) = (0.0, 0.0, 0.0)
        switch hp {
        case 0..<1: (r, g, b) = (c, x, 0)
        case 1..<2: (r, g, b) = (x, c, 0)
        case 2..<3: (r, g, b) = (0, c, x)
        case 3..<4: (r, g, b) = (0, x, c)
        case 4..<5: (r, g, b) = (x, 0, c)
        default: (r, g, b) = (c, 0, x)
        }
        let m = l - c / 2
        self.init(red: r + m, green: g + m, blue: b + m, alpha: 1)
    }

    /// oklch(L C h) → sRGB (the web's graph colours).
    convenience init(oklchL L: Double, c C: Double, h: Double) {
        let hr = h * .pi / 180
        let a = C * cos(hr), b = C * sin(hr)
        let l_ = L + 0.3963377774 * a + 0.2158037573 * b
        let m_ = L - 0.1055613458 * a - 0.0638541728 * b
        let s_ = L - 0.0894841775 * a - 1.2914855480 * b
        let l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_
        func gamma(_ x: Double) -> Double {
            let v = x <= 0.0031308 ? 12.92 * x : 1.055 * pow(x, 1 / 2.4) - 0.055
            return min(max(v, 0), 1)
        }
        let r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
        let g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
        let bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
        self.init(red: gamma(r), green: gamma(g), blue: gamma(bl), alpha: 1)
    }

    func mixed(with other: UIColor, amount: CGFloat) -> UIColor {
        var (r1, g1, b1, a1): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        var (r2, g2, b2, a2): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        getRed(&r1, green: &g1, blue: &b1, alpha: &a1)
        other.getRed(&r2, green: &g2, blue: &b2, alpha: &a2)
        return UIColor(red: r1 + (r2 - r1) * amount, green: g1 + (g2 - g1) * amount, blue: b1 + (b2 - b1) * amount, alpha: 1)
    }
}

extension Color {
    static let mgBg = Color(Palette.bg)
    static let mgSurface = Color(Palette.surface)
    static let mgSurface2 = Color(Palette.surface2)
    static let mgFg = Color(Palette.fg)
    static let mgMuted = Color(Palette.muted)
    static let mgLine = Color(Palette.line)
    static let mgAccent = Color(Palette.accent)
    static let mgAccentFg = Color(Palette.accentFg)
    static let mgAccentTint = Color(Palette.accentTint)
    static let mgWarn = Color(Palette.warn)
    static let mgWarnTint = Color(Palette.warnTint)
    static let mgDanger = Color(Palette.danger)
    static let mgDangerTint = Color(Palette.dangerTint)
    static let mgInferred = Color(Palette.inferred)
    static let mgInferredTint = Color(Palette.inferredTint)

    static func circle(_ key: String?) -> Color { Color(Palette.circles[key ?? "other"] ?? Palette.circles["other"]!) }
    static func nodeType(_ key: String?) -> Color { Color(Palette.types[key ?? "document"] ?? Palette.muted) }
}

/// Every person gets a stable hue from their id: an exact port of personHue in src/lib/ui/person-color.ts
/// (FNV-1a over UTF-16 code units plus a final mix, spread over the wheel minus the 60–125° band).
enum PersonColor {
    static func hue(_ id: String) -> Int {
        var h: UInt32 = 0x811c9dc5
        for unit in id.utf16 {
            h ^= UInt32(unit)
            h = h &* 0x01000193
        }
        h ^= h >> 15
        h = h &* 0x2c1b3c6d
        h ^= h >> 12
        let u = Int(h % 295)
        return u < 60 ? u : u + 65
    }

    /// The saturated colour (a person's own dot or lane line): hsl(h 62% 42%) light, hsl(h 60% 68%) dark.
    static func solid(_ id: String) -> Color {
        let h = Double(hue(id))
        return Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(h: h, s: 0.60, l: 0.68) : UIColor(h: h, s: 0.62, l: 0.42) })
    }

    /// The pale tint (avatars, chips): hsl(h 70% 92%) light, hsl(h 30% 22%) dark.
    static func tint(_ id: String) -> Color {
        let h = Double(hue(id))
        return Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(h: h, s: 0.30, l: 0.22) : UIColor(h: h, s: 0.70, l: 0.92) })
    }

    static func initials(_ name: String) -> String {
        let cleaned = name.replacingOccurrences(of: #"^(Mr|Mrs|Ms|Dr)\.?\s+"#, with: "", options: [.regularExpression, .caseInsensitive])
            .trimmingCharacters(in: .whitespaces)
        let parts = cleaned.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        guard let first = parts.first else { return "?" }
        if parts.count == 1 { return String(first.prefix(2)).uppercased() }
        return (String(first.prefix(1)) + String(parts[parts.count - 1].prefix(1))).uppercased()
    }
}

/// A graph's colour: oklch(0.64 0.14 h) for the dot, a 16% wash over the surface for its pill.
enum GraphColor {
    static func dot(_ hue: Double) -> Color { Color(UIColor(oklchL: 0.64, c: 0.14, h: hue)) }
    static func tint(_ hue: Double) -> Color {
        Color(UIColor { tc in
            let base = tc.userInterfaceStyle == .dark ? UIColor(hex: 0x1A1E1B) : UIColor(hex: 0xFFFFFF)
            return base.mixed(with: UIColor(oklchL: 0.64, c: 0.14, h: hue), amount: 0.16)
        })
    }
}
