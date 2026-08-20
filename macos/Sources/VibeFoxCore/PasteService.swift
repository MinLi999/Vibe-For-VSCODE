import AppKit
import ApplicationServices
import Foundation

/// Delivers transcribed text to the frontmost app: clipboard + synthetic ⌘V (CGEvent),
/// optionally restoring the previous clipboard ~1s later. The synthetic keystroke needs
/// Accessibility trust; unlike the Electron-era AppleScript route, no Apple-events
/// permission is involved.
public enum PasteService {
    public static func accessibilityTrusted(prompt: Bool = false) -> Bool {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    public static func openAccessibilitySettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            NSWorkspace.shared.open(url)
        }
    }

    /// Always attempts the paste (the trust check can lag behind an actual grant); only
    /// restores the clipboard when trusted, so an un-landed paste never eats the text.
    public static func deliver(_ text: String, restoreClipboard: Bool) async {
        let pasteboard = NSPasteboard.general
        let previous = pasteboard.string(forType: .string)
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)

        // Give the hotkey's modifier keys time to be released before the synthetic ⌘V.
        try? await Task.sleep(nanoseconds: 180_000_000)
        postCommandV()

        if restoreClipboard && accessibilityTrusted() {
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            // Only restore if our text is still on the clipboard (don't clobber newer copies).
            if pasteboard.string(forType: .string) == text {
                pasteboard.clearContents()
                if let previous {
                    pasteboard.setString(previous, forType: .string)
                }
            }
        }
    }

    private static func postCommandV() {
        let source = CGEventSource(stateID: .combinedSessionState)
        let vKey: CGKeyCode = 9 // kVK_ANSI_V
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: vKey, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: vKey, keyDown: false) else {
            return
        }
        down.flags = .maskCommand
        up.flags = .maskCommand
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }
}

/// Frontmost-app category for the server's tone hint (port of desktop/src/frontmostApp.ts;
/// NSWorkspace replaces the AppleScript/System Events route — instant and permission-free).
public enum FrontmostApp {
    /// Substring → category. First match wins; anything unmatched (browsers included) is "other".
    static let bundleIdCategories: [(String, String)] = [
        ("com.anthropic.claudefordesktop", "chat"),
        ("com.openai.chat", "chat"),
        ("com.tinyspeck.slackmacgap", "chat"),
        ("com.hnc.Discord", "chat"),
        ("ru.keepcoder.Telegram", "chat"),
        ("com.tencent.xinWeChat", "chat"),
        ("net.whatsapp.WhatsApp", "chat"),
        ("com.microsoft.teams", "chat"),
        ("com.apple.mail", "email"),
        ("com.microsoft.Outlook", "email"),
        ("com.readdle.smartemail", "email"),
        ("com.airmailapp", "email"),
        ("com.apple.Notes", "notes"),
        ("notion.id", "notes"),
        ("md.obsidian", "notes"),
        ("com.apple.TextEdit", "notes"),
        ("net.shinyfrog.bear", "notes"),
        ("com.craft.docs", "notes"),
        ("com.microsoft.VSCode", "ide"),
        ("com.todesktop.", "ide"),
        ("com.jetbrains.", "ide"),
        ("com.google.android.studio", "ide"),
        ("com.sublimetext.", "ide"),
        ("dev.zed.Zed", "ide"),
        ("com.exafunction.windsurf", "ide"),
        ("com.apple.Terminal", "terminal"),
        ("com.googlecode.iterm2", "terminal"),
        ("dev.warp.Warp", "terminal"),
        ("com.github.wez.wezterm", "terminal"),
        ("net.kovidgoyal.kitty", "terminal"),
    ]

    /// Every category the rewrite stage understands. "ide"/"terminal"/"other" carry no tone
    /// instruction (default dictation tuning); "chat"/"email"/"notes" adjust tone/formatting.
    public static let categories = ["chat", "email", "notes", "ide", "terminal", "other"]

    public static func categorize(bundleId: String) -> String {
        let id = bundleId.trimmingCharacters(in: .whitespaces)
        for (needle, category) in bundleIdCategories where id.hasPrefix(needle) || id.contains(needle) {
            return category
        }
        return "other"
    }

    /// A user rule (exact bundle-id match) beats the built-in inference table — the whole
    /// point of per-app rules is overriding an inference the user disagrees with.
    public static func resolveCategory(bundleId: String, overrides: [String: String]) -> String {
        if let forced = overrides[bundleId], categories.contains(forced) {
            return forced
        }
        return categorize(bundleId: bundleId)
    }

    public static func currentBundleId() -> String? {
        NSWorkspace.shared.frontmostApplication?.bundleIdentifier
    }

    public static func currentCategory() -> String? {
        guard let bundleId = currentBundleId() else { return nil }
        return categorize(bundleId: bundleId)
    }
}
