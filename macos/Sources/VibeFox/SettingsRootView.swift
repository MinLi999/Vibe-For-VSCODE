import SwiftUI
import VibeFoxCore

/// Settings window root: onboarding wizard on first run, the four tabs afterwards.
struct SettingsRootView: View {
    @EnvironmentObject private var model: AppModel
    @State private var rerunOnboarding = false

    var body: some View {
        Group {
            if !model.config.onboardingDone || rerunOnboarding {
                OnboardingView(isRerun: rerunOnboarding) {
                    rerunOnboarding = false
                    model.config.onboardingDone = true
                    model.saveConfig()
                }
            } else {
                TabView {
                    HomeView().tabItem { Label("首页", systemImage: "house") }
                    DictionaryView().tabItem { Label("词库", systemImage: "character.book.closed") }
                    StyleView().tabItem { Label("风格", systemImage: "wand.and.stars") }
                    SettingsTabView(onRerunOnboarding: { rerunOnboarding = true })
                        .tabItem { Label("设置", systemImage: "gearshape") }
                }
                .padding(.top, 4)
            }
        }
        .frame(minWidth: 760, minHeight: 560)
        // Brand tint: the fox orange. Also fixes the default blue accent being hard to read
        // against the dark window background.
        .tint(Color(red: 0.95, green: 0.45, blue: 0.13))
    }
}

// MARK: shared small components

struct StatCard: View {
    let number: String
    let label: String

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(number).font(.system(size: 27, weight: .bold, design: .rounded))
            Text(label).font(.callout).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 12))
    }
}

struct LevelMeter: View {
    let level: Float

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 4).fill(.quaternary)
                RoundedRectangle(cornerRadius: 4)
                    .fill(.green)
                    .frame(width: geo.size.width * CGFloat(min(1, level)))
                    .animation(.linear(duration: 0.08), value: level)
            }
        }
        .frame(height: 8)
    }
}

extension AppModel {
    /// "X 时 Y 分" estimate against 40 chars/min hand-typing minus 200 chars/min speech.
    var savedTimeText: String {
        let minutes = max(0, stats.totalChars / 40 - stats.totalChars / 200)
        return minutes >= 60 ? "\(minutes / 60) 时 \(minutes % 60) 分" : "\(minutes) 分钟"
    }
}
