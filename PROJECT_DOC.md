# 📋 项目文档 - AFK 套利系统

> 创建时间：2026-03-24
> 最后更新：2026-04-01 14:15
> 版本号：v1.8.1
> 当前阶段：开发中

---

## 1. 项目概述
- 项目名称：AFK 套利系统
- 项目描述：聚合竞彩网与皇冠赔率，生成可执行的单场/二串一套利方案并提供收益分析。
- 技术栈：React + Vite + Ant Design + Express + TypeScript + SQLite
- 运行环境：Node.js 22+

---

## 2. 功能模块目录

| 模块编号 | 模块名称 | 功能描述 | 状态 | 负责文件 |
|---|---|---|---|---|
| M01 | 认证与用户 | 登录、权限、会话、管理员后台 | ✅ 已完成 | `server.ts`, `src/server/auth.ts`, `src/pages/UserManagement.tsx` |
| M02 | 比赛与赔率 | 比赛列表、手动维护、同步状态 | 🔧 开发中 | `server.ts`, `src/pages/MatchList.tsx` |
| M03 | 单场套利 | 单场策略计算与方案明细 | ✅ 已完成 | `src/server/arbitrageEngine.ts`, `src/pages/Calculator.tsx` |
| M04 | 二串一套利 | 二串一策略生成与收益分析 | 🔧 开发中 | `src/server/arbitrageEngine.ts`, `src/pages/ParlayCalculator.tsx` |
| M05 | 配置中心 | 返水、分成、同步间隔配置 | ✅ 已完成 | `src/pages/Settings.tsx`, `server.ts` |
| M06 | 质量门禁 | 文本完整性与 CI 构建检查 | ✅ 已完成 | `tools/check-text-integrity.mjs`, `.github/workflows/quality-gate.yml` |
| M07 | 文案解析共享 | 胜平负/让球解析与统一化 | 🔧 开发中 | `src/shared/oddsText.ts` |

---

## 3. 文件目录结构

```text
D:/afk/
├── server.ts
├── PROJECT_DOC.md
├── RULES.md
├── TEXT_INTEGRITY.md
├── tools/
│   └── check-text-integrity.mjs
├── .github/
│   └── workflows/
│       └── quality-gate.yml
├── src/
│   ├── pages/
│   ├── server/
│   ├── shared/
│   │   └── oddsText.ts
│   └── types.ts
└── arbitrage.db
```

---

## 4. 功能流程链路

### 4.1 自动同步与倒计时
```text
系统定时同步 -> 写入比赛与赔率 -> 返回 refresh-status
-> 前端展示 remaining_seconds 与 next_sync_at -> 到点触发下一轮同步
```
- 输入：同步间隔、上次同步时间
- 输出：`remaining_seconds`、`next_sync_at`
- 异常处理：接口异常时前端保持上次状态并自动重试

### 4.2 单场/二串一套利
```text
读取赔率 -> 生成候选下注方向 -> 求解对冲金额
-> 校验收益约束 -> 输出可执行方案 -> 前端展示下注明细与收益
```
- 输入：竞彩网赔率、皇冠赔率、返水、分成、基准金额
- 输出：策略结果、下注明细、预期收益
- 异常处理：不满足约束（如利润不为正）则不返回推荐方案

### 4.3 新建用户（治理标准流程）
```text
打开“用户管理”导航 -> 点击“新增用户”按钮 -> 填写必填项并提交 -> 创建成功并显示在列表
```
- 输入：用户名、角色、初始凭据等必填字段
- 输出：用户创建成功提示与列表刷新
- 异常处理：字段校验失败或接口失败时给出明确错误提示

---

## 5. API / 接口设计（核心）

| 接口路径 | 方法 | 描述 | 请求参数 | 返回 |
|---|---|---|---|---|
| `/api/matches` | GET | 比赛列表 | - | `Match[]` |
| `/api/matches/refresh-status` | GET | 同步状态与倒计时 | - | `{remaining_seconds,next_sync_at,...}` |
| `/api/arbitrage/opportunities` | GET | 单场套利列表 | `base_type` | `Opportunity[]` |
| `/api/arbitrage/parlay-opportunities` | GET | 二串一套利列表 | `base_type` | `ParlayOpportunity[]` |
| `/api/arbitrage/parlay-opportunities/:id` | GET | 二串一详情 | `id,base_type` | `ParlayOpportunity` |
| `/api/arbitrage/rescan` | POST | 重新扫描套利机会 | - | `{status}` |

---

## 6. 数据模型设计（摘要）

