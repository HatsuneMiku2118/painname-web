/* 给痛苦一个名字 · 数据库层（PostgreSQL）
 *
 * 多实例部署下不能依赖本地文件，账号、会话、订单、权益全部落库。
 * 数据库不可用时由调用方降级为免费模式，不影响板块一、板块二。
 */
import pg from 'pg';

const { Pool } = pg;

const SCHEMA = [
  `create table if not exists users (
     id uuid primary key default gen_random_uuid(),
     alipay_user_id text unique not null,
     nickname text,
     avatar text,
     status text not null default 'active',
     created_at timestamptz not null default now(),
     last_login_at timestamptz
   )`,
  `create table if not exists sessions (
     id text primary key,
     user_id uuid not null references users(id) on delete cascade,
     created_at timestamptz not null default now(),
     expires_at timestamptz not null,
     revoked_at timestamptz,
     last_seen_at timestamptz
   )`,
  `create index if not exists sessions_expires_idx on sessions (expires_at)`,
  `create table if not exists orders (
     id uuid primary key default gen_random_uuid(),
     out_trade_no text unique not null,
     user_id uuid not null references users(id),
     product text not null,
     amount_cents integer not null,
     status text not null default 'created',
     alipay_trade_no text,
     paid_at timestamptz,
     raw_notify jsonb,
     created_at timestamptz not null default now(),
     updated_at timestamptz not null default now()
   )`,
  `create index if not exists orders_user_idx on orders (user_id, created_at desc)`,
  `create index if not exists orders_trade_idx on orders (alipay_trade_no)`,
  `create table if not exists entitlements (
     id uuid primary key default gen_random_uuid(),
     user_id uuid not null references users(id) on delete cascade,
     product text not null,
     source_order_id uuid references orders(id),
     ai_used integer not null default 0,
     granted_at timestamptz not null default now(),
     revoked_at timestamptz,
     unique (user_id, product)
   )`,
  `create table if not exists rate_limits (
     bucket text not null,
     window_start timestamptz not null,
     hits integer not null default 0,
     primary key (bucket, window_start)
   )`
];

let pool = null;
let ready = false;
let lastError = '';

export function isReady() {
  return ready;
}

export function status() {
  return { ready: ready, error: ready ? '' : lastError };
}

export async function init(url) {
  if (!url) {
    lastError = 'no_database_url';
    return false;
  }
  const ssl = /sslmode=(require|prefer|verify)/i.test(url) ? { rejectUnauthorized: false } : undefined;
  try {
    pool = new Pool({
      connectionString: url,
      max: 5,
      ssl: ssl,
      connectionTimeoutMillis: 8000,
      idleTimeoutMillis: 30000
    });
    pool.on('error', function (err) {
      lastError = String(err && err.message ? err.message : err).slice(0, 200);
    });
    const client = await pool.connect();
    try {
      await client.query('select 1');
      for (const sql of SCHEMA) await client.query(sql);
    } finally {
      client.release();
    }
    ready = true;
    lastError = '';
    return true;
  } catch (err) {
    ready = false;
    lastError = String(err && err.message ? err.message : err).slice(0, 200);
    if (pool) {
      try { await pool.end(); } catch (e) { /* ignore */ }
      pool = null;
    }
    return false;
  }
}

export function query(text, params) {
  if (!pool) return Promise.reject(new Error('db_unavailable'));
  return pool.query(text, params);
}

