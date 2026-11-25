#!/usr/bin/env node
/**
 * 概念库构建：data/concepts.json（唯一数据源）→ 网页
 *
 * 用法：
 *   node tools/build-data.mjs            生成 assets/js/data.js
 *   node tools/build-data.mjs --check    只校验生成文件是否与 concepts.json 一致（不一致退出码 1）
 *   node tools/build-data.mjs --export   从现有 assets/js/data.js 反向导出 concepts.json（迁移用）
 *
 * 数据流：
 *   飞书多维表格（人工编辑 / 审核）
 *     → 导出 CSV → node tools/import-feishu.mjs
 *     → data/concepts.json
 *     → node tools/build-data.mjs
 *     → 网页
 *
 * 小程序代码已移到 miniapp 分支，不再参与构建。
 *
 * 说明：signals（关键词权重）、sources（文献）属于结构化字段，不通过多维表格维护，
 * 只保留在 concepts.json 中，导入脚本不会覆盖它们。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'data', 'concepts.json');
const WEB = path.join(ROOT, 'assets', 'js', 'data.js');

const WEB_BANNER = `/* 给痛苦一个名字 · 概念库
 * 本文件由 tools/build-data.mjs 自动生成，请不要直接编辑。
 * 编辑入口：飞书多维表格 → 导出 CSV → node tools/import-feishu.mjs
 */
