import SwiftUI
import VibeFoxCore

struct StyleView: View {
    @EnvironmentObject private var model: AppModel

    private static let rewriteCards: [(String, String, String)] = [
        ("off", "原样转写", "一字不动,听到什么出什么"),
        ("clean", "智能清理(推荐)", "去嗯啊语气词、修标点、按词库校正拼写,不改语序"),
        ("rewrite", "深度润色", "折叠改口、轻度重组、口述列表自动排版成编号列表"),
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                GroupBox {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("改写模式").font(.headline)
                        HStack(spacing: 10) {
                            ForEach(Self.rewriteCards, id: \.0) { value, title, description in
                                Button {
                                    model.config.rewriteMode = value
                                    model.saveConfig()
                                } label: {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(title).fontWeight(.semibold)
                                        Text(description).font(.callout).foregroundStyle(.secondary)
                                            .multilineTextAlignment(.leading)
                                    }
                                    .frame(maxWidth: .infinity, minHeight: 64, alignment: .topLeading)
                                    .padding(10)
                                    .background(
                                        RoundedRectangle(cornerRadius: 10)
                                            .stroke(model.config.rewriteMode == value ? Color.accentColor : Color.gray.opacity(0.3),
                                                    lineWidth: model.config.rewriteMode == value ? 2 : 1)
                                    )
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    .padding(6)
                }

                GroupBox {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("语言与地区").font(.headline)
                        Picker("转写语言", selection: bind(\.language)) {
                            Text("自动检测(推荐,中英混说最佳)").tag("auto")
                            Text("强制中文").tag("zh")
                            Text("强制英文").tag("en")
                        }
                        Picker("中文变体", selection: bind(\.chineseVariant)) {
                            Text("简体 · 大陆").tag("simplified-cn")
                            Text("简体 · 新马").tag("simplified-sg-my")
                            Text("繁體 · 台灣").tag("traditional-tw")
                            Text("繁體 · 港澳").tag("traditional-hk-mo")
                        }
                        Picker("转写区域", selection: bind(\.dashscopeRegion)) {
                            Text("自动(按大洲就近)").tag("auto")
                            Text("新加坡区").tag("apac")
                            Text("美国区").tag("us")
                        }
                    }
                    .padding(6)
                }

                GroupBox {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Text("逐 App 语气规则").font(.headline)
                            Spacer()
                            addRuleMenu
                        }
                        Text("改写阶段会按当前前台应用自动适配语气(聊天随意、邮件得体、笔记好读)。在这里可以为某个应用强制指定,覆盖自动判断。")
                            .font(.callout).foregroundStyle(.secondary)
                        if model.config.appRules.isEmpty {
                            Text("暂无规则 —— 未列出的应用一律按内置表自动判断。")
                                .font(.callout).foregroundStyle(.tertiary)
                        } else {
                            ForEach(model.config.appRules.keys.sorted(), id: \.self) { bundleId in
                                appRuleRow(bundleId: bundleId)
                            }
                        }
                    }
                    .padding(6)
                }

                GroupBox {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text("流式转写").font(.headline)
                            Text("实验性 · 需质量档 License Key").font(.callout).foregroundStyle(.secondary)
                        }
                        Toggle("边说边转写,整句定稿即粘贴", isOn: bind(\.streamingMode))
                        Text("任何失败(握手/中断/超时)自动回落普通模式,内容不丢。")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                    .padding(6)
                }
            }
            .padding(16)
        }
        .pickerStyle(.menu)
    }

    // MARK: per-app tone rules

    /// Labels spell out that ide/terminal/other all mean "default dictation tuning" — three
    /// stored values, one behavior; hiding that would make the picker look broken.
    private static let categoryLabels: [(String, String)] = [
        ("chat", "聊天(轻松自然)"),
        ("email", "邮件(得体规范)"),
        ("notes", "笔记(便于阅读)"),
        ("ide", "代码编辑器(默认调校)"),
        ("terminal", "终端(默认调校)"),
        ("other", "默认(不调语气)"),
    ]

    private var addRuleMenu: some View {
        Menu("添加规则…") {
            let candidates = addableRunningApps
            if candidates.isEmpty {
                Text("正在运行的应用都已有规则")
            }
            ForEach(candidates, id: \.id) { app in
                Button(app.name) {
                    // Seed with the built-in inference so the picker starts from what would
                    // have happened anyway; the user then flips it to what they actually want.
                    model.config.appRules[app.id] = FrontmostApp.categorize(bundleId: app.id)
                    model.saveConfig()
                }
            }
        }
        .fixedSize()
    }

    /// Regular (Dock-visible) running apps without a rule yet — the realistic candidates for
    /// "I'm dictating into this app right now and dislike the tone it gets".
    private var addableRunningApps: [(id: String, name: String)] {
        NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular }
            .compactMap { app -> (id: String, name: String)? in
                guard let id = app.bundleIdentifier,
                      model.config.appRules[id] == nil,
                      id != Bundle.main.bundleIdentifier else { return nil }
                return (id, app.localizedName ?? id)
            }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    private func appRuleRow(bundleId: String) -> some View {
        HStack(spacing: 8) {
            Text(Self.appDisplayName(bundleId: bundleId))
                .frame(maxWidth: .infinity, alignment: .leading)
                .help(bundleId)
            Picker("", selection: Binding(
                get: { model.config.appRules[bundleId] ?? "other" },
                set: { newValue in
                    model.config.appRules[bundleId] = newValue
                    model.saveConfig()
                }
            )) {
                ForEach(Self.categoryLabels, id: \.0) { value, label in
                    Text(label).tag(value)
                }
            }
            .labelsHidden()
            .fixedSize()
            Button {
                model.config.appRules.removeValue(forKey: bundleId)
                model.saveConfig()
            } label: {
                Image(systemName: "trash")
            }
            .buttonStyle(.borderless)
            .help("删除该规则,恢复自动判断")
        }
    }

    private static func appDisplayName(bundleId: String) -> String {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else {
            return bundleId // Uninstalled since the rule was made — still identifiable.
        }
        return FileManager.default.displayName(atPath: url.path)
    }

    /// Two-way binding into config that persists on every change.
    private func bind<T>(_ keyPath: WritableKeyPath<AppConfig, T>) -> Binding<T> {
        Binding(
            get: { model.config[keyPath: keyPath] },
            set: { newValue in
                model.config[keyPath: keyPath] = newValue
                model.saveConfig()
            }
        )
    }
}
