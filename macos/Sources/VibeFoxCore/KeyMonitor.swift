import AppKit
import Foundation

/// Global hotkey via a CGEvent tap — unlike Carbon RegisterEventHotKey this delivers real
/// keyDown AND keyUp, enabling dual semantics (tap = toggle, hold = push-to-talk), and can
/// listen for the bare Fn key (accelerator string "Fn", native-only). Requires Accessibility
/// trust (the same grant the paste path needs); creation fails without it and the caller
/// falls back to the Carbon toggle-only hotkey.
public final class KeyMonitor: @unchecked Sendable {
    private var tap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var targetKeyCode: UInt32 = 0
    private var targetFlags: CGEventFlags = []
    private var isFnMode = false
    private var fnIsDown = false
    /// Delivered on the main queue.
    private var onDown: (() -> Void)?
    private var onUp: (() -> Void)?

    public init() {}

    deinit {
        unregister()
    }

    /// Registers `accelerator` ("Command+Alt+Z" style, or "Fn"). Returns false when the
    /// accelerator is unparsable or the event tap can't be created (no Accessibility trust).
    @discardableResult
    public func register(_ accelerator: String, onDown: @escaping () -> Void, onUp: @escaping () -> Void) -> Bool {
        unregister()
        if accelerator.caseInsensitiveCompare("Fn") == .orderedSame {
            isFnMode = true
        } else {
            guard let parsed = HotkeyManager.parse(accelerator) else { return false }
            isFnMode = false
            targetKeyCode = parsed.keyCode
            targetFlags = Self.cgFlags(fromCarbon: parsed.carbonModifiers)
        }
        self.onDown = onDown
        self.onUp = onUp

        let mask: CGEventMask = isFnMode
            ? (1 << CGEventType.flagsChanged.rawValue)
            : (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue)
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap, // Matching key events are swallowed so they don't reach apps.
            eventsOfInterest: mask,
            callback: { _, type, event, userInfo in
                guard let userInfo else { return Unmanaged.passUnretained(event) }
                let monitor = Unmanaged<KeyMonitor>.fromOpaque(userInfo).takeUnretainedValue()
                return monitor.handle(type: type, event: event)
            },
            userInfo: selfPtr
        ) else {
            self.onDown = nil
            self.onUp = nil
            return false
        }
        self.tap = tap
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        runLoopSource = source
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        return true
    }

    public func unregister() {
        if let tap {
            CGEvent.tapEnable(tap: tap, enable: false)
        }
        if let runLoopSource {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), runLoopSource, .commonModes)
        }
        tap = nil
        runLoopSource = nil
        onDown = nil
        onUp = nil
        fnIsDown = false
    }

    private func handle(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        // The OS disables a tap that stalls; re-enable and keep going.
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap {
                CGEvent.tapEnable(tap: tap, enable: true)
            }
            return Unmanaged.passUnretained(event)
        }

        if isFnMode {
            guard type == .flagsChanged, event.getIntegerValueField(.keyboardEventKeycode) == 63 else {
                return Unmanaged.passUnretained(event)
            }
            let down = event.flags.contains(.maskSecondaryFn)
            if down != fnIsDown {
                fnIsDown = down
                emit(down ? onDown : onUp)
            }
            return Unmanaged.passUnretained(event) // Never swallow a modifier change.
        }

        guard UInt32(event.getIntegerValueField(.keyboardEventKeycode)) == targetKeyCode,
              event.flags.intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift]) == targetFlags else {
            return Unmanaged.passUnretained(event)
        }
        if type == .keyDown {
            // OS auto-repeat while held must not re-trigger.
            if event.getIntegerValueField(.keyboardEventAutorepeat) == 0 {
                emit(onDown)
            }
        } else if type == .keyUp {
            emit(onUp)
        }
        return nil // Swallow the hotkey so it doesn't type into the frontmost app.
    }

    private func emit(_ callback: (() -> Void)?) {
        guard let callback else { return }
        DispatchQueue.main.async { callback() }
    }

    private static func cgFlags(fromCarbon carbon: UInt32) -> CGEventFlags {
        var flags: CGEventFlags = []
        if carbon & 256 != 0 { flags.insert(.maskCommand) } // cmdKey
        if carbon & 512 != 0 { flags.insert(.maskShift) } // shiftKey
        if carbon & 2048 != 0 { flags.insert(.maskAlternate) } // optionKey
        if carbon & 4096 != 0 { flags.insert(.maskControl) } // controlKey
        return flags
    }
}
