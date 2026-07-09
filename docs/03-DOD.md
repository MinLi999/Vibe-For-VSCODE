# 交付标准(Definition of Done)
> ⚠️ 回复「完成」前静默执行并修复失败项;/dod 可手动触发。

## 1. 架构纯洁度(分层未越界)

```bash
# Model 层禁 UI(应零输出)
grep -rn "vscode\.window\|vscode\.commands" client/src/models/ && echo "❌ M 层越界" || echo "✅ M"
# Viewer 层禁 I/O 与进程(应零输出)
grep -rn "fetch(\|spawn(\|exec(" client/src/viewer/ && echo "❌ V 层越界" || echo "✅ V"
# Service 层禁 UI(应零输出)
grep -rn "vscode\.window\." client/src/services/ && echo "❌ S 层越界" || echo "✅ S"
# M/V/S 互不引用(应零输出)
grep -rn "from ['\"]\.\./\(viewer\|controllers\|services\)" client/src/models/
grep -rn "from ['\"]\.\./\(models\|controllers\|services\)" client/src/viewer/
grep -rn "from ['\"]\.\./\(models\|viewer\|controllers\)" client/src/services/
```

## 2. 项目硬规则

```bash
# 密钥不进源码/配置(应零输出;placeholder 与 SecretStorage API 除外)
grep -rn "LICENSE_KEY\s*=\|Bearer [A-Za-z0-9]\{16,\}" client/src server/src
# 语言锁与上限的权威数值未被偷改(源码用单引号,故不锚定引号类型)
grep -n "= 'zh'" server/src/transcribe.ts && grep -n "maxRecordSeconds" client/package.json && grep -n "MAX_AUDIO_BASE64 = 8" server/src/transcribe.ts
```

## 3. 构建与验证

```bash
cd client && npm run typecheck && npm run compile && cd ..
cd server && npm run typecheck && cd ..
python3 -m json.tool .mcp.json > /dev/null && echo "✅ .mcp.json"
```

- [ ] client 编译产物 `client/dist/extension.js` 存在且无 esbuild 告警
- [ ] server `wrangler dev` 冒烟:无 auth → 401;假 key → 403;超大 payload → 413(有条件时)

## 4. 更新 STATE.md / 对齐 PRD / 知识沉淀

- [ ] docs/STATE.md 用主管视角回写(相对日期转绝对日期)
- [ ] 行为变更已同步 docs/01-PRD.md 功能矩阵
- [ ] 普适难题已解决的,问用户是否 /push-to-obsidian

## 5. 未经要求不提交不推送
