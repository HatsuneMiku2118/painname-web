/* 给痛苦一个名字 · 会话与鉴权
 *
 * 会话落库，Cookie 只存随机 token 的明文，库内存 sha256。
 * CSRF token 由 session id 与 SESSION_SECRET 派生，无需额外字段。
 */
import crypto from 'node:crypto';
import * as db from './db.mjs';
import { parseCookies, serializeCookie, sendJSON } from './http.mjs';

const SESSION_COOKIE = 'pn_sid';
const STATE_COOKIE = 'pn_state';
const SESSION_DAYS = 30;

let secret = 'dev-secret-change-me';

export function configure(input) {
  if (input && input.secret) secret = input.secret;
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

export function csrfFor(sessionId) {
  return crypto.createHmac('sha256', secret).update('csrf:' + sessionId).digest('hex').slice(0, 32);
}

export function sessionCookie(token) {
  return serializeCookie(SESSION_COOKIE, token, {
    maxAge: SESSION_DAYS * 24 * 3600,
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === '1' || process.env.COOKIE_SECURE === 'true',
    sameSite: 'Lax'
  });
}

export function clearSessionCookie() {
  return serializeCookie(SESSION_COOKIE, '', { maxAge: 0, httpOnly: true, secure: process.env.COOKIE_SECURE === '1' });
}

export function stateCookie(state) {
  return serializeCookie(STATE_COOKIE, state, { maxAge: 600, httpOnly: true, secure: process.env.COOKIE_SECURE === '1' });
}

export function readState(req) {
  return parseCookies(req)[STATE_COOKIE] || '';
}

/**
 * 新建会话，返回需要写入响应的 Set-Cookie 与 csrf token。
 */
export async function issueSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const id = sha256(token);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000);
  await db.createSession(id, userId, expiresAt);
  return { token: token, sessionId: id, cookie: sessionCookie(token), csrfToken: csrfFor(id) };
}

/**
 * 读取当前请求的会话；数据库不可用或未登录返回 null。
 */
export async function readSession(req) {
  if (!db.isReady()) return null;
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  try {
    const row = await db.getSession(sha256(token));
    if (!row) return null;
    return {
      sessionId: row.session_id,
      user: {
        id: row.id,
        alipayUserId: row.alipay_user_id,
        nickname: row.nickname,
        avatar: row.avatar
      },
      csrfToken: csrfFor(row.session_id)
    };
  } catch (err) {
    return null;
  }
}

/**
 * 需要登录的接口：未登录时直接写 401 并返回 null。
 */
export async function requireUser(req, res) {
  const session = await readSession(req);
  if (!session) {
    sendJSON(res, 401, { ok: false, error: 'AUTH_REQUIRED' });
    return null;
  }
  return session;
}

export function verifyCsrf(req, session) {
  if (!session) return false;
  const token = req.headers['x-csrf-token'] || '';
  const expected = session.csrfToken;
  if (!token || token.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

export async function rateLimit(bucket, limit, windowSeconds) {
  if (!db.isReady()) return true;
  try {
    return await db.hitRateLimit(bucket, limit, windowSeconds);
  } catch (err) {
    return true;
  }
}

export function safeNext(value) {
  const next = String(value || '');
  if (!next || next.charAt(0) !== '/' || next.charAt(1) === '/') return '/';
  return next;
}
