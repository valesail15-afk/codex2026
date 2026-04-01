# 🤖 AI 编程协作规则文件 v1.1

> 本文件是本项目 AI 协作的最高优先级行为规则。
> 每次对话开始前，必须先阅读 `RULES.md` 与 `PROJECT_DOC.md`。

---

## 一、核心原则
1. 文档驱动开发：先更新文档，再写代码，保持文档与代码一致。
2. 最小改动原则：只改本次任务必需内容，不顺手重构无关模块。
3. 高风险先确认：涉及架构变更、删除文件、公共模块、依赖变更时，先说明方案并等待确认。
4. 中文优先：对话、注释、文档、提交说明默认使用中文（代码标识符除外）。
5. 编码安全：项目文本统一 UTF-8，避免乱码与不可见污染字符。

---

## 二、默认启用技能（Skill）
### 2.1 技能定义
- 技能名：`project-governance-cn`
- 路径：`C:\Users\hl\.codex\skills\project-governance-cn\SKILL.md`
- 目标：沉淀项目功能流程、设计规范、约束规则，并执行重启与编码自检。

### 2.2 触发场景
出现以下场景时，默认按该 Skill 执行：
- 记录流程、更新文档、项目约束、页面命名、组件统一
- 当前进度、项目状态、问题复盘
- 项目重启验证、乱码排查、中文一致性检查

### 2.3 强制检查命令
- 重启后真实浏览器验证：
```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\hl\.codex\skills\project-governance-cn\scripts\startup-real-browser-check.ps1 -Url "http://localhost:5173"
```
- 中文/编码检查：
```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\hl\.codex\skills\project-governance-cn\scripts\encoding-check.ps1 -Root .
```

---

## 三、开发阶段执行规则
### 3.1 修改前
1. 说明本次目标与影响范围。
2. 列出将修改/创建/删除的文件。
3. 获得用户确认后再执行（紧急修复除外）。

### 3.2 修改后
必须同步更新 `PROJECT_DOC.md`，至少检查：
- 模块状态
- 文件结构
- 流程链路
- 接口与数据模型
- 变更记录
- TODO 与测试清单

### 3.3 页面与组件一致性
- 每个页面必须有固定命名：`页面中文名 + Route + 页面ID`。
- 同类组件统一交互规则：按钮状态、表单校验、加载/空态/错误态。
- 服务层返回结构和字段命名保持一致，避免同功能不同格式。

---

## 四、测试与验收
当用户说“开始测试”或“全面测试”时：
1. 读取 `PROJECT_DOC.md` 测试清单。
2. 按 单元 -> 集成 -> 流程 -> 边界 -> 规范 检查执行。
3. 输出测试报告并回填测试状态。

---

## 五、文件保护（修改前必须确认）
- `.env` 与环境配置
- 数据库迁移文件
- `package.json` / `requirements.txt` 等依赖文件
- CI/CD 配置文件
- 本规则文件 `RULES.md`

---

## 六、自检清单
- [ ] 代码是否可运行
- [ ] 是否引入新依赖并已说明
- [ ] 是否影响公共接口并已同步
- [ ] `PROJECT_DOC.md` 是否更新
- [ ] 是否记录新的 TODO
- [ ] 是否给出下一步建议

---

> 如需修改本规则，需用户明确同意，并记录到 `PROJECT_DOC.md` 的变更记录。