import AppKit
import SwiftUI
import VibeFoxCore

struct HomeView: View {
    @EnvironmentObject private var model: AppModel
    @State private var search = ""
    @State private var copiedAt: Double?

    private var filteredHistory: [TranscriptHistoryEntry] {
        search.isEmpty
            ? model.history.entries
            : model.history.entries.filter { $0.text.localizedCaseInsensitiveContains(search) }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 12) {
                    StatCard(number: "\(model.stats.todayChars)", label: "今日字数")
                    StatCard(number: "\(model.stats.totalChars)", label: "累计字数")
                    StatCard(number: "\(model.stats.totalSessions)", label: "录音次数")
                    StatCard(number: model.savedTimeText, label: "估算节省时间")
                }

                GroupBox {
                    HStack(spacing: 12) {
                        Button {
                            model.toggleRecording()
                        } label: {
                            Label(model.phase == .recording ? "停止录音并转写" : "开始录音",
                                  systemImage: model.phase == .recording ? "stop.fill" : "mic.fill")
                                .frame(minWidth: 140)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .disabled(model.phase == .processing)

                        if model.phase == .recording {
                            LevelMeter(level: model.inputLevel).frame(width: 160)
                        }
                        if !model.partialText.isEmpty {
                            Text(model.partialText.suffix(24))
                                .font(.callout).foregroundStyle(.secondary).lineLimit(1)
                        } else {
                            Text("全局热键 \(model.config.hotkey) 在任何应用中可用,结果粘贴到当前光标处。")
                                .font(.callout).foregroundStyle(.secondary)
                        }
                        Spacer()
                    }
                    .padding(6)
                }

                GroupBox {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text("转写历史").font(.headline)
                            Text("仅保存在本机,点击任意一条复制全文").font(.callout).foregroundStyle(.secondary)
                            Spacer()
                            Button("清空", role: .destructive) { model.clearHistory() }
                                .disabled(model.history.entries.isEmpty)
                        }
                        TextField("搜索历史…", text: $search)
                            .textFieldStyle(.roundedBorder)
                        if filteredHistory.isEmpty {
                            Text("(暂无记录)").foregroundStyle(.secondary).padding(.vertical, 8)
                        } else {
                            ForEach(filteredHistory) { entry in
                                Button {
                                    NSPasteboard.general.clearContents()
                                    NSPasteboard.general.setString(entry.text, forType: .string)
                                    copiedAt = entry.at
                                } label: {
                                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                                        Text(Self.format(at: entry.at))
                                            .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                                        Text(entry.text).lineLimit(1)
                                        Spacer()
                                        if copiedAt == entry.at {
                                            Text("已复制 ✓").font(.callout).foregroundStyle(.green)
                                        }
                                    }
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                Divider()
                            }
                        }
                    }
                    .padding(6)
                }
            }
            .padding(16)
        }
    }

    private static func format(at epochMs: Double) -> String {
        let date = Date(timeIntervalSince1970: epochMs / 1000)
        let formatter = DateFormatter()
        formatter.dateFormat = Calendar.current.isDateInToday(date) ? "HH:mm" : "M/d HH:mm"
        return formatter.string(from: date)
    }
}
