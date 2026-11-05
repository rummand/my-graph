import Foundation
import Carbon.HIToolbox
import AppKit

/// A global keyboard shortcut (Carbon's RegisterEventHotKey: needs no Accessibility permission).
struct KeyCombo: Codable, Equatable {
    var keyCode: UInt32
    /// Carbon modifier flags (cmdKey, optionKey, controlKey, shiftKey).
    var modifiers: UInt32

    static let askDefault = KeyCombo(keyCode: UInt32(kVK_Space), modifiers: UInt32(cmdKey | optionKey))
    static let noteDefault = KeyCombo(keyCode: UInt32(kVK_ANSI_N), modifiers: UInt32(cmdKey | optionKey))

    init(keyCode: UInt32, modifiers: UInt32) { self.keyCode = keyCode; self.modifiers = modifiers }

    init?(event: NSEvent) {
        let f = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        var m: UInt32 = 0
        if f.contains(.command) { m |= UInt32(cmdKey) }
        if f.contains(.option) { m |= UInt32(optionKey) }
        if f.contains(.control) { m |= UInt32(controlKey) }
        if f.contains(.shift) { m |= UInt32(shiftKey) }
        // A shortcut needs ⌘, ⌥ or ⌃, so typing is never taken over.
        guard m & UInt32(cmdKey | optionKey | controlKey) != 0 else { return nil }
        keyCode = UInt32(event.keyCode)
        modifiers = m
    }

    /// "⌥⌘Space"
    var display: String {
        var s = ""
        if modifiers & UInt32(controlKey) != 0 { s += "⌃" }
        if modifiers & UInt32(optionKey) != 0 { s += "⌥" }
        if modifiers & UInt32(shiftKey) != 0 { s += "⇧" }
        if modifiers & UInt32(cmdKey) != 0 { s += "⌘" }
        return s + Self.keyName(keyCode)
    }

    static func keyName(_ code: UInt32) -> String {
        switch Int(code) {
        case kVK_Space: return L("Space")
        case kVK_Return: return "↩"
        case kVK_Tab: return "⇥"
        case kVK_Escape: return "⎋"
        default:
            let src = TISCopyCurrentKeyboardLayoutInputSource().takeRetainedValue()
            guard let ptr = TISGetInputSourceProperty(src, kTISPropertyUnicodeKeyLayoutData) else { return "?" }
            let data = Unmanaged<CFData>.fromOpaque(ptr).takeUnretainedValue() as Data
            var dead: UInt32 = 0
            var chars = [UniChar](repeating: 0, count: 4)
            var len = 0
            let status = data.withUnsafeBytes { raw -> OSStatus in
                guard let layout = raw.bindMemory(to: UCKeyboardLayout.self).baseAddress else { return -1 }
                return UCKeyTranslate(layout, UInt16(code), UInt16(kUCKeyActionDisplay), 0, UInt32(LMGetKbdType()),
                                      OptionBits(kUCKeyTranslateNoDeadKeysBit), &dead, 4, &len, &chars)
            }
            return status == noErr && len > 0 ? String(utf16CodeUnits: chars, count: len).uppercased() : "?"
        }
    }
}

final class HotKeys {
    static let shared = HotKeys()
    private var refs: [UInt32: EventHotKeyRef] = [:]
    private var actions: [UInt32: () -> Void] = [:]
    private var handler: EventHandlerRef?

    private init() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ -> OSStatus in
            var id = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
                              MemoryLayout<EventHotKeyID>.size, nil, &id)
            DispatchQueue.main.async { HotKeys.shared.actions[id.id]?() }
            return noErr
        }, 1, &spec, nil, &handler)
    }

    /// Registers (or replaces) shortcut `slot`. False when another app already has that combination.
    @discardableResult
    func register(_ slot: UInt32, _ combo: KeyCombo?, action: @escaping () -> Void) -> Bool {
        if let r = refs[slot] { UnregisterEventHotKey(r); refs[slot] = nil }
        guard let combo else { actions[slot] = nil; return true }
        var ref: EventHotKeyRef?
        let id = EventHotKeyID(signature: OSType(0x4D47_5248), id: slot) // "MGRH"
        let status = RegisterEventHotKey(combo.keyCode, combo.modifiers, id, GetApplicationEventTarget(), 0, &ref)
        guard status == noErr, let ref else { return false }
        refs[slot] = ref
        actions[slot] = action
        return true
    }
}
