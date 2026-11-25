#!/usr/bin/env node
/**
 * 飞书多维表格 → data/concepts.json
 *
 * 流程：
 *   1. 在飞书多维表格里编辑概念正文（名称、定义、解释等）并标记审核状态
 *   2. 导出为 CSV（UTF-8），放进 data/inbox/
 *   3. npm run sync:concepts
 *   4. 脚本合并进 data/concepts.json，并自动重新生成网页数据文件
 *
 * 用法：
 *   npm run sync:concepts                       导入 data/inbox 下最新的 CSV 并自动构建
 *   npm run sync:concepts -- concepts.csv       指定文件
 *   node tools/import-feishu.mjs concepts.csv --dry-run   只预览改动，不写入
 *   node tools/import-feishu.mjs --fields       打印建议的多维表格列
 *   node tools/import-feishu.mjs concepts.csv --data data/concepts.json  指定目标文件（测试用）
 *
 * 重要：只更新「正文类」字段。signals（关键词权重）、sources（文献）、
 * links、nearby、directions 属于结构化字段，始终以 concepts.json 为准，
 * 即使 CSV 里出现也不会被覆盖。
 * CSV 中留空的单元格表示「不修改」，不会被清空。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DATA = path.join(ROOT, 'data', 'concepts.json');
const INBOX = path.join(ROOT, 'data', 'inbox');

/* 未指定文件时，取 data/inbox 下最新的 CSV */
function pickInboxCsv() {
  if (!fs.existsSync(INBOX)) return '';
  const files = fs.readdirSync(INBOX)
    .filter((name) => name.toLowerCase().endsWith('.csv'))
    .map((name) => {
      const full = path.join(INBOX, name);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return files.length ? files[0].full : '';
}

/* CSV 列名 → 概念字段。同时接受中英文表头。 */
const COLUMNS = {
  id: ['id', 'ID', '概念ID', '概念 id'],
  name: ['名称', '概念名称', 'name'],
  plain: ['一句话', '一句话解释', 'plain'],
  discipline: ['学科', '领域', 'discipline'],
  definition: ['定义', 'definition'],
  indicators: ['典型表现', 'indicators'],
  explanation: ['解释要点', '解释', 'explanation'],
  mechanism: ['可能机制', '机制', 'mechanism'],
  cycle: ['循环', '典型循环', 'cycle'],
  applicable: ['适用', '适用情境', 'applicable'],
  nonApplicable: ['不适用', '不适用情境', 'nonApplicable'],
  limits: ['证据局限', '局限', 'limits'],
  summary: ['总结', 'summary'],
  review_status: ['审核状态', 'review_status']
};

/* 这些字段是列表形态，CSV 单元格内用换行或「；」分隔 */
const LIST_FIELDS = ['indicators', 'explanation', 'mechanism', 'cycle', 'applicable', 'nonApplicable'];

const REVIEW_MAP = {
  '待审核': 'pending_review',
  '已审核': 'approved',
  '审核通过': 'approved',
  '已驳回': 'rejected',
  '驳回': 'rejected',
  pending_review: 'pending_review',
  approved: 'approved',
  rejected: 'rejected'
};

const REQUIRED = ['id', 'name', 'plain', 'definition', 'summary'];

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const positional = args.filter((a) => !a.startsWith('--'));

function valueOf(flag) {
  const i = args.indexOf(flag);
  return i > -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : '';
}

if (flags.includes('--help') || flags.includes('-h')) {
  console.log('');
  console.log('  node tools/import-feishu.mjs concepts.csv [--dry-run] [--data <file>]');
  console.log('  node tools/import-feishu.mjs --fields');
  console.log('');
  process.exit(0);
}

if (flags.includes('--fields')) {
  const labels = {
    id: 'id',
    name: '名称',
    plain: '一句话',
    discipline: '学科',
    definition: '定义',
    indicators: '典型表现',
    explanation: '解释要点',
    mechanism: '可能机制',
    cycle: '循环',
    applicable: '适用情境',
    nonApplicable: '不适用情境',
    limits: '证据局限',
    summary: '总结',
    review_status: '审核状态'
  };
  console.log('');
  console.log('  在飞书多维表格中建这些列（顺序与线上表一致）：');
  console.log('');
  Object.keys(labels).forEach((key) => {
    const kind = key === 'id' ? '（单行文本，主键，不要改）'
      : key === 'review_status' ? '（单选，选项：待审核 / 已审核 / 已驳回）'
      : LIST_FIELDS.indexOf(key) > -1 ? '（多行文本，每行一条）'
      : '（单行文本）';
    console.log('    ' + labels[key].padEnd(8) + kind);
  });
  console.log('');
  console.log('  结构化字段（关键词权重、文献来源）不在表格里维护，留在 concepts.json。');
  console.log('');
  process.exit(0);
}

const csvPath = positional[0] || pickInboxCsv();
if (!csvPath) {
  console.error('  没有找到 CSV。');
  console.error('  把飞书导出的 CSV 放进 data/inbox/，再执行 npm run sync:concepts；');
  console.error('  或直接指定文件：node tools/import-feishu.mjs concepts.csv');
  process.exit(1);
}

const dataPath = path.resolve(ROOT, valueOf('--data') || DEFAULT_DATA);
const dryRun = flags.includes('--dry-run');

/* ---------- CSV 解析（支持引号、逗号、单元格内换行） ---------- */

function parseCSV(text) {
  const src = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim()));
}

