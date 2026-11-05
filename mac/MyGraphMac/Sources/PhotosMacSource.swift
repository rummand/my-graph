import Foundation
import Photos
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Photos: the photos a person picks are uploaded (with when and where they were taken); the details of every photo in
/// the library (no images) are sent only when the person turns that on separately. PhotoKit never gives faces or names.
struct PhotosMacSource: MacSource {
    let id = SourceID.photos
    func permission() -> Permission { Permissions.photos }

    static func libraryOn(_ ctx: SyncContext) -> Bool { ctx.store.load().photosLibraryOptIn }

    func run(_ ctx: SyncContext) async throws -> SourceResult {
        guard Self.libraryOn(ctx) else { return SourceResult(sent: 0, note: L("Only photos you pick are sent")) }
        let p = permission()
        guard p.isUsable else { throw SourceError.permission(p) }
        let items = await Task.detached(priority: .utility) { () -> [PhotoItem] in
            var albums: [String: [String]] = [:]
            PHAssetCollection.fetchAssetCollections(with: .album, subtype: .any, options: nil).enumerateObjects { col, _, _ in
                guard let title = col.localizedTitle, !title.isEmpty else { return }
                PHAsset.fetchAssets(in: col, options: nil).enumerateObjects { a, _, _ in albums[a.localIdentifier, default: []].append(title) }
            }
            let opts = PHFetchOptions()
            opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]
            var out: [PhotoItem] = []
            PHAsset.fetchAssets(with: .image, options: opts).enumerateObjects { a, _, _ in
                out.append(PhotoMeta(id: a.localIdentifier, takenAt: a.creationDate, lat: a.location?.coordinate.latitude,
                                     lon: a.location?.coordinate.longitude, albums: albums[a.localIdentifier] ?? [], favorite: a.isFavorite).item)
            }
            return out
        }.value
        let sent = try await sendChanged(ctx, importer: .photos, items: items, id: \.id, maxCount: PhoneImporter.photos.maxItems) {
            PhotosData(photos: $0)
        }
        return SourceResult(sent: sent)
    }

    /// Uploads photos the person picked to the library (the session's normal upload, as on the iPhone), then sends their
    /// details (when, where, albums) with each upload's source id as one photos batch.
    static func sendPicked(_ picked: [PhotosPickerItem], visibility: String, api: MacAPI = .shared) async throws -> Int {
        var metas: [PhotoItem] = []
        for (i, item) in picked.enumerated() {
            guard let data = try await item.loadTransferable(type: Data.self), data.count <= SendKit.maxFileBytes else { continue }
            let type = item.supportedContentTypes.first { $0.conforms(to: .image) }
            let ext = type?.preferredFilenameExtension ?? "jpg"
            let mime = type?.preferredMIMEType ?? "image/jpeg"
            let assetId = item.itemIdentifier
            var meta = PhotoMeta(id: assetId ?? "picked-\(UUID().uuidString)")
            if let id = assetId, Permissions.photos.isUsable, let a = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject {
                meta.takenAt = a.creationDate
                meta.lat = a.location?.coordinate.latitude
                meta.lon = a.location?.coordinate.longitude
                meta.favorite = a.isFavorite
            } else if let src = CGImageSourceCreateWithData(data as CFData, nil),
                      let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
                      let exif = props[kCGImagePropertyExifDictionary] as? [CFString: Any],
                      let s = exif[kCGImagePropertyExifDateTimeOriginal] as? String {
                let f = DateFormatter()
                f.locale = Locale(identifier: "en_US_POSIX")
                f.dateFormat = "yyyy:MM:dd HH:mm:ss"
                meta.takenAt = f.date(from: s)
            }
            let r = try await API.shared.upload([UploadFile(filename: "Photo \(i + 1).\(ext)", mime: mime, data: data)], visibility: visibility)
            if let res = r.results?.first, let e = res.error { throw SourceError.failed(e) }
            meta.sourceId = r.results?.first?.sourceId
            metas.append(meta.item)
        }
        if !metas.isEmpty {
            let batch = MacBatch(runId: UUID().uuidString, batch: batchName("p-" + PhoneImportKit.fingerprint(metas.map(\.id))), final: true,
                                 device: DeviceName.current, data: PhotosData(photos: metas))
            _ = try await api.importBatch(.photos, batch)
        }
        return metas.count
    }
}
