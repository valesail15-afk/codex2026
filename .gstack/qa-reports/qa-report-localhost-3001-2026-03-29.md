# QA 报告（Test -> Fix -> Verify）

- 测试时间：2026-03-29
- 目标地址：http://127.0.0.1:3001
- 测试范围：登录页、主控面板、比赛列表、系统设置、用户管理
- 模式：Standard（发现后直接修复并复测）

## 基线问题（修复前）

### ISSUE-001 [High] 管理员可删除自身账号
- 现象：用户管理中 admin 行的“删除”按钮可点击。
- 风险：误操作会导致管理员账号被删，系统管理能力丢失。
- 证据：`/D:/afk/.gstack/qa-reports/screenshots/page-admin-users.png`
- 修复：
  - 前端禁用当前管理员删除按钮。
  - 后端删除接口增加“禁止删除自己”的校验。
- 提交：`e611121`

### ISSUE-002 [Medium] 用户管理关键弹窗流程不可用（新增用户/日志）
- 现象：新增用户弹窗在页面交互中无法稳定打开，影响管理闭环。
- 证据（修复后可打开）：`/D:/afk/.gstack/qa-reports/screenshots/admin-add-user-modal-after-fix2.png`
- 修复：统一 Modal 参数与行为配置，恢复弹窗渲染与交互。
- 提交：`e611121`

### ISSUE-003 [Medium] 控制台存在错误级告警（Antd 过时 API）
- 现象：页面出现 `Space direction`、`Card bodyStyle`、`Tag bordered` 等错误级告警。
- 证据：
  - `/D:/afk/.gstack/qa-reports/screenshots/page-matches-actual.png`
  - `/D:/afk/.gstack/qa-reports/screenshots/page-settings.png`
- 修复：迁移到新 API（`orientation`、`styles.body`、`variant`）。
- 提交：`ddfef1a`

### ISSUE-004 [Medium] 登录页未登录时触发 `/api/auth/me` 401 控制台噪音
- 现象：打开登录页时出现 401 资源错误。
- 证据（修复前）：`/D:/afk/.gstack/qa-reports/screenshots/initial-login.png`
- 修复：登录页不做预拉取用户信息，避免无效鉴权请求。
- 提交：`ddfef1a`

## 复测结果（修复后）

- 登录页控制台错误：0
  - 证据：`/D:/afk/.gstack/qa-reports/screenshots/login-console-clean-after-fix.png`
- 主控面板控制台错误：0
- 比赛列表控制台错误：0
- 系统设置控制台错误：0
- 用户管理“新增用户”流程：可打开弹窗并成功创建用户
  - 证据：`/D:/afk/.gstack/qa-reports/screenshots/admin-user-create-after-fix.png`
- 管理员自删入口：UI 禁用 + 后端拒绝
  - 证据：`/D:/afk/.gstack/qa-reports/screenshots/admin-modal-after-fix.png`

## 健康度评分

- 修复前：74 / 100
- 修复后：93 / 100
- 变化：+19

## 本轮提交

- `e611121` fix(qa): clean console errors and deprecated antd API usage
- `ddfef1a` fix(qa): remove login-page auth noise and update antd usage
- `e0ac610` docs: sync QA findings and fixes in project doc

## 结论

核心后台管理链路和主要页面已通过本轮 QA，当前可进入下一轮功能回归或提测。
