# 📋 项目文档 - AFK 套利系统

> 创建时间：2026-03-01  
> 最后更新：2026-04-22 18:05  
> 版本号：v1.8.64  
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
| M03 | 单场 | 单场套利计算、详情弹窗、收益分析 | 🔧 开发中 | `src/server/arbitrageEngine.ts`, `src/components/SinglePlanDetailContent.tsx` |
| M04 | 二串一 | 二串一推荐、详情弹窗、二阶段收益分析 | 🔧 开发中 | `src/server/arbitrageEngine.ts`, `src/components/ParlayPlanDetailContent.tsx` |
| M05 | HG 对冲 | 皇冠胜平负 + 皇冠让球对冲推荐与验算 | 🔧 开发中 | `src/server/arbitrageEngine.ts`, `src/components/GoalHedgePlanDetailContent.tsx` |
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
│   │   ├── SinglePlanDetailContent.tsx
│   │   ├── ParlayPlanDetailContent.tsx
│   │   └── GoalHedgePlanDetailContent.tsx
│   ├── server/
│   │   ├── crawler.ts
│   │   ├── arbitrageEngine.ts
│   │   └── arbitrageSelfCheck.ts
│   └── shared/
│       └── oddsText.ts
└── tools/
    └── check-text-integrity.mjs
```

---

## 4. 功能流程链路

### 4.1 抓取与重算
`定时/手动触发 -> 抓取比赛与赔率 -> 入库 -> 扫描套利机会 -> 主控展示`

- **输入**：抓取配置、账号配置、阈值设置
- **输出**：比赛列表、单场/二串一/HG 推荐
- **异常处理**：抓取失败保留旧数据并记录健康趋势

### 4.2 方案查看
`主控点击查看方案 -> 打开弹窗 -> 加载详情 -> 展示下注矩阵与收益分析`

- **输入**：机会 ID、当前返水/占比/赔率校准参数
- **输出**：下注建议、实投金额、中奖覆盖、利润
- **异常处理**：弹窗加载态 + 错误提示

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
| `/api/matches/refresh-status` | GET | 获取同步状态与倒计时 |
| `/api/arbitrage/opportunities` | GET | 获取单场或 HG 机会（按 `base_type`） |
| `/api/arbitrage/parlay-opportunities` | GET | 获取二串一机会 |
| `/api/arbitrage/parlay-opportunities/:id` | GET | 获取二串一详情 |
| `/api/arbitrage/calculate` | POST | 单场/HG 验算 |
| `/api/arbitrage/rescan` | POST | 手动重新扫描 |
| `/api/settings` | GET/POST | 读取/保存系统设置 |
| `/api/settings/hga/test-login` | POST | 测试 HGA 登录 |
| `/api/settings/hga/alias-groups` | GET/POST | 读取/保存 HGA 映射 |
| `/api/settings/hga/alias/export` | GET | 导出别名映射 |
| `/api/settings/hga/alias/import` | POST | 导入别名映射 |

---

## 6. 数据模型设计（摘要）

### 6.1 `matches`
- 关键字段：`match_id`, `league`, `home_team`, `away_team`, `match_time`, `status`

### 6.2 `jingcai_odds`
- 关键字段：`win_odds`, `draw_odds`, `lose_odds`, `handicap_win/draw/lose`

### 6.3 `crown_odds`
- 关键字段：`win_odds`, `draw_odds`, `lose_odds`, `handicap_lines`, `goal_lines`, `ou_lines`

### 6.4 `arbitrage_opportunities` / `parlay_opportunities`
- 关键字段：`base_type`, `best_strategy`, `profit`, `profit_rate`, `match_ids`

### 6.5 `system_settings`
- 关键字段：`hga_enabled`, `hga_username`, `hga_password`, `hga_team_alias_map`, `hga_team_alias_table_rows`, `hga_team_alias_auto_apply_threshold`

---

## 7. 设计规范

### 7.1 代码规范
- 统一 TypeScript 类型定义，减少隐式 `any`
- 服务端接口统一返回结构
- 异常信息可读并可追踪

### 7.2 UI/UX 规范
- 下注意向：橙底白字
- 中奖覆盖：淡绿色底
- 利润率：统一红色
- 操作按钮：蓝底白字

### 7.3 安全规范
- 管理员接口必须鉴权
- 敏感配置不得在普通用户接口回显
- 参数统一进行类型与范围校验

---

## 8. 变更记录

| 版本 | 日期 | 变更内容 | 涉及模块 |
|---|---|---|---|
| v1.8.64 | 2026-04-22 | 修复 `PROJECT_DOC.md` 与 `PRODUCT.md` 文档乱码，重建 UTF-8 中文文档 | M07 |

---

## 9. 已知问题 & TODO

- [ ] HG 对冲方案推荐与弹窗高亮继续做一致性回归
- [ ] 比赛列表复杂赔率列继续优化可读性
- [ ] 文案与乱码检查加入提交前强校验

---

## 10. 测试清单

| 测试编号 | 测试项 | 所属模块 | 测试类型 | 预期结果 | 实际结果 | 状态 |
|---|---|---|---|---|---|---|
| T01 | 数据抓取与入库 | M02 | 集成 | 抓取成功并入库 | 待执行 | ⬜ |
| T02 | 单场方案验算 | M03 | 流程 | 三种赛果利润口径正确 | 待执行 | ⬜ |
| T03 | 二串一方案验算 | M04 | 流程 | 两阶段收益逻辑正确 | 待执行 | ⬜ |
| T04 | HG 对冲验算 | M05 | 流程 | 胜平负覆盖无负利润死角 | 待执行 | ⬜ |
| T05 | HGA 别名映射导入导出 | M06 | 集成 | 导入导出一致可回显 | 待执行 | ⬜ |
| T06 | 文案乱码守卫 | M07 | 规范 | 无乱码、术语一致 | 待执行 | ⬜ |

> 状态说明：⬜ 未测试 | ✅ 通过 | ❌ 失败 | ⏭️ 跳过
