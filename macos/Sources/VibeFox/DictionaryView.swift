import AppKit
import SwiftUI
import VibeFoxCore

struct DictionaryView: View {
    @EnvironmentObject private var model: AppModel
    @State private var search = ""
    @State private var newWord = ""
    @State private var newAliases = ""
    @State private var editingWord: String?
    @State private var repFrom = ""
    @State private var repTo = ""
    @State private var repCaseSensitive = false
    @State private var showImport = false
    @State private var importText = ""
    @State private var feedback: String?

    private var filteredEntries: [DictionaryEntry] {
        search.isEmpty
            ? model.dictionary.entries
            : model.dictionary.entries.filter {
                $0.word.localizedCaseInsensitiveContains(search)
                    || $0.aliases.contains { $0.localizedCaseInsensitiveContains(search) }
            }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                GroupBox {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(editingWord == nil ? "添加词条" : "编辑「\(editingWord!)」").font(.headline)
                            Text("人名、产品名、代码标识符——凡是常被听错的词都值得加")
                                .font(.callout).foregroundStyle(.secondary)
                        }
                        HStack {
                            TextField("正确写法,如 useEffect", text: $newWord)
                                .textFieldStyle(.roundedBorder)
                            TextField("常被误识成…(可选,逗号分隔)", text: $newAliases)
                                .textFieldStyle(.roundedBorder)
                            Button(editingWord == nil ? "添加" : "保存") { saveEntry() }
                                .buttonStyle(.borderedProminent)
                                .disabled(newWord.trimmingCharacters(in: .whitespaces).isEmpty)
                            if editingWord != nil {
                                Button("取消") { resetForm() }
                            }
                        }
                        Text("词库总量不限(上限 10,000 条);每次转写自动挑选最相关的 ≤40 个词做识别偏置,常用词自动优先。")
                            .font(.callout).foregroundStyle(.secondary)
                        if let feedback {
                            Text(feedback).font(.callout).foregroundStyle(.green)
                        }
                    }
                    .padding(6)
                }

                GroupBox {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text("词条").font(.headline)
                            Text("共 \(model.dictionary.entries.count) 条").font(.callout).foregroundStyle(.secondary)
                            Spacer()
                            Button("导出 JSON") {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(model.dictExportJson(), forType: .string)
                                feedback = "词库 JSON 已复制到剪贴板"
                            }
                            Button(showImport ? "收起导入" : "导入…") { showImport.toggle() }
                        }
                        if showImport {
                            TextEditor(text: $importText)
                                .font(.body.monospaced())
                                .frame(height: 80)
                                .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))
                            Button("导入并合并") {
                                if let added = model.dictImport(json: importText) {
                                    feedback = "导入完成,新增 \(added) 条"
                                    importText = ""
                                    showImport = false
                                } else {
                                    feedback = "导入失败:JSON 格式不正确"
                                }
                            }
                            .buttonStyle(.borderedProminent)
                        }
                        TextField("搜索词条…", text: $search).textFieldStyle(.roundedBorder)

                        if filteredEntries.isEmpty {
                            Text("(空——从上方添加第一个词)").foregroundStyle(.secondary).padding(.vertical, 6)
                        } else {
                            ForEach(filteredEntries) { entry in
                                HStack(alignment: .firstTextBaseline) {
                                    Text(entry.word).fontWeight(.medium)
                                    sourceBadge(entry.source)
                                    if !entry.aliases.isEmpty {
                                        Text(entry.aliases.joined(separator: "、"))
                                            .font(.callout).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Text("命中 \(entry.hits)").font(.callout).foregroundStyle(.secondary)
                                    Button("编辑") {
                                        editingWord = entry.word
                                        newWord = entry.word
                                        newAliases = entry.aliases.joined(separator: ", ")
                                    }
                                    Button("删除", role: .destructive) { model.dictRemove(word: entry.word) }
                                }
                                Divider()
                            }
                        }
                    }
                    .padding(6)
                }

                GroupBox {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text("替换规则").font(.headline)
                            Text("转写完成后在本机执行的确定性替换,不限数量、不耗额度")
                                .font(.callout).foregroundStyle(.secondary)
                        }
                        HStack {
                            TextField("把这个…(如:艾特符号)", text: $repFrom).textFieldStyle(.roundedBorder)
                            TextField("替换成这个…(如:@)", text: $repTo).textFieldStyle(.roundedBorder)
                            Toggle("区分大小写", isOn: $repCaseSensitive)
                            Button("添加") {
                                model.dictAddReplacement(from: repFrom, to: repTo, caseSensitive: repCaseSensitive)
                                repFrom = ""
                                repTo = ""
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(repFrom.trimmingCharacters(in: .whitespaces).isEmpty)
                        }
                        if model.dictionary.replacements.isEmpty {
                            Text("(空)适合:邮箱地址、符号口令、强制大小写的术语。")
                                .font(.callout).foregroundStyle(.secondary)
                        } else {
                            ForEach(model.dictionary.replacements) { rule in
                                HStack {
                                    Text(rule.from)
                                    if rule.caseSensitive {
                                        Text("Aa").font(.caption2).padding(.horizontal, 4)
                                            .background(.quaternary, in: RoundedRectangle(cornerRadius: 3))
                                    }
                                    Image(systemName: "arrow.right").font(.callout).foregroundStyle(.secondary)
                                    Text(rule.to)
                                    Spacer()
                                    Button("删除", role: .destructive) { model.dictRemoveReplacement(from: rule.from) }
                                }
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

    @ViewBuilder
    private func sourceBadge(_ source: String) -> some View {
        if source == "learned" {
            Text("✨ 学习").font(.caption2).padding(.horizontal, 5).padding(.vertical, 1)
                .background(.orange.opacity(0.15), in: Capsule())
        } else if source == "contacts" {
            Text("👤 通讯录").font(.caption2).padding(.horizontal, 5).padding(.vertical, 1)
                .background(.blue.opacity(0.15), in: Capsule())
        }
    }

    private func saveEntry() {
        let aliases = newAliases
            .split(whereSeparator: { ",,、".contains($0) })
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        if let editingWord {
            model.dictUpdate(original: editingWord, word: newWord, aliases: aliases)
            feedback = "已保存"
        } else {
            model.dictAdd(word: newWord, aliases: aliases)
            feedback = "已添加「\(newWord.trimmingCharacters(in: .whitespaces))」"
        }
        resetForm()
    }

    private func resetForm() {
        editingWord = nil
        newWord = ""
        newAliases = ""
    }
}
