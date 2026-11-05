import Foundation

/// The Mac app's own strings live in the "Mac" table (Resources/Mac.xcstrings, English and Danish); the shared iOS
/// code keeps using Localizable.xcstrings. `L("Send now")`, `L("\(n) sent \(at)")`.
func L(_ key: String.LocalizationValue) -> String {
    String(localized: key, table: "Mac")
}
