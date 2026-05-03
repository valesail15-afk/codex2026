# 📋 项目文档 - AFK 套利系统

> 创建时间：2026-03-01
> 最后更新：2026-05-02 16:00
> 版本号：v1.8.99
> 当前阶段：开发中

---

## 1. 项目概述
- **项目名称**：AFK 套利系统
- **项目描述**：聚合竞彩与皇冠赔率，提供单场、二串一、HG 对冲三类套利方案，支持抓取、验算、展示与运维配置。
- **技术栈**：React + Vite + TypeScript + Ant Design + Express + SQLite
- **运行环境**：Node.js 22+

---

## 2. 功能模块目录

| 模块编号 | 模块名称 | 功能描述 | 状态 | 负责文件 |
|---|---|---|---|---|
| M01 | 认证与用户 | 登录、权限、会话管理 | ✅ 已完成 | `server.ts`, `src/server/auth.ts`, `src/pages/UserManagement.tsx` |
| M02 | 比赛与赔率 | 比赛列表、赔率展示、抓取同步 | 🔧 开发中 | `server.ts`, `src/pages/MatchList.tsx`, `src/server/crawler.ts` |
| M03 | 单场 | 单场套利计算、详情弹窗、收益分析、投注计算 | 🔧 开发中 | `src/server/arbitrageEngine.ts`, `src/components/SinglePlanDetailContent.tsx` |
| M04 | 二串一 | 二串一推荐、详情弹窗、二阶段收益分析、投注计算 | 🔧 开发中 | `src/server/arbitrageEngine.ts`, `src/components/ParlayPlanDetailContent.tsx` |
| M05 | HG 对冲 | 皇冠胜平负 + 皇冠让球/总进球对冲推荐、验算与投注计算 | 🔧 开发中 | `src/server/arbitrageEngine.ts`, `src/components/HgPlanDetailContent.tsx`, `src/components/GoalHedgePlanDetailContent.tsx` |
| M06 | 系统设置 | 套利参数、HGA 配置、别名映射维护 | 🔧 开发中 | `src/pages/Settings.tsx`, `src/pages/HgaTeamAliasSettings.tsx`, `server.ts` |
| M07 | 文案与质量守卫 | 文案一致性、乱码检测、质量门禁 | 🔧 开发中 | `tools/check-text-integrity.mjs`, `.github/workflows/quality-gate.yml` |

---

## 3. 文件目录结构

```text
D:/afk/
├── server.ts
├── PROJECT_DOC.md
├── PRODUCT.md
├── RULES.md
├── config/
│   └── hga-team-alias-map.json
├── src/
│   ├── pages/
│   │   ├── Dashboard.tsx
│   │   ├── MatchList.tsx
│   │   ├── Settings.tsx
│   │   └── HgaTeamAliasSettings.tsx
│   ├── components/
│   │   ├── BetStakeCalculatorModal.tsx
│   │   ├── SinglePlanDetailContent.tsx
│   │   ├── ParlayPlanDetailContent.tsx
│   │   ├── HgPlanDetailContent.tsx
│   │   └── GoalHedgePlanDetailContent.tsx
│   ├── server/
│   │   ├── crawler.ts
│   │   ├── arbitrageEngine.ts
│   │   └── arbitrageSelfCheck.ts
│   └── shared/
│       ├── strategyScale.ts
│       └── oddsText.ts
└── tools/
    └── check-text-integrity.mjs
```

---

## 4. 功能流程链路

### 4.1 抓取与重算
`定时/手动触发 -> 抓取比赛与赔率 -> 快照质量保护 -> 事务入库 -> 先计算后事务替换套利机会 -> 主控展示`

- **输入**：抓取配置、账号配置、阈值设置
- **输出**：比赛列表、单场/二串一/HG 推荐
- **异常处理**：抓取失败、空快照、明显不完整快照保留旧数据并记录健康趋势；机会扫描计算失败时不清空旧机会

### 4.2 方案查看
`主控点击查看方案 -> 打开弹窗 -> 加载详情 -> 展示下注矩阵与收益分析 -> 点击投注计算 -> 选择投注金额/实际投入金额口径 -> 按主投注平台占比换算主投注金额 -> 等比例刷新各平台投注金额、占比、实际投入与收益数据`

- **输入**：机会 ID、当前返水/占比/赔率校准参数、用户输入的投注金额或实际投入金额
- **输出**：下注建议、投注金额、平台占比、实际投入金额、中奖覆盖、利润、等比例缩放后的投注方案
- **异常处理**：弹窗加载态 + 错误提示；投注金额必须为大于 0 的数字

### 4.3 HGA 别名映射维护
`进入系统设置 -> 打开编辑 -> 调整映射 -> 保存 -> 匹配生效`

- **输入**：Trade500/HGA 队名、扩展列、自动加入阈值
- **输出**：映射数据、建议列表
- **异常处理**：重复名冲突拦截、导入格式校验

---

## 5. API / 接口设计（核心）

| 接口路径 | 方法 | 描述 |
|---|---|---|
| `/api/matches` | GET | 获取比赛列表 |
| `/api/health` | GET | 公开健康检查 |
| `/api/matches/refresh-status` | GET | 获取同步状态与倒计时 |
| `/api/matches/unified-snapshot` | GET | 管理员生成多源统一只读快照 |
| `/api/arbitrage/opportunities` | GET | 获取单场或 HG 机会 |
| `/api/arbitrage/parlay-opportunities` | GET | 获取二串一机会 |
| `/api/arbitrage/parlay-opportunities/:id` | GET | 获取二串一详情 |
| `/api/arbitrage/calculate` | POST | 单场/HG 验算 |
| `/api/arbitrage/rescan` | POST | 手动重新扫描 |
| `/api/settings` | GET/POST | 读取/保存系统设置 |

---

## 6. 数据模型设计（摘要）

### 6.1 `matches`
- 关键字段：`match_id`, `league`, `home_team`, `away_team`, `match_time`, `status`

---

## 7. 设计规范

### 7.1 代码规范
- 统一 TypeScript 类型定义，减少隐式 `any`

---

## 8. 变更记录

| 版本 | 日期 | 变更内容 | 状态 |
|---|---|---|---|
| v1.8.88 | 2026-05-01 | 启动项目，验证运行状态 | ✅ 已完成 |
| v1.8.89 | 2026-05-01 | 安装 QA 依赖：gstack, superpowers | ✅ 已完成 |
| v1.8.90 | 2026-05-01 | 实现 500.com 总进球 (JQS) 兜底抓取逻辑，集成至抓取链路 | ✅ 已完成 |
| v1.8.91 | 2026-05-01 | 二串一模型重构：在 LP 线性规划中引入 "Stop" 分支，解决第一场未命中时的亏损漏洞 | ✅ 已完成 |
| v1.8.99 | 2026-05-02 | 实现弹窗状态持久化 (Superpowers Persistence)：通过 URL 参数记录 modal_type/id，支持页面刷新后自动恢复弹窗状态 | ✅ 已完成 |

---

## 9. TODO 清单
- [x] 启动项目并验证运行状态
- [x] 完善二串一模型算法，支持 "Stop" 逻辑
- [x] 实现二串一全量方案数据审计与回归验证
- [ ] 完善单场套利计算逻辑
- [ ] 优化 HGA 别名自动映射阈值
