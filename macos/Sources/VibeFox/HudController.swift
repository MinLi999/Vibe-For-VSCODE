import AppKit
import SwiftUI
import VibeFoxCore

/// Floating recording HUD: a small non-activating panel at the bottom-center of the screen
/// showing the live level bars, the streaming partial tail, and the processing state.
/// MUST never steal focus — the paste target has to keep keyboard focus — hence a
/// borderless .nonactivatingPanel that ignores mouse events entirely (display-only in V1).
@MainActor
final class HudController {
    private var panel: NSPanel?

    func show(model: AppModel) {
        if panel == nil {
            let hosting = NSHostingView(rootView: HudView().environmentObject(model))
            let newPanel = NSPanel(
                contentRect: NSRect(x: 0, y: 0, width: 340, height: 56),
                styleMask: [.borderless, .nonactivatingPanel],
                backing: .buffered,
                defer: false
            )
            newPanel.contentView = hosting
            newPanel.isFloatingPanel = true
            newPanel.level = .statusBar
            newPanel.backgroundColor = .clear
            newPanel.isOpaque = false
            newPanel.hasShadow = false // The SwiftUI capsule draws its own shadow.
            newPanel.ignoresMouseEvents = true
            newPanel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            newPanel.isReleasedWhenClosed = false
            panel = newPanel
        }
        position()
        panel?.orderFrontRegardless()
    }

    func hide() {
        panel?.orderOut(nil)
    }

    private func position() {
        guard let panel, let screen = NSScreen.main else { return }
        let frame = screen.visibleFrame
        let size = panel.frame.size
        panel.setFrameOrigin(NSPoint(
            x: frame.midX - size.width / 2,
            y: frame.minY + 28
        ))
    }
}

struct HudView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        HStack(spacing: 10) {
            if model.phase == .processing {
                ProgressView().controlSize(.small)
                Text("转写中…").font(.callout).foregroundStyle(.secondary)
            } else {
                Circle().fill(.red).frame(width: 9, height: 9)
                HudBars(level: model.inputLevel)
                if !model.partialText.isEmpty {
                    Text(model.partialText.suffix(18))
                        .font(.callout).foregroundStyle(.secondary)
                        .lineLimit(1)
                        .frame(maxWidth: 180, alignment: .trailing)
                } else if model.inFlightSegments > 0 {
                    // Recording continues while an earlier segment is still being transcribed —
                    // say so, otherwise the gap reads as "it lost what I just said".
                    HStack(spacing: 5) {
                        ProgressView().controlSize(.small)
                        Text("上一段转写中…").font(.callout).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.regularMaterial, in: Capsule())
        .overlay(Capsule().stroke(.quaternary, lineWidth: 0.5))
        .shadow(color: .black.opacity(0.25), radius: 10, y: 3)
        .frame(width: 340, height: 56)
    }
}

/// Symmetric level bars driven by the live input level (center-weighted, like a voice memo).
struct HudBars: View {
    let level: Float
    private static let weights: [Float] = [0.35, 0.55, 0.8, 1.0, 0.8, 0.55, 0.35]

    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<Self.weights.count, id: \.self) { index in
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(.green)
                    .frame(width: 3, height: CGFloat(4 + 18 * min(1, level) * Self.weights[index]))
                    .animation(.linear(duration: 0.1), value: level)
            }
        }
        .frame(height: 24)
    }
}
