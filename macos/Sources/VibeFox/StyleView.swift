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
