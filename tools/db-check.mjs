#!/usr/bin/env node
/**
 * 数据库连通性检查：
 *   node tools/db-check.mjs
 * 连接串优先取 DATABASE_URL，其次项目根 db.url（两者都不进仓库）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from '../lib/db.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function local(name) {
  try {
    return fs.readFileSync(path.join(ROOT, name), 'utf8').trim();
  } catch (err) {
    return '';
  }
}

const url = process.env.DATABASE_URL || local('db.url');
if (!url) {
  console.error('缺少 DATABASE_URL 或项目根 db.url，暂按免费模式运行。');
  process.exit(1);
}

const ok = await db.init(url);
if (ok) {
  console.log('数据库连接成功，表结构已就绪：users / sessions / orders / entitlements / rate_limits');
  process.exit(0);
}
console.error('数据库连接失败：' + db.status().error);
process.exit(1);
