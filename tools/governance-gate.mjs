#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const failures = [];

function run(cmd, args, title) {
  const r = spawnSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', cwd: root });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.status !== 0) {
    failures.push(`❌ ${title}\n${out || '(no output)'}`);
  } else {
    console.log(`✅ ${title}`);
  }
}

console.log('== Governance Gate ==');
run('node', ['tools/check-text-integrity.mjs', '.', '--strict-terms'], '核心术语一致性检查');
run('node', ['tools/check-text-integrity.mjs', 'src', '--deep'], '前端源码文本完整性检查');
run('node', ['tools/check-text-integrity.mjs', 'server.ts'], '服务端源码文本完整性检查');
run('node', ['tools/check-text-integrity.mjs', 'tools'], '工具脚本文本完整性检查');
run('node', ['node_modules/typescript/bin/tsc', '--noEmit'], 'TypeScript 静态检查');

if (failures.length > 0) {
  console.error('\n== Gate Failed ==');
  for (const f of failures) console.error(`\n${f}`);
  process.exit(1);
}

console.log('\n✅ All governance gates passed.');
