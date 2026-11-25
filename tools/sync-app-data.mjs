#!/usr/bin/env node
/**
 * 网页版与小程序的「概念库 / 识别引擎」双向同步
 *
 * 用法：
 *   node tools/sync-app-data.mjs            自动：内容不同时以修改时间更新的一侧为准
 *   node tools/sync-app-data.mjs --to-web   小程序 -> 网页
 *   node tools/sync-app-data.mjs --to-mini  网页 -> 小程序
 *   node tools/sync-app-data.mjs --status   只检查，不写入
 *
 * 说明：
 *   - 概念库不再参与同步：assets/js/data.js 与 miniapp/data/concepts.js 均由
 *     data/concepts.json 生成，改动请走 tools/build-data.mjs。
 *   - 引擎的差异只有模块包装：网页用 window.Engine，小程序用 module.exports，
 *     脚本只替换包装，正文逐字节同步。
 *   - 两侧内容一致时不会写入文件，也不会改动修改时间。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PAIRS = [
  {
    name: '识别引擎',
    web: 'assets/js/engine.js',
    mini: 'miniapp/utils/engine.js',
    toWeb: [
      ['module.exports = (function () {', 'window.Engine = (function () {'],
      ["const D = require('../data/concepts.js');", 'const D = window.PAIN_DATA;']
    ],
    toMini: [
      ['window.Engine = (function () {', 'module.exports = (function () {'],
      ['const D = window.PAIN_DATA;', "const D = require('../data/concepts.js');"]
    ]
  }
];

const args = process.argv.slice(2);
let mode = 'auto';
if (args.includes('--to-web')) mode = 'web';
else if (args.includes('--to-mini')) mode = 'mini';
else if (args.includes('--status')) mode = 'status';
else if (args.includes('--help') || args.includes('-h')) mode = 'help';

if (mode === 'help') {
  console.log('用法：');
  console.log('  node tools/sync-app-data.mjs            自动同步（以较新的一侧为准）');
  console.log('  node tools/sync-app-data.mjs --to-web   小程序 -> 网页');
  console.log('  node tools/sync-app-data.mjs --to-mini  网页 -> 小程序');
  console.log('  node tools/sync-app-data.mjs --status   只检查');
  process.exit(0);
}

function abs(rel) {
  return path.join(ROOT, rel);
}

function read(rel) {
  return fs.readFileSync(abs(rel), 'utf8');
}

function write(rel, text) {
  fs.writeFileSync(abs(rel), text, 'utf8');
}

function backup(rel) {
  const copy = abs(rel) + '.bak';
  fs.copyFileSync(abs(rel), copy);
  return rel + '.bak';
}

function hash(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);
}

function stamp(rel) {
  const stat = fs.statSync(abs(rel));
  const d = stat.mtime;
  const pad = (v) => (v < 10 ? '0' + v : String(v));
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function convert(text, rules, label) {
  let out = text;
  rules.forEach(([from, to]) => {
    if (out.indexOf(from) === -1) {
      throw new Error(label + '：未找到转换标记「' + from + '」，请确认文件结构没有被改动');
    }
    out = out.replace(from, to);
  });
  return out;
}

function sameContent(a, b) {
  return a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');
}

let failed = false;
let changed = 0;

console.log('');
console.log('  网页 ↔ 小程序 数据同步');
console.log('  ------------------------------------');

PAIRS.forEach((pair) => {
  if (!fs.existsSync(abs(pair.web)) || !fs.existsSync(abs(pair.mini))) {
    console.log('');
    console.log('  [' + pair.name + '] 缺少文件');
    console.log('    网页：' + pair.web);
    console.log('    小程序：' + pair.mini);
    failed = true;
    return;
  }

  const webText = read(pair.web);
  const miniText = read(pair.mini);
  const normalized = convert(miniText, pair.toWeb, pair.name);

  console.log('');
  console.log('  [' + pair.name + ']');
  console.log('    网页   ' + pair.web.padEnd(28) + stamp(pair.web) + '  ' + hash(webText));
  console.log('    小程序 ' + pair.mini.padEnd(28) + stamp(pair.mini) + '  ' + hash(miniText));

  if (sameContent(webText, normalized)) {
    console.log('    状态：一致，无需写入');
    return;
  }

  if (mode === 'status') {
    console.log('    状态：内容不一致（仅检查，未写入）');
    failed = true;
    return;
  }

  let direction = mode;
  if (mode === 'auto') {
    const webTime = fs.statSync(abs(pair.web)).mtimeMs;
    const miniTime = fs.statSync(abs(pair.mini)).mtimeMs;
    if (Math.abs(webTime - miniTime) < 1500) {
      console.log('    状态：内容不一致，且两侧修改时间过近，无法判断方向');
      console.log('    请显式执行 --to-web 或 --to-mini');
      failed = true;
      return;
    }
    direction = miniTime > webTime ? 'web' : 'mini';
    console.log('    判定：' + (direction === 'web' ? '小程序较新' : '网页较新'));
  }

  if (direction === 'web') {
    const bak = backup(pair.web);
    write(pair.web, normalized);
    const check = convert(read(pair.mini), pair.toWeb, pair.name);
    if (!sameContent(read(pair.web), check)) {
      console.log('    失败：写入后校验不一致');
      failed = true;
      return;
    }
    console.log('    已同步：小程序 -> 网页（原文件备份为 ' + bak + '）');
    changed++;
  } else {
    const bak = backup(pair.mini);
    const miniTarget = convert(webText, pair.toMini, pair.name);
    write(pair.mini, miniTarget);
    if (!sameContent(read(pair.mini), miniTarget)) {
      console.log('    失败：写入后校验不一致');
      failed = true;
      return;
    }
    console.log('    已同步：网页 -> 小程序（原文件备份为 ' + bak + '）');
    changed++;
  }
});

console.log('');
console.log('  ------------------------------------');
console.log('  完成：' + (changed ? '更新 ' + changed + ' 组文件' : '没有需要写入的改动'));
console.log('');

if (failed) process.exit(1);
