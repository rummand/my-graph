import SwiftUI
import UIKit
import VisionKit
import QuickLook

/// The camera, for a quick photo of a letter or a fridge note.
struct CameraPicker: UIViewControllerRepresentable {
    let picked: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let c = UIImagePickerController()
        c.sourceType = .camera
        c.delegate = context.coordinator
        return c
    }

    func updateUIViewController(_ vc: UIImagePickerController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ p: CameraPicker) { parent = p }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let img = info[.originalImage] as? UIImage { parent.picked(img) }
            parent.dismiss()
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
    }
}

/// VisionKit's document scanner; the pages become one PDF.
struct DocumentScanner: UIViewControllerRepresentable {
    let scanned: (Data) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let c = VNDocumentCameraViewController()
        c.delegate = context.coordinator
        return c
    }

    func updateUIViewController(_ vc: VNDocumentCameraViewController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        let parent: DocumentScanner
        init(_ p: DocumentScanner) { parent = p }

        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
            parent.scanned(Self.pdf(from: scan))
            parent.dismiss()
        }
        func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) { parent.dismiss() }
        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) { parent.dismiss() }

        static func pdf(from scan: VNDocumentCameraScan) -> Data {
            let first = scan.imageOfPage(at: 0)
            let bounds = CGRect(origin: .zero, size: first.size)
            let renderer = UIGraphicsPDFRenderer(bounds: bounds)
            return renderer.pdfData { ctx in
                for i in 0..<scan.pageCount {
                    let img = scan.imageOfPage(at: i)
                    let rect = CGRect(origin: .zero, size: img.size)
                    ctx.beginPage(withBounds: rect, pageInfo: [:])
                    img.draw(in: rect)
                }
            }
        }
    }
}

/// Shows a downloaded original with QuickLook.
struct QuickLookView: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UINavigationController {
        let q = QLPreviewController()
        q.dataSource = context.coordinator
        q.navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .done, primaryAction: UIAction { _ in q.dismiss(animated: true) })
        return UINavigationController(rootViewController: q)
    }
    func updateUIViewController(_ vc: UINavigationController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(url) }

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        let url: URL
        init(_ u: URL) { url = u }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
    }
}
