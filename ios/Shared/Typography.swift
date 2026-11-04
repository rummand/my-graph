import SwiftUI
import UIKit
import CoreText

/// One family, Schibsted Grotesk (bundled, OFL). It is a variable font, so weights are set on its `wght` axis.
/// Sizes follow DESIGN.md's five steps, scaled with Dynamic Type through UIFontMetrics.
enum MGType: CaseIterable {
    case title, heading, body, bodyStrong, secondary, secondaryStrong, meta

    var size: CGFloat {
        switch self {
        case .title: return 28
        case .heading: return 19
        case .body, .bodyStrong: return 16
        case .secondary, .secondaryStrong: return 14
        case .meta: return 12
        }
    }

    var weight: CGFloat {
        switch self {
        case .title, .heading: return 600
        case .bodyStrong, .secondaryStrong: return 560
        default: return 400
        }
    }

    var textStyle: UIFont.TextStyle {
        switch self {
        case .title: return .title1
        case .heading: return .title3
        case .body, .bodyStrong: return .body
        case .secondary, .secondaryStrong: return .subheadline
        case .meta: return .caption1
        }
    }
}

enum MGFont {
    static let family = "Schibsted Grotesk"
    private static let wghtAxis = 0x77676874 // 'wght'

    /// Registers the bundled fonts once (the app, the extension and the widget each call this).
    static func register() {
        for name in ["SchibstedGrotesk-Variable", "SchibstedGrotesk-Italic-Variable"] {
            guard let url = Bundle.main.url(forResource: name, withExtension: "ttf") else { continue }
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }

    static func base(size: CGFloat, weight: CGFloat) -> UIFont {
        let desc = UIFontDescriptor(fontAttributes: [
            .family: family,
            kCTFontVariationAttribute as UIFontDescriptor.AttributeName: [wghtAxis: weight],
        ])
        let f = UIFont(descriptor: desc, size: size)
        return f.familyName == family ? f : UIFont.systemFont(ofSize: size, weight: weight >= 600 ? .semibold : weight >= 500 ? .medium : .regular)
    }

    static func ui(_ t: MGType, category: UIContentSizeCategory = UIApplicationCategory.current) -> UIFont {
        UIFontMetrics(forTextStyle: t.textStyle).scaledFont(for: base(size: t.size, weight: t.weight),
                                                            compatibleWith: UITraitCollection(preferredContentSizeCategory: category))
    }
}

enum UIApplicationCategory {
    static var current: UIContentSizeCategory { UITraitCollection.current.preferredContentSizeCategory }
}

extension DynamicTypeSize {
    var category: UIContentSizeCategory {
        switch self {
        case .xSmall: return .extraSmall
        case .small: return .small
        case .medium: return .medium
        case .large: return .large
        case .xLarge: return .extraLarge
        case .xxLarge: return .extraExtraLarge
        case .xxxLarge: return .extraExtraExtraLarge
        case .accessibility1: return .accessibilityMedium
        case .accessibility2: return .accessibilityLarge
        case .accessibility3: return .accessibilityExtraLarge
        case .accessibility4: return .accessibilityExtraExtraLarge
        case .accessibility5: return .accessibilityExtraExtraExtraLarge
        @unknown default: return .large
        }
    }
}

private struct MGFontModifier: ViewModifier {
    @Environment(\.dynamicTypeSize) private var size
    let type: MGType
    func body(content: Content) -> some View {
        content.font(Font(MGFont.ui(type, category: size.category)))
    }
}

extension View {
    /// Sets one of the five type steps, following Dynamic Type.
    func mgFont(_ t: MGType) -> some View { modifier(MGFontModifier(type: t)) }
}

extension Font {
    /// For `Text` concatenation where a modifier can't be used. Doesn't follow live Dynamic Type changes on its own.
    static func mg(_ t: MGType, _ size: DynamicTypeSize = .large) -> Font { Font(MGFont.ui(t, category: size.category)) }
}
