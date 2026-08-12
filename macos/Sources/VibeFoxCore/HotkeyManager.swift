import Carbon.HIToolbox
import Foundation

/// Global hotkey via Carbon RegisterEventHotKey. Accepts the Electron accelerator string
/// stored in config.json (e.g. "Command+Alt+Z") so the file format stays cross-build.
/// System-reserved combos are screened by AppConfig.reservedHotkeys before reaching here.
public final class HotkeyManager {
    public struct ParsedHotkey: Equatable {
        public let keyCode: UInt32
        public let carbonModifiers: UInt32
    }

    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    private var callback: (() -> Void)?

    public init() {}

    deinit {
        unregister()
    }

    /// Maps Electron accelerator key names to Carbon virtual key codes (US layout).
    public static let keyCodes: [String: UInt32] = {
        var map: [String: UInt32] = [
            "A": 0, "S": 1, "D": 2, "F": 3, "H": 4, "G": 5, "Z": 6, "X": 7, "C": 8, "V": 9,
            "B": 11, "Q": 12, "W": 13, "E": 14, "R": 15, "Y": 16, "T": 17,
            "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29,
            "O": 31, "U": 32, "I": 34, "P": 35, "L": 37, "J": 38, "K": 40, "N": 45, "M": 46,
            "SPACE": 49,
            "F1": 122, "F2": 120, "F3": 99, "F4": 118, "F5": 96, "F6": 97,
            "F7": 98, "F8": 100, "F9": 101, "F10": 109, "F11": 103, "F12": 111,
        ]
        return map
    }()

    public static func parse(_ accelerator: String) -> ParsedHotkey? {
        var modifiers: UInt32 = 0
        var key: UInt32?
        for part in accelerator.split(separator: "+").map({ $0.trimmingCharacters(in: .whitespaces).uppercased() }) {
            switch part {
            case "COMMAND", "CMD", "META", "SUPER": modifiers |= UInt32(cmdKey)
            case "CONTROL", "CTRL": modifiers |= UInt32(controlKey)
            case "ALT", "OPTION": modifiers |= UInt32(optionKey)
            case "SHIFT": modifiers |= UInt32(shiftKey)
            default:
                guard let code = keyCodes[part] else { return nil }
                key = code
            }
        }
        guard let keyCode = key, modifiers != 0 else { return nil }
        return ParsedHotkey(keyCode: keyCode, carbonModifiers: modifiers)
    }

    /// Registers the accelerator; any previous registration is replaced. Returns false when
    /// the string is unparsable or the OS refuses (combo taken by another app).
    @discardableResult
    public func register(_ accelerator: String, onPress: @escaping () -> Void) -> Bool {
        unregister()
        guard let parsed = Self.parse(accelerator) else { return false }
        callback = onPress

        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()
        let installStatus = InstallEventHandler(
            GetEventDispatcherTarget(),
            { _, _, userData in
                guard let userData else { return noErr }
                let manager = Unmanaged<HotkeyManager>.fromOpaque(userData).takeUnretainedValue()
                DispatchQueue.main.async { manager.callback?() }
                return noErr
            },
            1, &eventType, selfPtr, &handlerRef
        )
        guard installStatus == noErr else { return false }

        let hotKeyID = EventHotKeyID(signature: OSType(0x5646_4F58) /* "VFOX" */, id: 1)
        let registerStatus = RegisterEventHotKey(
            parsed.keyCode, parsed.carbonModifiers, hotKeyID, GetEventDispatcherTarget(), 0, &hotKeyRef
        )
        if registerStatus != noErr {
            unregister()
            return false
        }
        return true
    }

    public func unregister() {
        if let hotKeyRef {
            UnregisterEventHotKey(hotKeyRef)
            self.hotKeyRef = nil
        }
        if let handlerRef {
            RemoveEventHandler(handlerRef)
            self.handlerRef = nil
        }
        callback = nil
    }

    /// Non-destructive availability probe used by the settings UI before applying a new combo.
    public static func checkAvailable(_ accelerator: String) -> Bool {
        guard let parsed = parse(accelerator) else { return false }
        var probeRef: EventHotKeyRef?
        let hotKeyID = EventHotKeyID(signature: OSType(0x5646_4F58), id: 999)
        let status = RegisterEventHotKey(parsed.keyCode, parsed.carbonModifiers, hotKeyID, GetEventDispatcherTarget(), 0, &probeRef)
        if status == noErr, let probeRef {
            UnregisterEventHotKey(probeRef)
            return true
        }
        return false
    }
}
