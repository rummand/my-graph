import Foundation
import Speech
import AVFoundation
import Observation

/// Speaking a question in Ask: the microphone through AVAudioEngine into SFSpeechRecognizer, on the iPhone itself
/// when the language supports it. Partial text shows in the question field as you speak. Danish or English, chosen
/// with the DA/EN toggle (it starts in the app's language). The keyboard's own dictation keeps working beside it.
@MainActor
@Observable
final class Dictation {
    enum Language: String, CaseIterable, Identifiable {
        case da, en
        var id: String { rawValue }
        var short: String { rawValue.uppercased() }
        var name: String { self == .da ? String(localized: "Danish") : String(localized: "English") }
        /// da-DK; en-US in the United States, en-GB elsewhere (closest to how English is spoken in Denmark).
        var locale: Locale { Locale(identifier: Dictation.localeId(for: self, region: Locale.current.region?.identifier)) }
    }

    enum State: Equatable { case idle, starting, listening, failed(String) }

    var state: State = .idle
    var language: Language { didSet { Self.save(language); if state == .listening { restart() } } }
    /// What has been heard in this go, so far.
    var heard = ""
    /// True when the current go runs on the iPhone (no audio leaves it).
    var onDevice = false

    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var recognizer: SFSpeechRecognizer?
    private var onText: ((String) -> Void)?
    private var generation = 0

    init() { language = Self.saved() ?? (AppLanguage.current == "da" ? .da : .en) }

    var isListening: Bool { state == .listening || state == .starting }

    // MARK: Pure helpers (unit-tested)

    nonisolated static func localeId(for language: Language, region: String?) -> String {
        switch language {
        case .da: return "da-DK"
        case .en: return region == "US" ? "en-US" : "en-GB"
        }
    }

    /// Joins what was typed before with what is being said: one space between, none at the start.
    nonisolated static func join(_ before: String, _ heard: String) -> String {
        guard !heard.isEmpty else { return before }
        if before.isEmpty { return heard }
        return before.last?.isWhitespace == true ? before + heard : before + " " + heard
    }

    private static let key = "mg.dictation.language"
    private static func saved() -> Language? { UserDefaults.standard.string(forKey: key).flatMap(Language.init(rawValue:)) }
    private static func save(_ l: Language) { UserDefaults.standard.set(l.rawValue, forKey: key) }

    // MARK: Listening

    /// Starts listening; `onText` gets everything heard so far, each time it changes.
    func start(onText: @escaping (String) -> Void) async {
        guard !isListening else { return }
        self.onText = onText
        state = .starting
        guard await Self.speechAllowed() else {
            state = .failed(String(localized: "To speak your question, allow Speech Recognition for My Graph in Settings."))
            return
        }
        guard await AVAudioApplication.requestRecordPermission() else {
            state = .failed(String(localized: "To speak your question, allow the microphone for My Graph in Settings."))
            return
        }
        begin()
    }

    func stop() {
        generation += 1
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.finish()
        request = nil; task = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        if case .failed = state {} else { state = .idle }
    }

    func dismissError() { if case .failed = state { state = .idle } }

    private func restart() {
        let keep = onText
        stop()
        heard = ""
        onText = keep
        state = .starting
        begin()
    }

    private func begin() {
        guard let r = SFSpeechRecognizer(locale: language.locale), r.isAvailable else {
            state = .failed(String(localized: "Speech recognition in \(language.name) isn't available on this iPhone right now."))
            return
        }
        recognizer = r
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            state = .failed(String(localized: "The microphone is busy. Try again in a moment."))
            return
        }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.addsPunctuation = true
        onDevice = r.supportsOnDeviceRecognition
        req.requiresOnDeviceRecognition = onDevice
        request = req

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            state = .failed(String(localized: "There's no microphone to listen with."))
            return
        }
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in req.append(buffer) }
        engine.prepare()
        do { try engine.start() } catch {
            input.removeTap(onBus: 0)
            state = .failed(String(localized: "The microphone is busy. Try again in a moment."))
            return
        }
        heard = ""
        state = .listening
        generation += 1
        let gen = generation
        task = r.recognitionTask(with: req) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            let final = result?.isFinal ?? false
            Task { @MainActor in
                guard let self, gen == self.generation else { return }
                if let text { self.heard = text; self.onText?(text) }
                if final || (error != nil && result == nil) { self.stop() }
            }
        }
    }

    private static func speechAllowed() async -> Bool {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: return true
        case .denied, .restricted: return false
        default:
            return await withCheckedContinuation { c in
                SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0 == .authorized) }
            }
        }
    }
}
