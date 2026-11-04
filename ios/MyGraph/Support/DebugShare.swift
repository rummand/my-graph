import UIKit

#if DEBUG
/// Debug builds: `-MGShareSheet file:<token>|text:<token>|url:<address>` opens the system share sheet
/// with a generated PDF, some text or a link, so a UI test can pick
/// "Send to My Graph" and drive the real share extension end to end.
enum DebugShare {
    static var request: String? {
        let a = ProcessInfo.processInfo.arguments
        guard let i = a.firstIndex(of: "-MGShareSheet"), i + 1 < a.count else { return nil }
        return a[i + 1]
    }

    @MainActor
    static func presentIfAsked() {
        guard let r = request else { return }
        let parts = r.split(separator: ":", maxSplits: 1).map(String.init)
        let kind = parts[0], value = parts.count > 1 ? parts[1] : "test"
        var items: [Any] = []
        switch kind {
        case "file":
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("Shared from a test \(value).pdf")
            let pdf = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 595, height: 842)).pdfData { ctx in
                ctx.beginPage()
                ("Shared through Send to My Graph (\(value)). The swimming lesson moves to Thursday at 16:00." as NSString)
                    .draw(at: CGPoint(x: 48, y: 64), withAttributes: [.font: UIFont.systemFont(ofSize: 14)])
            }
            try? pdf.write(to: url)
            items = [url]
        case "text": items = ["Shared note \(value): bring the blue lunch box on Friday."]
        case "url": items = [URL(string: value) ?? URL(string: "https://example.com")!]
        default: return
        }
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
              var top = scene.keyWindow?.rootViewController else { return }
        while let p = top.presentedViewController { top = p }
        let vc = UIActivityViewController(activityItems: items, applicationActivities: nil)
        vc.popoverPresentationController?.sourceView = top.view
        top.present(vc, animated: true)
    }
}
#else
enum DebugShare {
    static let request: String? = nil
    @MainActor static func presentIfAsked() {}
}
#endif
