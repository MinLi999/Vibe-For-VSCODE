import AppKit
import SwiftUI
import VibeFoxCore

struct HomeView: View {
    @EnvironmentObject private var model: AppModel
    @State private var search = ""
    @State private var copiedAt: Double?
    @State private var correcting: TranscriptHistoryEntry?
    @State private var learnFeedback: String?

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
                        if let learnFeedback {
                            Text(learnFeedback).font(.callout).foregroundStyle(.green)
                        }
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
                                        Button {
                                            correcting = entry
                                        } label: {
                                            Image(systemName: "pencil.line")
                                        }
                                        .buttonStyle(.borderless)
                                        .help("改错回学:把听错的地方改对,VibeFox 会记住这些词")
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
        .sheet(item: $correcting) { entry in
            CorrectionSheet(original: entry.text) { corrected in
                let learned = model.learnFromCorrection(original: entry.text, corrected: corrected)
                learnFeedback = learned.isEmpty
                    ? "没有发现可学习的改动"
                    : "已学习 \(learned.count) 组:" + learned.map { "\($0.from)→\($0.to)" }.joined(separator: "、")
            }
        }
    }

    private static func format(at epochMs: Double) -> String {
        let date = Date(timeIntervalSince1970: epochMs / 1000)
        let formatter = DateFormatter()
        formatter.dateFormat = Calendar.current.isDateInToday(date) ? "HH:mm" : "M/d HH:mm"
        return formatter.string(from: date)
    }
}

/// The "手改回学" sheet: the user edits a transcript into what they actually said; every
/// replaced span is learned as a (misheard → correct) dictionary pair on save.
private struct CorrectionSheet: View {
    let original: String
    let onSave: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var edited: String

    init(original: String, onSave: @escaping (String) -> Void) {
        self.original = original
        self.onSave = onSave
        _edited = State(initialValue: original)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("改错回学").font(.title3.bold())
            Text("把听错的地方改成你实际说的。保存后,改动的词会进入词库(来源标记 ✨学习),之后的识别、改写和同音字校正都会用上它们。")
                .font(.callout).foregroundStyle(.secondary)
            TextEditor(text: $edited)
                .font(.body)
                .frame(minHeight: 120)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary))
            HStack {
                Spacer()
                Button("取消") { dismiss() }
                Button("保存并学习") {
                    onSave(edited)
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
                .disabled(edited.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || edited == original)
            }
        }
        .padding(20)
        .frame(width: 520)
    }
}