window.PAIN_DATA = `;

const REVIEW_STATUS = ['pending_review', 'approved', 'rejected'];

function rel(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

function fail(message) {
  console.error('  [错误] ' + message);
  process.exit(1);
}

function loadSource() {
  if (!fs.existsSync(SOURCE)) fail('找不到 ' + rel(SOURCE) + '，可先执行 node tools/build-data.mjs --export');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
  } catch (err) {
    fail(rel(SOURCE) + ' 不是合法 JSON：' + err.message);
  }
  return data;
}

/* ---------- 校验 ---------- */

function validate(data) {
  const problems = [];
  if (!data || typeof data !== 'object') problems.push('根节点不是对象');
  if (!Array.isArray(data.concepts) || !data.concepts.length) problems.push('concepts 必须是非空数组');
  if (!data.chatQuestions || typeof data.chatQuestions !== 'object') problems.push('缺少 chatQuestions');

  const seen = new Set();
  (data.concepts || []).forEach((c, i) => {
    const at = 'concepts[' + i + ']' + (c && c.id ? '(' + c.id + ')' : '');
    if (!c || typeof c !== 'object') { problems.push(at + ' 不是对象'); return; }
    ['id', 'name', 'plain', 'definition', 'summary'].forEach((key) => {
      if (typeof c[key] !== 'string' || !c[key].trim()) problems.push(at + ' 缺少必填字段 ' + key);
    });
    if (c.id && seen.has(c.id)) problems.push(at + ' id 重复');
    if (c.id) seen.add(c.id);
    if (!Array.isArray(c.indicators) || !c.indicators.length) problems.push(at + ' indicators 必须是非空数组');
    if (!Array.isArray(c.signals) || !c.signals.length) problems.push(at + ' signals 必须是非空数组（决定能不能被匹配到）');
    if (!Array.isArray(c.sources) || !c.sources.length) problems.push(at + ' sources 必须是非空数组（概念必须可追溯来源）');
    if (c.review_status && REVIEW_STATUS.indexOf(c.review_status) === -1) {
      problems.push(at + ' review_status 只能是 ' + REVIEW_STATUS.join(' / '));
    }
    if (!Array.isArray(c.nearby)) problems.push(at + ' nearby 必须是数组');
    if (c.evidence !== undefined) {
      if (!Array.isArray(c.evidence) || !c.evidence.length) {
        problems.push(at + ' evidence 如果存在必须是非空数组');
      } else {
        c.evidence.forEach((e, j) => {
          const eat = at + ' evidence[' + j + ']';
          if (!e || typeof e !== 'object') { problems.push(eat + ' 不是对象'); return; }
          ['source', 'locator', 'claim', 'supports'].forEach((key) => {
            if (typeof e[key] !== 'string' || !e[key].trim()) problems.push(eat + ' 缺少必填字段 ' + key);
          });
          if (e.relation && ['supports', 'partial'].indexOf(e.relation) === -1) {
            problems.push(eat + ' relation 只能是 supports / partial');
          }
        });
      }
    }
  });

  // nearby 允许指向概念库外的邻近概念（只用于文案区分），这里只提示不阻断
  const allIds = new Set((data.concepts || []).map((c) => c && c.id).filter(Boolean));
  const warnings = [];
  (data.concepts || []).forEach((c) => {
    (c.nearby || []).forEach((n) => {
      if (n && n.id && !allIds.has(n.id)) {
        warnings.push('concepts(' + c.id + ') nearby 指向库外概念 ' + n.id + '（仅用于文案，可忽略）');
      }
    });
  });

  if (problems.length) {
    console.error('');
    console.error('  概念库校验未通过：');
    problems.forEach((p) => console.error('    · ' + p));
    console.error('');
    process.exit(1);
  }

  if (warnings.length) {
    warnings.forEach((w) => console.log('  提示：' + w));
  }
}

/* ---------- 生成 ---------- */

function json3(data) {
  return JSON.stringify(data, null, 2);
}

function buildWeb(data) {
  return WEB_BANNER + json3(data) + ';\n';
}

function normalizeEol(text) {
  return text.replace(/\r\n/g, '\n');
}

function report(data) {
  const counts = { approved: 0, pending_review: 0, rejected: 0, none: 0 };
  data.concepts.forEach((c) => {
    if (!c.review_status) counts.none += 1;
    else if (counts[c.review_status] !== undefined) counts[c.review_status] += 1;
  });
  console.log('  概念 ' + data.concepts.length + ' 条' +
    '｜已审核 ' + counts.approved +
    '｜待审核 ' + (counts.pending_review + counts.none) +
    (counts.rejected ? '｜已驳回 ' + counts.rejected : ''));
}

/* ---------- 反向导出（迁移用） ---------- */

function exportFromWeb() {
  if (!fs.existsSync(WEB)) fail('找不到 ' + rel(WEB));
  const sandbox = { window: {} };
  try {
    vm.runInNewContext(fs.readFileSync(WEB, 'utf8'), sandbox, { filename: rel(WEB) });
  } catch (err) {
    fail(rel(WEB) + ' 执行失败：' + err.message);
  }
  const data = sandbox.window.PAIN_DATA;
  if (!data || !Array.isArray(data.concepts)) fail(rel(WEB) + ' 没有导出 window.PAIN_DATA.concepts');

  data.concepts.forEach((c) => {
    if (!c.review_status) c.review_status = 'pending_review';
  });

  fs.mkdirSync(path.dirname(SOURCE), { recursive: true });
  fs.writeFileSync(SOURCE, json3(data) + '\n', 'utf8');
  console.log('');
  console.log('  已从 ' + rel(WEB) + ' 导出 → ' + rel(SOURCE));
  report(data);
  console.log('');
}

/* ---------- 主流程 ---------- */

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log('');
  console.log('  概念库构建');
  console.log('  ------------------------------------');
  console.log('  node tools/build-data.mjs            从 data/concepts.json 生成两端数据文件');
  console.log('  node tools/build-data.mjs --check    校验生成文件是否最新');
  console.log('  node tools/build-data.mjs --export   从现有 data.js 反向导出 concepts.json');
  console.log('');
  process.exit(0);
}

if (args.includes('--export')) {
  exportFromWeb();
  process.exit(0);
}

const data = loadSource();
validate(data);
report(data);

// 已驳回的条目不下发到网页
const rejected = data.concepts.filter((c) => c.review_status === 'rejected');
if (rejected.length) {
  console.log('  已排除驳回条目 ' + rejected.length + ' 条：' + rejected.map((c) => c.id).join('、'));
  data.concepts = data.concepts.filter((c) => c.review_status !== 'rejected');
}

const outputs = [
  { file: WEB, next: buildWeb(data) }
];

if (args.includes('--check')) {
  let stale = 0;
  outputs.forEach(({ file, next }) => {
    const current = fs.existsSync(file) ? normalizeEol(fs.readFileSync(file, 'utf8')) : '';
    if (current !== normalizeEol(next)) {
      stale += 1;
      console.log('  过期：' + rel(file) + '（请执行 node tools/build-data.mjs）');
    }
  });
  console.log(stale ? '' : '  生成文件均为最新');
  console.log('');
  process.exit(stale ? 1 : 0);
}

outputs.forEach(({ file, next }) => {
  const current = fs.existsSync(file) ? normalizeEol(fs.readFileSync(file, 'utf8')) : '';
  if (current === normalizeEol(next)) {
    console.log('  未变化：' + rel(file));
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next, 'utf8');
  console.log('  已生成：' + rel(file));
});

console.log('');
