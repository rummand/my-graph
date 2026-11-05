import Foundation

/// Apple's reference date (2001-01-01T00:00:00Z) as used in chat.db and CallHistory.storedata.
enum AppleTime {
    /// 2001-01-01 in Unix seconds.
    static let epoch: Double = 978_307_200

    /// A chat.db `date` (nanoseconds since 2001 on macOS 10.13 and later, seconds before) as a Date; nil for 0,
    /// negative or absurd values.
    static func messageDate(_ raw: Int64) -> Date? {
        guard raw > 0 else { return nil }
        let seconds = raw > 100_000_000_000 ? Double(raw) / 1_000_000_000 : Double(raw)
        return date(seconds: seconds)
    }

    /// Core Data timestamps (CallHistory's ZDATE): seconds since 2001, fractional.
    static func date(seconds: Double) -> Date? {
        guard seconds.isFinite, seconds > 0, seconds < 4_000_000_000 else { return nil }
        return Date(timeIntervalSinceReferenceDate: seconds)
    }

    /// A Date as chat.db nanoseconds (for "since" filters).
    static func nanoseconds(_ d: Date) -> Int64 {
        let s = max(0, d.timeIntervalSinceReferenceDate)
        return Int64(s * 1_000_000_000)
    }

    /// ISO 8601 with "Z", as the server's `z.string().datetime({ offset: true })` wants.
    static func iso(_ d: Date?) -> String? {
        guard let d else { return nil }
        return formatter.string(from: d)
    }

    static func parseISO(_ s: String?) -> Date? {
        guard let s, !s.isEmpty else { return nil }
        return fractional.date(from: s) ?? formatter.date(from: s)
    }

    nonisolated(unsafe) private static let formatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()

    nonisolated(unsafe) private static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}
