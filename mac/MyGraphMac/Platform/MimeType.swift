import Foundation
import UniformTypeIdentifiers

enum MimeType {
    static func of(_ url: URL) -> String {
        UTType(filenameExtension: url.pathExtension.lowercased())?.preferredMIMEType ?? "application/octet-stream"
    }
}
