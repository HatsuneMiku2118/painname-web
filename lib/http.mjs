/* 给痛苦一个名字 · HTTP 辅助（无第三方依赖）
 * 统一 JSON/文本响应、请求体读取、Cookie 解析与序列化、跳转。
 * 静态站点与接口共用，避免 server.mjs 重复实现。
 */
import { Buffer } from 'node:buffer';

export function sendJSON(res, code, data, headers) {
  const body = JSON.stringify(data);
  const head = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  };
  Object.assign(head, headers || {});
  res.writeHead(code, head);
  res.end(body);
}

export function sendText(res, code, text, headers) {
  const body = Buffer.from(String(text), 'utf8');
  const head = {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  };
  Object.assign(head, headers || {});
  res.writeHead(code, head);
  res.end(body);
}

export async function readBody(req, limit = 1_000_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  raw.split(';').forEach(function (pair) {
    const i = pair.indexOf('=');
    if (i <= 0) return;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    try {
      out[name] = decodeURIComponent(value);
    } catch (err) {
      out[name] = value;
    }
  });
  return out;
}

export function serializeCookie(name, value, opts) {
  const o = opts || {};
  let out = name + '=' + encodeURIComponent(value == null ? '' : value);
  if (o.maxAge !== undefined) out += '; Max-Age=' + Math.floor(o.maxAge);
  out += '; Path=' + (o.path || '/');
  if (o.httpOnly !== false) out += '; HttpOnly';
  if (o.secure) out += '; Secure';
  out += '; SameSite=' + (o.sameSite || 'Lax');
  return out;
}

export function redirect(res, location, cookies) {
  const headers = { Location: location, 'Cache-Control': 'no-store' };
  if (cookies && cookies.length) headers['Set-Cookie'] = cookies;
  res.writeHead(302, headers);
  res.end();
}
