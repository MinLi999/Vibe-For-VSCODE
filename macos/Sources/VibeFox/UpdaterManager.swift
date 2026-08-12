import Combine
import Sparkle
import SwiftUI

/// Wraps Sparkle's standard updater so the menu bar can show a "Check for Updates…" item
/// that's disabled while a check is already in flight. Starts the updater on init (Sparkle's
/// own scheduled-check timer takes it from there per Info.plist SUScheduledCheckInterval).
@MainActor
final class UpdaterManager: ObservableObject {
    private let controller: SPUStandardUpdaterController
    @Published private(set) var canCheckForUpdates = true
    private var cancellable: AnyCancellable?

    init() {
        controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
        cancellable = controller.updater.publisher(for: \.canCheckForUpdates)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] in self?.canCheckForUpdates = $0 }
    }

    func checkForUpdates() {
        controller.updater.checkForUpdates()
    }
}
