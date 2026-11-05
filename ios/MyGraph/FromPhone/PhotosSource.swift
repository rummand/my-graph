import Foundation
import Photos
import PhotosUI
import ImageIO
import UniformTypeIdentifiers
import SwiftUI

/// Photos: by default only the photos a person picks (the picker needs no library access); each is uploaded to the
/// library and its details (when it was taken, where, albums, favourite) are sent as `photosPayload` with the upload's
/// `sourceId`. Sending the details of every photo in the library is a separate opt-in that needs library access, and
/// respects a limited library (only the photos the person shared with My Graph). PhotoKit never exposes faces or
/// people's names, so none are sent.
enum PhotosSource {
    static var status: PHAuthorizationStatus { PHPhotoLibrary.authorizationStatus(for: .readWrite) }
    static var canRead: Bool { status == .authorized || status == .limited }

    static func requestAccess() async -> PHAuthorizationStatus {
        await PHPhotoLibrary.requestAuthorization(for: .readWrite)
    }

    /// The largest image sent; bigger photos are scaled down (longest side) and saved as JPEG.
    static let maxPixel = 4096
    static let maxUploadBytes = 15 * 1024 * 1024

    // MARK: Library details

    /// Album titles per photo id (the person's own albums).
    static func albumIndex() -> [String: [String]] {
        var index: [String: [String]] = [:]
        let albums = PHAssetCollection.fetchAssetCollections(with: .album, subtype: .any, options: nil)
        albums.enumerateObjects { col, _, _ in
            guard let title = col.localizedTitle, !title.isEmpty else { return }
            let assets = PHAsset.fetchAssets(in: col, options: nil)
            assets.enumerateObjects { a, _, _ in index[a.localIdentifier, default: []].append(title) }
        }
        return index
    }

    static func meta(_ a: PHAsset, albums: [String: [String]]) -> PhotoMeta {
        PhotoMeta(id: a.localIdentifier, takenAt: a.creationDate, lat: a.location?.coordinate.latitude, lon: a.location?.coordinate.longitude,
                  albums: albums[a.localIdentifier] ?? [], favorite: a.isFavorite)
    }

