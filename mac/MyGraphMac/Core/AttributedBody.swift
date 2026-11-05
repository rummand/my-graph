import Foundation

/// Text of a Messages row whose `text` column is empty. Newer macOS keeps the text only in `attributedBody`, an
/// NSArchiver "typedstream". The string follows the NSString class name:
/// `… "NSString" 01 94 84 01 "+" <length> <UTF-8 bytes>`, where the length is one byte below 0x80, or 0x81 + 2 bytes,
/// or 0x82 + 4 bytes (little-endian). Same rules as the Node helper (`textFromAttributedBody`). Best effort: nil when
/// unsure, never a crash on odd input.
enum AttributedBody {
    static func text(_ data: Data?) -> String? {
        guard let data, !data.isEmpty else { return nil }
        let bytes = [UInt8](data)
        guard let at = find(bytes, Array("NSString".utf8)) ?? find(bytes, Array("NSMutableString".utf8)) else { return nil }
        var pos = -1
        var i = at + 8
        while i < min(bytes.count, at + 24) {
            if bytes[i] == 0x2B { pos = i + 1; break }
            i += 1
        }
        guard pos >= 0, pos < bytes.count else { return nil }
        let length: Int, start: Int
        let b = bytes[pos]
        if b == 0x81 {
            guard pos + 3 <= bytes.count else { return nil }
            length = Int(bytes[pos + 1]) | Int(bytes[pos + 2]) << 8
            start = pos + 3
        } else if b == 0x82 {
            guard pos + 5 <= bytes.count else { return nil }
            length = Int(bytes[pos + 1]) | Int(bytes[pos + 2]) << 8 | Int(bytes[pos + 3]) << 16 | Int(bytes[pos + 4]) << 24
            start = pos + 5
        } else if b < 0x80 {
            length = Int(b); start = pos + 1
        } else {
            return nil
        }
        guard length > 0, start + length <= bytes.count else { return nil }
        let s = String(decoding: bytes[start..<(start + length)], as: UTF8.self)
        if s.contains("\u{FFFD}") && !s.unicodeScalars.contains(where: { CharacterSet.alphanumerics.contains($0) }) { return nil }
        return s
    }

    /// Message text as sent: no attachment placeholders, Unix line breaks, trimmed, at most 20,000 characters.
    static func clean(_ s: String?) -> String {
        guard let s else { return "" }
        var t = s.replacingOccurrences(of: "\u{FFFC}", with: "")
            .replacingOccurrences(of: "\u{FFFD}", with: "")
            .replacingOccurrences(of: "\u{0000}", with: "")
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if t.utf16.count > 20_000 { t = PhoneImportKit.clip(t, 20_000) ?? "" }
        return t
    }

    static func find(_ hay: [UInt8], _ needle: [UInt8]) -> Int? {
        guard !needle.isEmpty, hay.count >= needle.count else { return nil }
        var i = 0
        let last = hay.count - needle.count
        while i <= last {
            if hay[i] == needle[0] {
                var j = 1
                while j < needle.count && hay[i + j] == needle[j] { j += 1 }
                if j == needle.count { return i }
            }
            i += 1
        }
        return nil
    }
}
