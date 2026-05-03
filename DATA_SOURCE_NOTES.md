# 数据抓取链路说明（Sporttery + 500 + HGA + 365rich 备选）

> 更新时间：2026-05-01
> 适用项目：`D:\afk`

## 1. 总体原则
- 主客队名以 Sporttery 为准，补丁源只补赔率，不覆盖入库队名。
- 同步遵循“变更才覆盖”；无变化返回 `unchanged`。
- 任一补丁源失败都不阻断主链路。
- 皇冠字段当轮无效时保持为空，前端显示 `-`，避免误导套利算法。

## 2. HGA 关闭时的抓取顺序
1. **Sporttery 主源**
- 来源：
  - `https://webapi.sporttery.cn/...poolCode=had`
  - `https://webapi.sporttery.cn/...poolCode=hhad`
  - `https://webapi.sporttery.cn/...poolCode=ttg`
- 产出：
  - 基础信息：赛事、比赛时间、主队、客队、让球
  - 竞彩赔率：胜平负、让球胜平负
  - 总进球：`0球 ~ 7+球`

2. **live.500 皇冠胜平负**
- 来源：
  - `https://live.500.com/zqdc.php`
  - `https://live.500.com/`（当 zqdc 存在缺口时才触发）
- 产出：`c_w/c_d/c_l`

3. **trade.500 皇冠让球兜底**
- 来源：`https://trade.500.com/jczq/`
- 产出：`c_h`（仅作为基础层兜底）

4. **trade.500 总进球兜底**
- 来源：`https://trade.500.com/jczq/?playid=270&g=2&date=YYYY-MM-DD`
- 触发条件：Sporttery TTG 请求失败、返回空映射或总进球命中率不足。
- 产出：`c_goal`（`0球..7+球`）。
- 约束：只补缺失场次，不覆盖已有有效 Sporttery TTG；`playid=269` 主要用于胜平负/让球胜平负，不作为总进球核心源。

5. **odds.500 皇冠盘口增强（优先于 trade.500）**
- 来源：
  - `https://odds.500.com/yazhi_jczq.shtml`
  - `https://odds.500.com/daxiao_jczq.shtml`
- 产出：
  - `yazhi_jczq` -> 皇冠让球即时盘口（主/客水位 + 盘口线）-> `c_h`
  - `daxiao_jczq` -> 皇冠大小球即时盘口（大/小水位 + 盘口线）-> `c_ou`
- 优先级：odds.500 命中时优先覆盖对应盘口；trade.500 仅补空。

6. **365rich 备选（仅补空 OU）**
- 来源：
  - 列表：`https://m.365rich.cn/Schedule.htm`
  - 详情：`/overunder/{id}.htm`
- 触发条件：仅当该场 `c_ou` 为空时触发。
- 约束：只补 `c_ou`，不改 `c_h`，不改队名。

## 3. HGA 开启时的抓取顺序
先完整执行“第 2 节基础链路”，再执行 HGA：

7. **HGA 覆盖增强**
- HGA 匹配成功场次：
  - `c_h` 以 HGA 覆盖
  - `c_ou` 以 HGA 覆盖
- HGA 未命中/失败场次：
  - 保留前面 500 + odds.500 + 365rich 结果
  - 不清空整场数据
- HGA 锁定/密码错误/超时：
  - 仍按现有降级策略继续返回基础链路结果

## 4. 匹配与入库口径
- 统一优先键：`match_id = date|round`
- 兜底键：比赛时间 + 归一化主客队名
- 盘口字段：
  - `c_h`：数组结构 `[{ type, home_odds, away_odds }]`
  - `c_goal`：数组结构 `[{ label, odds }]`，标签固定为 `0球..7+球`
  - `c_ou`：数组结构 `[{ line, over_odds, under_odds }]`
  - 无有效值写空数组，前端显示 `-`

## 5. 关键日志口径
- `odds500 yazhi matched x/y`
- `odds500 daxiao matched x/y`
- `trade.500 JQS goal odds fallback matched x/y`
- `rich365 ou fallback matched x/y`
- `hga override ch/cou matched x/y`

`scrape_health_logs.note` 会附带来源摘要，便于后台快速判断本轮哪层生效。
