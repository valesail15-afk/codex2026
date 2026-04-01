import { chromium } from 'playwright';

const base='http://43.255.156.54';
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1366,height:900}});
const page=await context.newPage();

await page.goto(base+'/login',{waitUntil:'networkidle'});
await page.getByPlaceholder('用户名').fill('admin');
await page.getByPlaceholder('密码').fill('admin123');
await page.getByRole('button',{name:'登 录'}).click();
await page.waitForTimeout(1800);

const finalUrl=page.url();
const hasDashboard = (await page.content()).includes('主控面板') || (await page.content()).includes('比赛列表');
const cookies = await context.cookies(base);
const token = cookies.find(c=>c.name==='token');

console.log(JSON.stringify({finalUrl,hasDashboard,hasToken:!!token,tokenSecure:token?.secure||false},null,2));

await context.close();
await browser.close();
