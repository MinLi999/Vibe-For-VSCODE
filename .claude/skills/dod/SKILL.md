---
name: dod
description: Run the Definition-of-Done self-check before declaring a task complete. Use before saying "done", before committing, or when asked to verify a change is delivery-ready.
---
# 交付前自查

执行 docs/03-DOD.md 全清单,逐项核对并修复失败项后再回报。这是程序,真的去跑命令:

```bash
# 分层纯洁度
grep -rn "vscode\.window\|vscode\.commands" client/src/models/ || echo "✅ M"
grep -rn "fetch(\|spawn(\|exec(" client/src/viewer/ || echo "✅ V"
grep -rn "vscode\.window\." client/src/services/ || echo "✅ S"
# 构建
cd client && npm run typecheck && npm run compile && cd ..
cd server && npm run typecheck && cd ..
```

全部通过后:更新 docs/STATE.md,核对 docs/01-PRD.md 是否需同步。未经要求不提交不推送。