### 6.1 `matches`
| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `match_id` | TEXT | 是 | 比赛唯一标识 |
| `league` | TEXT | 是 | 联赛 |
| `home_team` | TEXT | 是 | 主队 |
| `away_team` | TEXT | 是 | 客队 |
| `match_time` | TEXT | 是 | 开赛时间 |
| `handicap` | TEXT | 否 | 让球 |
| `jingcai_handicap` | TEXT | 否 | 竞彩网让球 |

### 6.2 `parlay_opportunities`
| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `match_id_1` | TEXT | 是 | 第一场比赛 ID |
| `match_id_2` | TEXT | 是 | 第二场比赛 ID |
| `side_1` | TEXT | 是 | 第一场下注方向 |
| `side_2` | TEXT | 是 | 第二场下注方向 |
| `best_strategy` | TEXT(JSON) | 是 | 最优方案明细 |
| `profit_rate` | REAL | 是 | 利润率 |

---

## 7. 设计规范与项目约束

### 7.1 代码规范
- TypeScript 严格类型；核心计算优先纯函数。
- 同一业务术语统一命名，避免同义多词。
- 不做无关重构，控制改单范围。

### 7.2 文本与编码规范
- 文本文件统一 UTF-8（无 BOM）。
- 提交前执行：`node tools/check-text-integrity.mjs`。
- 乱码治理脚本：
```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\hl\.codex\skills\project-governance-cn\scripts\encoding-check.ps1 -Root .
```

### 7.3 页面命名规范

| 页面中文名 | Route | 页面ID | 说明 |
|---|---|---|---|
| 用户管理 | `/users` | `PAGE_USER_MANAGEMENT` | 用户增删改查 |
| 比赛列表 | `/matches` | `PAGE_MATCH_LIST` | 比赛与赔率查看 |
| 单场套利 | `/calculator` | `PAGE_SINGLE_ARBITRAGE` | 单场套利计算 |
| 二串一套利 | `/parlay` | `PAGE_PARLAY_ARBITRAGE` | 二串一策略与收益 |
| 配置中心 | `/settings` | `PAGE_SETTINGS` | 参数配置与系统设置 |

### 7.4 组件交互一致性
- 按钮统一三态：默认、加载、禁用。
- 表单统一校验时机：提交时 + 失焦二次校验。
- 错误提示统一位置与文案风格。
- 列表页统一处理空态、加载态、失败重试。

### 7.5 启动验证约束（必须执行）
```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\hl\.codex\skills\project-governance-cn\scripts\startup-real-browser-check.ps1 -Url "http://localhost:5173"
```

---

## 8. 变更记录

| 版本 | 日期 | 变更内容 | 涉及模块 |
|---|---|---|---|
| v1.8.1 | 2026-04-01 | 接入 `project-governance-cn` 技能；修复 `RULES.md/PROJECT_DOC.md` 乱码；新增治理基线、页面命名、统一交互与启动/编码自检规范 | M06/M07 |
| v1.8.0 | 2026-03-30 | 重写项目文档；新增 CI 质量门禁；优化二串一收益口径与展示一致性 | M04/M06/M07 |

---

## 9. 已知问题 & TODO
- [ ] 前后端赔率方向解析仍有重复实现，继续收敛到 `src/shared/oddsText.ts`。
- [ ] 二串一算法继续优化，确保推荐结果稳定满足正收益约束。
- [ ] 历史页面和文案残留编码污染继续清理。

---

## 10. 测试清单

| 测试编号 | 测试项 | 所属模块 | 测试类型 | 预期结果 | 实际结果 | 状态 |
|---|---|---|---|---|---|---|
| T01 | 文本完整性检查 | M06 | 规范检查 | 无乱码与非法替代字符 | 待执行 | ⬜ |
| T02 | TypeScript 与 Lint | M06 | 构建检查 | `npm run lint` 通过 | 待执行 | ⬜ |
| T03 | 前端构建 | M06 | 构建检查 | `npm run build` 通过 | 待执行 | ⬜ |
| T04 | 比赛倒计时链路 | M02 | 流程测试 | 倒计时每秒递减并到点刷新 | 待执行 | ⬜ |
| T05 | 用户管理新增用户 | M01 | 流程测试 | 可完成新增并回显到列表 | 待执行 | ⬜ |
| T06 | 二串一收益一致性 | M04 | 算法测试 | 展示口径与计算结果一致 | 待执行 | ⬜ |

---

## 11. 文档同步检查
- [x] 模块状态已同步
- [x] 文件结构已同步
- [x] 流程链路已同步
- [x] 接口设计已同步
- [x] 数据模型已同步
- [x] 变更记录已同步
- [x] TODO 已同步
- [x] 测试清单已同步
- [x] 最后更新时间已刷新