# 数据源抓取说明（Sporttery + 500 + HGA）
> 更新时间：2026-04-23  
> 适用项目：`D:\afk`

## 1. 总体原则
- 主客队名以 Sporttery 为唯一主权来源（落库不被补丁源覆盖）。
- 同步遵循“变更才覆盖”：数据无变化返回 `unchanged`。
- HGA/500 任一链路失败不应阻断主链路，按兜底规则继续。
- 失效数据不保留历史残留：本轮抓不到即写空，前端显示 `-`。

## 2. 第一层主源（Sporttery）
### 2.1 来源
- 胜平负（had）：`https://webapi.sporttery.cn/gateway/uniform/football/getMatchCalculatorV1.qry?channel=c&poolCode=had`
- 让球胜平负（hhad）：`https://webapi.sporttery.cn/gateway/uniform/football/getMatchCalculatorV1.qry?channel=c&poolCode=hhad`
- 总进球（ttg）：`https://webapi.sporttery.cn/gateway/uniform/football/getMatchCalculatorV1.qry?channel=c&poolCode=ttg`

### 2.2 字段映射
- `had.h/d/a` -> `j_w/j_d/j_l`
- `hhad.h/d/a` -> `j_hw/j_hd/j_hl`
- `hhad.goalLineValue`（兜底 `goalLine`）-> `jingcai_handicap`
- `ttg.s0..s7` -> `c_goal`（`0球` 到 `7+球`）

### 2.3 匹配规则
1. 严格：`match_id = {matchDate}|{matchNum}`
2. 兜底：同比赛日 + 归一化主客队 + 分钟级开赛时间

## 3. 第二层补强（500）
### 3.1 皇冠胜平负
- 主补强来源：`live.500.com`（按 `fid` 抓公司 280 欧赔）
- 匹配键优先级：
1. `match_id` 精确匹配
2. `round` 匹配
3. `日期 + HH:mm + 归一化主客队`（使用球队别名映射）

- 次补强来源（仅补空）：`trade.500 odds.xml`
  - `https://www.500.com/static/public/jczq/xml/odds/odds.xml`
  - `https://trade.500.com/static/public/jczq/xml/odds/odds.xml`
  - `https://ews.500.com/static/public/jczq/xml/odds/odds.xml`

### 3.2 皇冠让球
- HGA 失败/超时/锁定时，使用 `https://trade.500.com/jczq/` 兜底补让球（`c_h`）。

## 4. HGA 链路
### 4.1 开启时
- 抓皇冠胜平负、让球、全场大小球（OU）。
- OU 仅采集全场标签：
  - 盘口：`RATIO_OUO / RATIO_OUU`
  - 赔率：`IOR_OUC`（大）/ `IOR_OUH`（小）

### 4.2 异常时
- 账号锁定/密码错误会进入保护逻辑，避免高频重试。
- HGA 失败轮次不保留旧 OU 残留：`c_ou` 清空，前端显示 `-`。

## 5. 映射规则（球队别名）
- 映射完全用户可控：只读取用户配置，不自动混入默认映射。
- 映射用于跨源匹配（含 HGA、live.500 的队名归一化匹配）。
- 建议使用“同义名 -> 统一名”方式维护，避免一队多写法。

## 6. 写库口径（关键）
- `c_w/c_d/c_l`：本轮有效则写值，否则写 `0`（前端显示 `-`）。
- `c_h`：本轮抓到则写数组，否则写空数组。
- `c_ou`：本轮抓到则写数组，否则写空数组。
- 不再用历史旧值回填失效皇冠字段，避免套利误判。

## 7. 前端展示口径
- 数值 `<= 0` 或空数组均显示 `-`。
- 比赛列表显示“最新一批抓取数据”，不再死卡“今天写入”。

## 8. 排查顺序（建议）
1. 看 `scrape_health_logs`：本轮状态、`hga_status`、`note`。
2. 看抓取日志：各链路命中数（sporttery/live500/odds.xml/hga）。
3. 查库字段：`c_w/c_d/c_l`、`c_h`、`c_ou`、`c_goal`。
4. 最后核对 `/api/matches` 返回与页面渲染。
