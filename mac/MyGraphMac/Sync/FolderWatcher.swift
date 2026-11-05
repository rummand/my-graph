import Foundation
import CoreServices

/// FSEvents on a few folders: calls back (on the main queue) with the paths that changed, at most every 2 seconds.
final class FolderWatcher {
    private var stream: FSEventStreamRef?
    private let paths: [String]
    private let onChange: ([String]) -> Void

    init(paths: [String], onChange: @escaping ([String]) -> Void) {
        self.paths = paths
        self.onChange = onChange
    }

    func start() {
        guard stream == nil, !paths.isEmpty else { return }
        var ctx = FSEventStreamContext(version: 0, info: Unmanaged.passUnretained(self).toOpaque(), retain: nil, release: nil, copyDescription: nil)
        let callback: FSEventStreamCallback = { _, info, count, eventPaths, _, _ in
            guard let info else { return }
            let me = Unmanaged<FolderWatcher>.fromOpaque(info).takeUnretainedValue()
            let list = Unmanaged<CFArray>.fromOpaque(eventPaths).takeUnretainedValue() as? [String] ?? []
            let changed = Array(list.prefix(count)).filter { !($0 as NSString).lastPathComponent.hasPrefix(".") }
            if !changed.isEmpty { me.onChange(changed) }
        }
        let flags = UInt32(kFSEventStreamCreateFlagUseCFTypes | kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer)
        stream = FSEventStreamCreate(nil, callback, &ctx, paths as CFArray, FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 2.0, flags)
        guard let stream else { return }
        FSEventStreamSetDispatchQueue(stream, .main)
        FSEventStreamStart(stream)
    }

    func stop() {
        guard let stream else { return }
        FSEventStreamStop(stream)
        FSEventStreamInvalidate(stream)
        FSEventStreamRelease(stream)
        self.stream = nil
    }

    deinit { stop() }
}