    /// Details of every photo this app can see (the whole library, or the limited selection).
    static func readLibrary() async -> [PhotoItem] {
        await Task.detached(priority: .userInitiated) {
            let albums = albumIndex()
            let opts = PHFetchOptions()
            opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]
            let assets = PHAsset.fetchAssets(with: .image, options: opts)
            var out: [PhotoItem] = []
            out.reserveCapacity(assets.count)
            assets.enumerateObjects { a, _, _ in out.append(meta(a, albums: albums).item) }
            return out
        }.value
    }

    // MARK: Picked photos

    struct Picked {
        var assetId: String?
        var file: UploadFile
        var meta: PhotoMeta
    }

    /// Reads picked photos into upload-ready files, with their details from PhotoKit when the library is readable,
    /// else from the image's own EXIF.
    static func load(_ results: [PHPickerResult]) async -> (picked: [Picked], skipped: Int) {
        let albums = canRead ? albumIndex() : [:]
        var out: [Picked] = [], skipped = 0, names = Set<String>()
        for (i, r) in results.enumerated() {
            guard let raw = await loadImageData(r.itemProvider) else { skipped += 1; continue }
            guard let prepared = prepare(raw.data, type: raw.type) else { skipped += 1; continue }
            var name = (r.itemProvider.suggestedName?.nilIfEmpty ?? "Photo \(i + 1)")
            name = name.replacingOccurrences(of: "/", with: "-")
            let base = (name as NSString).deletingPathExtension
            var filename = base + "." + prepared.ext
            var k = 2
            while names.contains(filename) { filename = "\(base) \(k).\(prepared.ext)"; k += 1 }
            names.insert(filename)

            var meta = exifMeta(raw.data, id: r.assetIdentifier ?? "picked-\(UUID().uuidString)")
            if let id = r.assetIdentifier, canRead, let a = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject {
                let m = self.meta(a, albums: albums)
                meta.takenAt = m.takenAt ?? meta.takenAt
                if m.lat != nil { meta.lat = m.lat; meta.lon = m.lon }
                meta.albums = m.albums
                meta.favorite = m.favorite
            }
            out.append(Picked(assetId: r.assetIdentifier, file: UploadFile(filename: filename, mime: prepared.mime, data: prepared.data), meta: meta))
        }
        return (out, skipped)
    }

    private static func loadImageData(_ p: NSItemProvider) async -> (data: Data, type: UTType?)? {
        let id = p.registeredTypeIdentifiers.first { UTType($0)?.conforms(to: .image) == true } ?? UTType.image.identifier
        return await withCheckedContinuation { c in
            _ = p.loadDataRepresentation(forTypeIdentifier: id) { data, _ in
                c.resume(returning: data.map { ($0, UTType(id)) })
            }
        }
    }

    /// The bytes to upload: JPEG and PNG under the cap go as they are; HEIC (which browsers can't show), other
    /// formats and anything too large become a JPEG of at most `maxPixel` on the longest side, keeping the
    /// date and location in its metadata.
    static func prepare(_ data: Data, type: UTType?) -> (data: Data, mime: String, ext: String)? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let srcType = (CGImageSourceGetType(src) as String?).flatMap(UTType.init) ?? type
        let props = (CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any]) ?? [:]
        let w = props[kCGImagePropertyPixelWidth] as? Int ?? 0, h = props[kCGImagePropertyPixelHeight] as? Int ?? 0
        let small = max(w, h) <= maxPixel && data.count <= maxUploadBytes
        if small, let t = srcType {
            if t.conforms(to: .jpeg) { return (data, "image/jpeg", "jpg") }
            if t.conforms(to: .png) { return (data, "image/png", "png") }
        }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        guard let img = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        var meta: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: 0.85, kCGImagePropertyOrientation: 1]
        for k in [kCGImagePropertyExifDictionary, kCGImagePropertyGPSDictionary, kCGImagePropertyTIFFDictionary] {
            if var d = props[k] as? [CFString: Any] {
                if k == kCGImagePropertyTIFFDictionary { d[kCGImagePropertyTIFFOrientation] = 1 }
                meta[k] = d
            }
        }
        CGImageDestinationAddImage(dest, img, meta as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return (out as Data, "image/jpeg", "jpg")
    }

    /// When and where from the image's own metadata (EXIF date with its offset, GPS).
    static func exifMeta(_ data: Data, id: String) -> PhotoMeta {
        var m = PhotoMeta(id: id)
        guard let src = CGImageSourceCreateWithData(data as CFData, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any] else { return m }
        if let exif = props[kCGImagePropertyExifDictionary] as? [CFString: Any], let s = exif[kCGImagePropertyExifDateTimeOriginal] as? String {
            m.takenAt = exifDate(s, offset: exif[kCGImagePropertyExifOffsetTimeOriginal] as? String)
        }
        if let gps = props[kCGImagePropertyGPSDictionary] as? [CFString: Any],
           var lat = gps[kCGImagePropertyGPSLatitude] as? Double, var lon = gps[kCGImagePropertyGPSLongitude] as? Double {
            if (gps[kCGImagePropertyGPSLatitudeRef] as? String)?.uppercased() == "S" { lat = -lat }
            if (gps[kCGImagePropertyGPSLongitudeRef] as? String)?.uppercased() == "W" { lon = -lon }
            m.lat = lat; m.lon = lon
        }
        return m
    }

    /// "2024:06:21 18:04:11" with an optional "+02:00"; without an offset the phone's own time zone is assumed.
    static func exifDate(_ s: String, offset: String?) -> Date? {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        if let offset, !offset.isEmpty {
            f.dateFormat = "yyyy:MM:dd HH:mm:ssxxx"
            if let d = f.date(from: s + offset) { return d }
        }
        f.dateFormat = "yyyy:MM:dd HH:mm:ss"
        f.timeZone = .current
        return f.date(from: s)
    }
}

/// The system photo picker, with each result's asset id (`photoLibrary: .shared()`); needs no library access.
struct PhotoPicker: UIViewControllerRepresentable {
    let picked: ([PHPickerResult]) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> PHPickerViewController {
        var config = PHPickerConfiguration(photoLibrary: .shared())
        config.filter = .images
        config.selectionLimit = 100
        config.preferredAssetRepresentationMode = .current
        let c = PHPickerViewController(configuration: config)
        c.delegate = context.coordinator
        return c
    }

    func updateUIViewController(_ vc: PHPickerViewController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        let parent: PhotoPicker
        init(_ p: PhotoPicker) { parent = p }
        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            parent.dismiss()
            if !results.isEmpty { parent.picked(results) }
        }
    }
}