function splitList(text) {
  return String(text)
    .split(/\r?\n|；|;/)
    .map((s) => s.trim().replace(/^[-·•]\s*/, ''))
    .filter(Boolean);
}

function resolveHeader(header) {
  const map = {};
  header.forEach((raw, index) => {
    const name = String(raw).trim();
    Object.keys(COLUMNS).forEach((key) => {
      if (map[key] === undefined && COLUMNS[key].indexOf(name) > -1) map[key] = index;
    });
  });
  return map;
}

/* ---------- 合并 ---------- */

function validate(data) {
  const problems = [];
  const ids = new Set();
  data.concepts.forEach((c, i) => {
    const at = 'concepts[' + i + '](' + (c.id || '?') + ')';
    REQUIRED.forEach((key) => {
      if (typeof c[key] !== 'string' || !c[key].trim()) problems.push(at + ' 缺少 ' + key);
    });
    if (ids.has(c.id)) problems.push(at + ' id 重复');
    ids.add(c.id);
    if (!Array.isArray(c.signals) || !c.signals.length) problems.push(at + ' signals 为空，将无法被匹配到');
    if (!Array.isArray(c.sources) || !c.sources.length) problems.push(at + ' sources 为空，概念必须可追溯来源');
    if (c.review_status && ['pending_review', 'approved', 'rejected'].indexOf(c.review_status) === -1) {
      problems.push(at + ' 审核状态非法：' + c.review_status);
    }
  });
  return problems;
}

const csvText = fs.readFileSync(csvPath, 'utf8');
const rows = parseCSV(csvText);
if (rows.length < 2) {
  console.error('  CSV 里没有数据行');
  process.exit(1);
}

const headerMap = resolveHeader(rows[0]);
if (headerMap.id === undefined) {
  console.error('  CSV 缺少 id 列（表头可以是 id / 概念ID）');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const index = new Map(data.concepts.map((c) => [c.id, c]));

const unknown = [];
const changed = [];

rows.slice(1).forEach((cells, rowIndex) => {
  const id = String(cells[headerMap.id] || '').trim();
  if (!id) return;
  const concept = index.get(id);
  if (!concept) { unknown.push(id); return; }

  const touched = [];
  Object.keys(COLUMNS).forEach((key) => {
    if (key === 'id' || headerMap[key] === undefined) return;
    const raw = String(cells[headerMap[key]] === undefined ? '' : cells[headerMap[key]]).trim();
    if (!raw) return; // 留空 = 不修改

    if (key === 'review_status') {
      const mapped = REVIEW_MAP[raw];
      if (!mapped) { unknown.push(id + '（审核状态「' + raw + '」无法识别）'); return; }
      if (concept.review_status !== mapped) { concept.review_status = mapped; touched.push(key); }
      return;
    }

    const next = LIST_FIELDS.indexOf(key) > -1 ? splitList(raw) : raw;
    const prev = concept[key];
    const same = Array.isArray(next)
      ? Array.isArray(prev) && prev.length === next.length && prev.every((v, i) => v === next[i])
      : prev === next;

    if (!same) {
      concept[key] = next;
      touched.push(key);
    }
  });

  if (touched.length) {
    changed.push('第 ' + (rowIndex + 2) + ' 行 ' + id + '：' + touched.join('、'));
  }
});

console.log('');
console.log('  CSV 数据行 ' + (rows.length - 1) + '｜命中概念 ' + changed.length + ' 条｜未识别 ' + unknown.length + ' 条');
changed.slice(0, 20).forEach((line) => console.log('    · ' + line));
if (changed.length > 20) console.log('    · …… 其余 ' + (changed.length - 20) + ' 条省略');
if (unknown.length) {
  unknown.slice(0, 10).forEach((line) => console.log('    ! 未处理：' + line));
  console.log('    新增概念需要在 concepts.json 里补 signals 与 sources，不能只靠表格创建。');
}

const problems = validate(data);
if (problems.length) {
  console.error('');
  console.error('  合并后校验未通过，未写入：');
  problems.forEach((p) => console.error('    · ' + p));
  console.error('');
  process.exit(1);
}

if (!changed.length) {
  console.log('');
  console.log('  没有需要写入的改动');
  console.log('');
  process.exit(0);
}

if (dryRun) {
  console.log('');
  console.log('  预览模式：未写入。去掉 --dry-run 执行实际导入。');
  console.log('');
  process.exit(0);
}

const backup = dataPath + '.bak';
fs.copyFileSync(dataPath, backup);
fs.writeFileSync(dataPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
console.log('');
console.log('  已写入 ' + path.relative(ROOT, dataPath).replace(/\\/g, '/') + '（原文件备份为 .bak）');

if (valueOf('--data')) {
  console.log('  指定了 --data，跳过自动构建。');
  console.log('');
  process.exit(0);
}

try {
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build-data.mjs')], { stdio: 'inherit' });
} catch (err) {
  console.error('  自动构建失败，请手动执行 node tools/build-data.mjs');
  process.exit(1);
}
