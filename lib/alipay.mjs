/* 给痛苦一个名字 · 支付宝开放平台（RSA2）
 *
 * 只实现本项目用到的能力：网页支付下单、异步通知验签、交易查询、退款、
 * 授权登录换 user_id。签名全部用 node:crypto，不依赖支付宝 SDK。
 */
import crypto from 'node:crypto';

let cfg = {
  env: 'sandbox',
  gateway: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
  authUrl: 'https://openauth-sandbox.dl.alipaydev.com/oauth2/publicAppAuthorize.htm',
  appId: '',
  privateKey: '',
  publicKey: '',
  sellerId: '',
  notifyUrl: '',
  baseUrl: ''
};

export function configure(input) {
  cfg = Object.assign({}, cfg, input || {});
}

function looksRealKey(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text || text.indexOf('粘贴') > -1) return false;
  if (text.indexOf('BEGIN') > -1) return true;
  // 允许裸 base64 密钥（沙箱配置就是这种格式），由 normalizePrivate/normalizePublic 补头尾
  return text.length > 100 && /^[A-Za-z0-9+/=\s]+$/.test(text);
}

export function isConfigured() {
  // 模板占位符不算已配置，避免带假密钥启动后报难懂的签名错误
  return /^\d{10,}$/.test(String(cfg.appId || '')) &&
    looksRealKey(cfg.privateKey) &&
    looksRealKey(cfg.publicKey);
}

export function configSummary() {
  return { env: cfg.env, appId: cfg.appId ? cfg.appId.slice(0, 6) + '***' : '', configured: isConfigured() };
}

/* ---------------- 签名 ---------------- */

function normalizePrivate(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (text.indexOf('BEGIN') > -1) return text.replace(/\\n/g, '\n');
  const body = text.replace(/\s+/g, '').replace(/(.{64})/g, '$1\n');
  return '-----BEGIN PRIVATE KEY-----\n' + body + '\n-----END PRIVATE KEY-----\n';
}

function normalizePublic(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (text.indexOf('BEGIN') > -1) return text.replace(/\\n/g, '\n');
  const body = text.replace(/\s+/g, '').replace(/(.{64})/g, '$1\n');
  return '-----BEGIN PUBLIC KEY-----\n' + body + '\n-----END PUBLIC KEY-----\n';
}

function signString(params) {
  return Object.keys(params)
    .filter(function (k) {
      return k !== 'sign' && k !== 'sign_type' && params[k] !== undefined && params[k] !== null && params[k] !== '';
    })
    .sort()
    .map(function (k) { return k + '=' + params[k]; })
    .join('&');
}

export function signParams(params, privateKey) {
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signString(params), 'utf8');
  return signer.sign(normalizePrivate(privateKey || cfg.privateKey), 'base64');
}

export function verifySign(params, publicKey) {
  if (!params || !params.sign) return false;
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(signString(params), 'utf8');
  try {
    return verifier.verify(normalizePublic(publicKey || cfg.publicKey), params.sign, 'base64');
  } catch (err) {
    return false;
  }
}

/* ---------------- 请求 ---------------- */

function timestamp() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function baseParams(method) {
  return {
    app_id: cfg.appId,
    method: method,
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: timestamp(),
    version: '1.0'
  };
}

async function callApi(method, bizContent, extra) {
  if (!isConfigured()) throw new Error('alipay_not_configured');
  const params = baseParams(method);
  if (bizContent) params.biz_content = JSON.stringify(bizContent);
  Object.assign(params, extra || {});
  params.sign = signParams(params, cfg.privateKey);

  const res = await fetch(cfg.gateway, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(15000)
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error('alipay_bad_response');
  }
  const key = method.replace(/\./g, '_') + '_response';
  const node = data[key] || data.error_response;
  if (!node) throw new Error('alipay_no_response');
  if (node.code && node.code !== '10000') {
    const err = new Error(node.sub_msg || node.msg || 'alipay_error');
    err.code = node.code;
    throw err;
  }
  return node;
}

/* ---------------- 登录 ---------------- */

export function buildAuthUrl(state, redirectUri) {
  const target = cfg.authUrl;
  const params = {
    app_id: cfg.appId,
    scope: 'auth_user',
    redirect_uri: redirectUri,
    state: state
  };
  return target + '?' + new URLSearchParams(params).toString();
}

export async function exchangeAuthCode(code) {
  return callApi('alipay.system.oauth.token', null, {
    grant_type: 'authorization_code',
    code: code
  });
}

export async function getUserInfo(accessToken) {
  return callApi('alipay.user.info.share', null, { auth_token: accessToken });
}

/* ---------------- 支付 ---------------- */

export function buildPagePayUrl(order) {
  if (!isConfigured()) throw new Error('alipay_not_configured');
  const params = baseParams('alipay.trade.page.pay');
  params.biz_content = JSON.stringify({
    out_trade_no: order.outTradeNo,
    total_amount: (order.amountCents / 100).toFixed(2),
    subject: order.subject,
    product_code: 'FAST_INSTANT_TRADE_PAY'
  });
  if (order.notifyUrl || cfg.notifyUrl) params.notify_url = order.notifyUrl || cfg.notifyUrl;
  if (order.returnUrl) params.return_url = order.returnUrl;
  params.sign = signParams(params, cfg.privateKey);
  return cfg.gateway + '?' + new URLSearchParams(params).toString();
}

export async function queryTrade(outTradeNo) {
  return callApi('alipay.trade.query', { out_trade_no: outTradeNo });
}

export async function refund(outTradeNo, amountCents, outRequestNo, reason) {
  return callApi('alipay.trade.refund', {
    out_trade_no: outTradeNo,
    refund_amount: (amountCents / 100).toFixed(2),
    out_request_no: outRequestNo,
    refund_reason: reason || '用户申请退款'
  });
}

export function parseNotify(rawBody) {
  const params = {};
  new URLSearchParams(rawBody).forEach(function (value, key) {
    params[key] = value;
  });
  return params;
}

/**
 * 校验异步通知：验签 + app_id + 金额 + 交易状态。
 * 返回 { ok, reason }，调用方据此决定是否结算。
 */
export function checkNotify(params, expected) {
  if (!params || !params.sign) return { ok: false, reason: 'no_sign' };
  if (!verifySign(params)) return { ok: false, reason: 'bad_sign' };
  if (cfg.appId && params.app_id && params.app_id !== cfg.appId) {
    return { ok: false, reason: 'app_id_mismatch' };
  }
  if (cfg.sellerId && params.seller_id && params.seller_id !== cfg.sellerId) {
    return { ok: false, reason: 'seller_mismatch' };
  }
  const status = params.trade_status;
  if (status !== 'TRADE_SUCCESS' && status !== 'TRADE_FINISHED') {
    return { ok: false, reason: 'not_paid' };
  }
  if (expected && expected.outTradeNo && params.out_trade_no !== expected.outTradeNo) {
    return { ok: false, reason: 'trade_no_mismatch' };
  }
  if (expected && typeof expected.amountCents === 'number') {
    const paidCents = Math.round(Number(params.total_amount) * 100);
    if (!isFinite(paidCents) || paidCents !== expected.amountCents) {
      return { ok: false, reason: 'amount_mismatch' };
    }
  }
  return { ok: true, reason: 'ok' };
}
