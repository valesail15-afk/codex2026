# 📋 项目文档 - AFK 套利系统

> 创建时间：2026-03-24  
> 最后更新：2026-03-30  
> 版本号：v1.8.0  
> 当前阶段：开发中

---

## 1. 项目概述
- 项目名称：AFK 套利系统
- 项目描述：聚合竞彩与皇冠赔率，生成单场/二串一套利方案，并提供可执行下注明细与收益分析。
- 技术栈：React + Vite + Ant Design + Express + TypeScript + SQLite
- 运行环境：Node.js 22+

---

## 2. 功能模块目录

| 模块编号 | 模块名称 | 功能描述 | 状态 | 负责文件 |
|---|---|---|---|---|
| M01 | 认证与用户 | 登录、权限、会话、管理员后台 | ✅ 已完成 | `server.ts`, `src/server/auth.ts`, `src/pages/UserManagement.tsx` |
| M02 | 比赛与赔率 | 比赛列表、手动维护、同步状态 | 🔧 开发中 | `server.ts`, `src/pages/MatchList.tsx` |
| M03 | 单场套利 | 单场策略计算、方案明细 | ✅ 已完成 | `src/server/arbitrageEngine.ts`, `src/pages/Calculator.tsx` |
| M04 | 二串一套利 | 二串一策略生成、9宫格收益分析 | 🔧 开发中 | `src/server/arbitrageEngine.ts`, `src/pages/ParlayCalculator.tsx` |
| M05 | 配置中心 | 返水、分成、同步间隔等设置 | ✅ 已完成 | `src/pages/Settings.tsx`, `server.ts` |
| M06 | 质量门禁 | 文本完整性、CI 构建门禁 | ✅ 已完成 | `tools/check-text-integrity.mjs`, `.github/workflows/quality-gate.yml` |
| M07 | 文案解析共享 | 胜平负/让球解析与归一化 | 🔧 开发中 | `src/shared/oddsText.ts` |

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
系统定时同步 -> 写入比赛与赔率 -> 返回 refresh-status(next_sync_at/remaining_seconds)
-> 前端倒计时显示 -> 到点触发下一轮同步
```

- 输入：同步间隔、上次同步时间
- 输出：`remaining_seconds`、`next_sync_at`
- 异常处理：接口异常时前端保持上次状态并自动重试

### 4.2 单场/二串一套利

```text
读取比赛赔率 -> 生成候选下注方向 -> LP 求解对冲金额 ->
校验收益约束 -> 输出可执行方案 -> 前端展示下注项与收益分析
```

- 输入：竞彩赔率、皇冠赔率、返水、分成、投注基准金额
- 输出：策略、下注明细、预期收益
- 异常处理：若不满足约束（如总利润非正）不返回推荐方案

---

## 5. API / 接口设计（核心）

| 接口路径 | 方法 | 描述 | 请求参数 | 返回 |
|---|---|---|---|---|
| `/api/matches` | GET | 比赛列表 | - | `Match[]` |
| `/api/matches/refresh-status` | GET | 同步状态与倒计时 | - | `{remaining_seconds,next_sync_at,...}` |
| `/api/arbitrage/opportunities` | GET | 单场套利列表 | `base_type` | `Opportunity[]` |
| `/api/arbitrage/parlay-opportunities` | GET | 二串一套利列表 | `base_type` | `ParlayOpportunity[]` |
| `/api/arbitrage/parlay-opportunities/:id` | GET | 二串一详情 | `id, base_type` | `ParlayOpportunity` |
| `/api/arbitrage/rescan` | POST | 重新扫描 | - | `{status}` |

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
| `jingcai_handicap` | TEXT | 否 | 竞彩让球 |

### 6.2 `parlay_opportunities`
| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `match_id_1` | TEXT | 是 | 第一场比赛ID |
| `match_id_2` | TEXT | 是 | 第二场比赛ID |
| `side_1` | TEXT | 是 | 第一场下注方向 |
| `side_2` | TEXT | 是 | 第二场下注方向 |
| `best_strategy` | TEXT(JSON) | 是 | 最优方案明细 |
| `profit_rate` | REAL | 是 | 利润率 |

---

## 7. 设计规范

### 7.1 代码规范
- TypeScript 严格类型；核心计算函数必须纯函数化。
- 下注方向显示统一规则：`胜=主胜`、`平=平`、`负=客胜`。
- 二串一赔率展示格式统一：`a*b=total`。

### 7.2 文本与编码规范
- 统一 UTF-8（无 BOM）提交。
- 变更前后执行 `node tools/check-text-integrity.mjs`。
- CI 强制门禁：`check:text -> lint -> build`。

### 7.3 安全规范
- 写接口统一认证 + 管理员授权。
- 写接口同源校验，降低 CSRF 风险。
- 禁止默认弱口令。

---

## 8. 变更记录

| 版本 | 日期 | 变更内容 | 涉及模块 |
|---|---|---|---|
| v1.8.0 | 2026-03-30 | 重写项目文档，清理乱码；新增 CI 质量门禁；持续优化二串一收益口径与展示一致性 | M04/M06/M07 |
| v1.7.x | 2026-03-29 | 统一胜平负展示、修复多处乱码、补充文本完整性检查脚本 | M02/M04/M06 |
| v1.6.x | 2026-03-29 | 安全修复（权限、口令、来源校验）与全流程 QA | M01/M05 |

---

## 9. 已知问题 & TODO

- [ ] 前后端赔率/方向解析仍有重复实现，需继续收敛到 `src/shared/oddsText.ts` 单点。
- [ ] 二串一算法继续优化，确保仅在 9 种展示场景总利润均为正时推荐。
- [ ] 历史页面与文案残留编码污染需继续清理。

---

## 10. 测试清单

| 编号 | 测试项 | 类型 | 预期 | 状态 |
|---|---|---|---|---|
| T01 | 文本完整性检查 | 规范检查 | 无乱码/非法替换字符 | 🔧 待复测 |
| T02 | TypeScript 检查 | 构建检查 | `npm run lint` 通过 | 🔧 待复测 |
| T03 | 前端构建 | 构建检查 | `npm run build` 通过 | 🔧 待复测 |
| T04 | 比赛列表倒计时 | 功能测试 | 正常每秒递减并到点更新 | 🔧 待复测 |
| T05 | 用户管理表格适配 | UI测试 | 无需横向滚动可看到核心操作 | 🔧 待复测 |
| T06 | 二串一 9 宫格收益 | 算法测试 | 展示口径与收益计算一致 | 🔧 待复测 |

---

## 11. 文档同步检查

- [x] 功能模块状态已更新
- [x] 文件结构已更新
- [x] 关键流程链路已更新
- [x] 接口摘要已更新
- [x] 数据模型摘要已更新
- [x] 变更记录已更新
- [x] TODO 已更新
- [x] 测试清单已更新
- [x] 最后更新时间已刷新
