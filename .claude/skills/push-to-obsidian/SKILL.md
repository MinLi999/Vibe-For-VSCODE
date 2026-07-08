---
name: push-to-obsidian
description: Distill a solved, broadly-reusable problem from this project into the Obsidian vault (Skills/ or Post-Mortems/), sanitized. Use after DoD passes and the user agrees to persist the knowledge.
---
# 脱敏沉淀到 Obsidian

Vault:`/Users/elvisli/Library/Mobile Documents/com~apple~CloudDocs/Obsidian`(iCloud 路径即本地路径;MCP 报 Access denied 时直接用原生 Read/Write,见 playbook §5.4)。

1. 判断归属:可复用模式 → `Skills/<域>/`(本项目常见:`Skills/Cloudflare/`、新建 `Skills/VSCode-Extension/`);疑难排错 → `Post-Mortems/`。
2. **脱敏**:剥离产品名、真实路径、密钥、业务字段;代码块用占位符(`<LICENSE_KEY>`、`my-app`)。
3. 笔记格式:顶部 `#标签` 行 + `[[反向链接]]`;正文 = 问题 → 模式 → 可复制代码 → 坑。
4. 若目录有 `_index.md`,追加一行条目。
5. 写完回读确认,并把笔记路径回报用户。