export async function tx(fn) {
  if (!pool) throw new Error('db_unavailable');
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    try { await client.query('rollback'); } catch (e) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

/* ---------------- 用户与会话 ---------------- */

export async function upsertUser(alipayUserId, nickname, avatar) {
  const { rows } = await query(
    `insert into users (alipay_user_id, nickname, avatar, last_login_at)
     values ($1, $2, $3, now())
     on conflict (alipay_user_id) do update
       set nickname = coalesce(excluded.nickname, users.nickname),
           avatar = coalesce(excluded.avatar, users.avatar),
           last_login_at = now()
     returning *`,
    [alipayUserId, nickname || null, avatar || null]
  );
  return rows[0];
}

export async function createSession(id, userId, expiresAt) {
  await query(
    'insert into sessions (id, user_id, expires_at) values ($1, $2, $3)',
    [id, userId, expiresAt]
  );
}

export async function getSession(id) {
  const { rows } = await query(
    `select s.id as session_id, s.expires_at, s.revoked_at, u.*
       from sessions s join users u on u.id = s.user_id
      where s.id = $1`,
    [id]
  );
  if (!rows.length) return null;
  const row = rows[0];
  if (row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

export async function touchSession(id) {
  await query('update sessions set last_seen_at = now() where id = $1', [id]);
}

export async function revokeSession(id) {
  await query('update sessions set revoked_at = now() where id = $1', [id]);
}

/* ---------------- 订单与权益 ---------------- */

export async function createOrder(outTradeNo, userId, product, amountCents) {
  const { rows } = await query(
    `insert into orders (out_trade_no, user_id, product, amount_cents)
     values ($1, $2, $3, $4) returning *`,
    [outTradeNo, userId, product, amountCents]
  );
  return rows[0];
}

export async function findOrder(outTradeNo) {
  const { rows } = await query('select * from orders where out_trade_no = $1', [outTradeNo]);
  return rows[0] || null;
}

/**
 * 幂等结算：notify 与主动查单都走这里。
 * 已结算的订单返回 newlyPaid=false，不会重复发权益。
 */
export async function settleOrder(outTradeNo, alipayTradeNo, rawNotify) {
  return tx(async function (client) {
    const found = await client.query('select * from orders where out_trade_no = $1 for update', [outTradeNo]);
    if (!found.rows.length) return { ok: false, reason: 'order_not_found' };
    const order = found.rows[0];
    if (order.status === 'paid') return { ok: true, order: order, newlyPaid: false };

    const updated = await client.query(
      `update orders
          set status = 'paid', alipay_trade_no = coalesce($2, alipay_trade_no),
              paid_at = now(), raw_notify = $3, updated_at = now()
        where id = $1 and status <> 'paid'
        returning *`,
      [order.id, alipayTradeNo || null, rawNotify || null]
    );
    if (!updated.rowCount) return { ok: true, order: order, newlyPaid: false };

    await client.query(
      `insert into entitlements (user_id, product, source_order_id)
       values ($1, $2, $3)
       on conflict (user_id, product) do nothing`,
      [order.user_id, order.product, order.id]
    );
    return { ok: true, order: updated.rows[0], newlyPaid: true };
  });
}

export async function getEntitlement(userId, product) {
  const { rows } = await query(
    'select * from entitlements where user_id = $1 and product = $2 and revoked_at is null',
    [userId, product]
  );
  return rows[0] || null;
}

export async function getPlan(userId, product, aiLimit) {
  const ent = await getEntitlement(userId, product);
  return {
    unlocked: !!ent,
    aiUsed: ent ? ent.ai_used : 0,
    aiLimit: aiLimit
  };
}

export async function revokeEntitlement(userId, product) {
  await query(
    'update entitlements set revoked_at = now() where user_id = $1 and product = $2 and revoked_at is null',
    [userId, product]
  );
}

/**
 * 原子扣减 AI 配额；未解锁或超限返回 null。
 */
export async function consumeAiQuota(userId, product, limit) {
  const { rows } = await query(
    `update entitlements
        set ai_used = ai_used + 1
      where user_id = $1 and product = $2 and revoked_at is null and ai_used < $3
      returning ai_used`,
    [userId, product, limit]
  );
  return rows.length ? rows[0].ai_used : null;
}

/* ---------------- 限流 ---------------- */

export async function hitRateLimit(bucket, limit, windowSeconds) {
  const { rows } = await query(
    `insert into rate_limits (bucket, window_start, hits)
     values ($1, to_timestamp(floor(extract(epoch from now()) / $2) * $2), 1)
     on conflict (bucket, window_start) do update set hits = rate_limits.hits + 1
     returning hits`,
    [bucket, windowSeconds]
  );
  return rows[0].hits <= limit;
}
