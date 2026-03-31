import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const base = 'http://127.0.0.1:3001';
const outDir = 'D:/afk/.gstack/qa-reports/screenshots/user-arb-check';
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

const createdUser = `qa_user_${Date.now().toString().slice(-6)}`;
const createdPass = 'QAtest123!';
const result = { ok: false, createdUser, rows: 0, detailUrl: null, reason: null };

async function login(user, pass){
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  const inputs = page.locator('input');
  await inputs.nth(0).fill(user);
  await inputs.nth(1).fill(pass);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForTimeout(1300);
}

try {
  await login('admin','admin123');
  await page.goto(`${base}/admin/users`, { waitUntil: 'networkidle' });

  await page.locator('.ant-btn-primary').first().click();
  await page.waitForTimeout(300);

  const dialog = page.getByRole('dialog').first();
  if (!(await dialog.count())) throw new Error('新增用户弹窗未打开');

  const dInputs = dialog.locator('input');
  await dInputs.nth(0).fill(createdUser);
  await dInputs.nth(1).fill(createdPass);
  await dialog.locator('button[type="submit"]').first().click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(outDir, 'create-user.png'), fullPage: true });

  await page.request.post(`${base}/api/auth/logout`);

  await login(createdUser, createdPass);
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(outDir, 'user-dashboard.png'), fullPage: true });

  const calcLink = page.locator('a[href*="/calculator/"]');
  const linkCount = await calcLink.count();
  result.rows = await page.locator('table tbody tr').count();
  if (linkCount < 1) throw new Error('普通用户未找到方案详情入口');

  await calcLink.first().click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(700);
  result.detailUrl = page.url();
  await page.screenshot({ path: path.join(outDir, 'user-detail.png'), fullPage: true });

  if (!result.detailUrl.includes('/calculator/')) {
    throw new Error(`详情跳转失败，当前URL: ${result.detailUrl}`);
  }

  result.ok = true;
} catch (e) {
  result.reason = String(e?.message || e);
}

await context.close();
await browser.close();
fs.writeFileSync('D:/afk/.gstack/qa-reports/user-arb-check.json', JSON.stringify(result, null, 2), 'utf-8');
console.log(JSON.stringify(result, null, 2));
