import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const base = 'http://127.0.0.1:3001';
const outDir = 'D:/afk/.gstack/qa-reports/screenshots/fullflow';
fs.mkdirSync(outDir, { recursive: true });

const result = {
  startedAt: new Date().toISOString(),
  steps: [],
  issues: [],
  consoleErrors: [],
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

page.on('console', (msg) => {
  if (msg.type() === 'error') {
    result.consoleErrors.push({ url: page.url(), text: msg.text() });
  }
});

async function snap(name) {
  const p = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: p, fullPage: true });
  return p;
}

async function step(name, fn) {
  try {
    const data = await fn();
    result.steps.push({ name, ok: true, data });
  } catch (e) {
    result.steps.push({ name, ok: false, error: String(e?.message || e) });
    result.issues.push({ severity: 'high', title: `流程失败: ${name}`, detail: String(e?.message || e) });
  }
}

async function goto(url, shotName) {
  await page.goto(url, { waitUntil: 'networkidle' });
  await snap(shotName);
}

await step('admin login', async () => {
  await goto(`${base}/login`, '01-login');
  await page.getByPlaceholder('用户名').fill('admin');
  await page.getByPlaceholder('密码').fill('admin123');
  await page.getByRole('button', { name: '登 录' }).click();
  await page.waitForTimeout(1200);
  await snap('02-dashboard-after-login');
  if (!page.url().startsWith(`${base}/`)) throw new Error(`登录后URL异常: ${page.url()}`);
  return { url: page.url() };
});

await step('dashboard rescan', async () => {
  const btn = page.getByRole('button', { name: /重新扫描/ });
  if (await btn.count()) {
    await btn.first().click();
    await page.waitForTimeout(1600);
  }
  await snap('03-dashboard-rescan');
  return { clicked: true };
});

await step('matches page', async () => {
  await goto(`${base}/matches`, '04-matches');
  if (!(await page.content()).includes('比赛列表')) {
    throw new Error('比赛列表页面未渲染');
  }
  return { ok: true };
});

await step('calculator page', async () => {
  await goto(`${base}/`, '05-dashboard-for-calculator');
  const link = page.getByRole('link', { name: '查看方案' }).first();
  if (await link.count()) {
    await link.click();
    await page.waitForLoadState('networkidle');
    await snap('06-calculator');
  } else {
    result.issues.push({ severity: 'medium', title: '无可点击的查看方案入口', detail: '仪表盘未找到查看方案链接' });
  }
  return { url: page.url() };
});

await step('settings save', async () => {
  await goto(`${base}/settings`, '07-settings');
  const saveBtn = page.getByRole('button', { name: /保存设置/ });
  if (await saveBtn.count()) {
    await saveBtn.click();
    await page.waitForTimeout(800);
  }
  await snap('08-settings-after-save');
  return { saved: true };
});

let createdUser = `qa_flow_${Date.now().toString().slice(-6)}`;
await step('admin create user', async () => {
  await goto(`${base}/admin/users`, '09-admin-users');
  await page.getByRole('button', { name: '新增用户' }).click();
  await page.waitForTimeout(300);
  const dialog = page.getByRole('dialog').first();
  if (!(await dialog.count())) throw new Error('新增用户弹窗未打开');
  await dialog.getByLabel('用户名').fill(createdUser);
  await dialog.getByLabel('密码').fill('QAtest123!');
  await dialog.getByRole('button', { name: '提 交' }).click();
  await page.waitForTimeout(1000);
  await snap('10-admin-users-after-create');
  if (!(await page.content()).includes(createdUser)) throw new Error('新用户创建后未出现在列表');
  return { createdUser };
});

await step('admin self-delete blocked ui', async () => {
  await goto(`${base}/admin/users`, '11-admin-users-self-delete-check');
  const adminRow = page.locator('tr', { hasText: 'admin' }).first();
  const delBtn = adminRow.getByRole('button', { name: '删除' });
  const disabled = await delBtn.isDisabled();
  if (!disabled) throw new Error('admin 删除按钮未禁用');
  return { disabled };
});

await step('logout admin', async () => {
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await snap('12-login-again');
  return { ok: true };
});

await step('user login', async () => {
  await page.getByPlaceholder('用户名').fill(createdUser);
  await page.getByPlaceholder('密码').fill('QAtest123!');
  await page.getByRole('button', { name: '登 录' }).click();
  await page.waitForTimeout(1200);
  await snap('13-user-dashboard');
  return { url: page.url() };
});

await step('user cannot access admin route', async () => {
  await goto(`${base}/admin/users`, '14-user-hit-admin-route');
  const url = page.url();
  // 前端应重定向到首页
  if (url.includes('/admin/users')) {
    // 若没重定向，也应没有用户管理标题
    if ((await page.content()).includes('用户管理')) {
      throw new Error('普通用户仍可访问用户管理页面');
    }
  }
  return { url };
});

await step('user pages smoke', async () => {
  await goto(`${base}/`, '15-user-home');
  await goto(`${base}/matches`, '16-user-matches');
  await goto(`${base}/settings`, '17-user-settings');
  return { ok: true };
});

result.finishedAt = new Date().toISOString();
result.consoleErrors = result.consoleErrors.filter((e) => !e.text.includes('Download the React DevTools'));

const reportPath = 'D:/afk/.gstack/qa-reports/fullflow-result.json';
fs.writeFileSync(reportPath, JSON.stringify(result, null, 2), 'utf-8');

await context.close();
await browser.close();

console.log(reportPath);
console.log(JSON.stringify({ steps: result.steps.length, failed: result.steps.filter(s => !s.ok).length, issues: result.issues.length, consoleErrors: result.consoleErrors.length }, null, 2));
