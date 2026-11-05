import Foundation

/// Waiting after failures: 1, 2, 4 … minutes, at most 6 hours, with a little jitter so many Macs don't retry at once.
enum Backoff {
    static func delay(failures: Int, base: TimeInterval = 60, cap: TimeInterval = 6 * 3600, jitter: Double = 0.1, random: Double = Double.random(in: 0...1)) -> TimeInterval {
        guard failures > 0 else { return 0 }
        let raw = min(cap, base * pow(2, Double(min(failures - 1, 20))))
        return raw * (1 - jitter + 2 * jitter * random)
    }
}
