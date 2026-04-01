import { chromium } from 'playwright';
import fs from 'fs';

const base='http://localhost:3001';
const outPath='D:/afk/qa-artifacts/full-qa-report.json';
const report={startedAt:new Date().toISOString(),base,checks:[],failures:[]};
const ok=(n,d={})=>report.checks.push({name:n,ok:true,...d});
const fail=(n,e,d={})=>{const i={name:n,ok:false,error:String(e),...d};report.checks.push(i);report.failures.push(i);};

async function reqWithRetry(doReq, times=3){
  let lastErr;
  for(let i=0;i<times;i++){
    try{return await doReq();}catch(e){lastErr=e; await new Promise(r=>setTimeout(r,1500));}
  }
  throw lastErr;
}

const browser=await chromium.launch({headless:true});
const context=await browser.newContext();
const page=await context.newPage();
page.setDefaultTimeout(120000);

try{
  const lr=await reqWithRetry(()=>page.request.post(base+'/api/auth/login',{data:{username:'admin',password:'Qa123456!'},timeout:120000}),3);
  if(!lr.ok()) throw new Error('登录失败:'+lr.status());
  ok('登录');

  for (const [name,path] of [['主控面板','/'],['比赛列表','/matches'],['系统设置','/settings'],['用户管理','/admin/users']]){
    try{
      const res=await page.goto(base+path,{waitUntil:'domcontentloaded',timeout:120000});
      await page.waitForTimeout(800);
      const title=await page.title();
      if(!res || !res.ok()) throw new Error('HTTP '+(res?res.status():'null'));
      if(!title) throw new Error('title empty');
      ok(`页面:${name}`,{status:res.status(),title});
    }catch(e){ fail(`页面:${name}`,e,{path}); }
  }

  const apis=['/api/auth/me','/api/matches','/api/arbitrage/opportunities?base_type=jingcai','/api/arbitrage/parlay-opportunities?base_type=jingcai','/api/history','/api/settings','/api/admin/users','/api/matches/refresh-status'];
  for(const u of apis){ const r=await reqWithRetry(()=>page.request.get(base+u,{timeout:120000}),2); if(r.ok()) ok(`接口:${u}`,{status:r.status()}); else fail(`接口:${u}`,'HTTP '+r.status()); }

  try{
    const matches=await (await reqWithRetry(()=>page.request.get(base+'/api/matches',{timeout:120000}),2)).json();
    const m=Array.isArray(matches)&&matches.length?matches[0]:null;
    if(!m) throw new Error('no match');
    const calc=await reqWithRetry(()=>page.request.post(base+'/api/arbitrage/calculate',{data:{match_id:m.match_id,jingcai_side:'W',jingcai_market:'nspf',jingcai_amount:10000,base_type:'jingcai',integer_unit:10000},timeout:120000}),2);
    if(calc.ok()) ok('单场计算接口',{status:calc.status()}); else fail('单场计算接口','HTTP '+calc.status());
  }catch(e){ fail('单场计算接口',e); }

  try{
    const create=await reqWithRetry(()=>page.request.post(base+'/api/admin/users',{data:{username:'qa_auto_'+Date.now().toString().slice(-6),password:'Qa123456!',role:'User',package_name:'基础套餐',expires_at:new Date(Date.now()+7*86400000).toISOString(),status:'normal',max_duration:0},timeout:120000}),2);
    const cj=await create.json().catch(()=>({}));
    const createdId=cj.id;
    const del=createdId?await reqWithRetry(()=>page.request.delete(base+'/api/admin/users/'+createdId,{timeout:120000}),2):null;
    if(create.status()===200 && del && del.status()===200) ok('用户增删'); else fail('用户增删',JSON.stringify({create:create.status(),createdId,del:del?del.status():null}));
  }catch(e){ fail('用户增删',e); }

  try{
    const create=await reqWithRetry(()=>page.request.post(base+'/api/matches',{data:{league:'QA联赛',round:'R1',handicap:'0',jc_handicap:'0',home_team:'QA主队'+Date.now().toString().slice(-4),away_team:'QA客队',match_time:'2026-04-01 23:59:00',j_w:2.1,j_d:3.2,j_l:3.6,j_hw:2.8,j_hd:3.4,j_hl:2.2,c_w:2.0,c_d:3.1,c_l:3.5,c_h:[]},timeout:120000}),2);
    const cj=await create.json();
    const del=await reqWithRetry(()=>page.request.delete(base+'/api/matches/'+cj.match_id,{timeout:120000}),2);
    if(create.status()===200 && del.status()===200) ok('手动比赛增删'); else fail('手动比赛增删',JSON.stringify({create:create.status(),del:del.status(),matchId:cj.match_id}));
  }catch(e){ fail('手动比赛增删',e); }

  try{
    const g=await reqWithRetry(()=>page.request.get(base+'/api/settings',{timeout:120000}),2);
    const s=await g.json();
    const p=await reqWithRetry(()=>page.request.post(base+'/api/settings',{data:{...s,sound_alert:!!s.sound_alert},timeout:120000}),2);
    if(p.status()===200) ok('设置保存'); else fail('设置保存','HTTP '+p.status());
  }catch(e){ fail('设置保存',e); }

  report.endedAt=new Date().toISOString();
  report.pass=report.failures.length===0;
  fs.writeFileSync(outPath,JSON.stringify(report,null,2));
  console.log(JSON.stringify({pass:report.pass,total:report.checks.length,failed:report.failures.length,report:outPath},null,2));
}finally{ await context.close(); await browser.close(); }
