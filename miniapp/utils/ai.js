/**
 * 小程序端模型调用层（可选）
 * 依赖 utils/config.js 中的 ai.enabled / baseUrl。
 * 服务端契约：POST {baseUrl}/api/report
 *   请求：{ conceptId, raw, answers, profile, depth, originsText }
 *   响应：{ ok, concept, report: { explanation, mechanism, cycle, links, summary, originsNote } }
 * 概念正文由服务端按 id 从概念库读取，小程序不再上传整份概念库。
 * 模型不可用、超时或返回结构不合格时，调用方应回退到 utils/engine.js。
 */
const E = require('./engine');
const config = require('./config');

const TIMEOUT = (config.ai && config.ai.timeout) || 30000;

function available() {
  return !!(config.ai && config.ai.enabled && config.ai.baseUrl);
}

function state() {
  return {
    configured: available(),
    model: (config.ai && config.ai.model) || ''
  };
}

function post(pathname, payload, timeout) {
  return new Promise(function (resolve, reject) {
    if (!available()) {
      reject(new Error('ai_disabled'));
      return;
    }
    let settled = false;
    const guard = setTimeout(function () {
      if (!settled) {
        settled = true;
        reject(new Error('timeout'));
      }
    }, (timeout || TIMEOUT) + 2000);

    my.request({
      url: config.ai.baseUrl.replace(/\/+$/, '') + pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      data: payload,
      timeout: timeout || TIMEOUT,
      dataType: 'json',
      success: function (res) {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        let body = res.data;
        if (typeof body === 'string') {
          try {
            body = JSON.parse(body);
          } catch (err) {
            reject(new Error('bad_body'));
            return;
          }
        }
        if (res.status < 200 || res.status >= 300 || !body || !body.ok) {
          reject(new Error((body && body.error) || ('status_' + res.status)));
          return;
        }
        resolve(body);
      },
      fail: function (err) {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        reject(err || new Error('request_failed'));
      }
    });
  });
}

function answersPayload(record) {
  return (record.answers || []).map(function (a) {
    if (typeof a === 'string') return { text: a };
    return { key: a.key, text: a.text, skipped: !!a.skipped };
  });
}

/**
 * 识别：服务端检索候选概念后由模型排序，必要时返回 1–2 个追加追问。
 * 失败时抛出异常，由调用方回退到本地规则候选。
 */
function identify(payload) {
  return post('/api/identify', payload, TIMEOUT).then(function (data) {
    return {
      candidates: Array.isArray(data.candidates) ? data.candidates : [],
      followUps: Array.isArray(data.followUps) ? data.followUps : [],
      confidence: data.confidence || '有限',
      note: data.note || '',
      meta: data.meta || null
    };
  });
}

/**
 * 生成理解报告；失败时抛出异常，由调用方回退到本地报告。
 */
function report(record, depth, originsText) {
  const base = E.buildReport(record, depth, originsText);
  const conceptId = record && record.primary ? record.primary.conceptId : '';
  if (!conceptId) return Promise.resolve(base);

  return post('/api/report', {
    conceptId: conceptId,
    raw: record.raw || '',
    answers: answersPayload(record),
    profile: record.profile || {},
    depth: depth || 'present',
    originsText: originsText || ''
  }, TIMEOUT).then(function (data) {
    const r = data.report || {};
    if (r.explanation && r.explanation.length) base.explain = r.explanation;
    if (r.mechanism && r.mechanism.length) base.mechanism = r.mechanism;
    if (r.cycle && r.cycle.length >= 2) base.cycle = r.cycle;
    if (r.summary) base.summary = r.summary;

    if (r.links && r.links.length) {
      base.links = r.links;
      base.hypotheses = base.links
        .filter(function (l) { return l.certainty !== 'fact'; })
        .map(function (l) { return l.interpretation; });
    }

    if (r.originsNote && depth !== 'present' && originsText && originsText.trim()) {
      base.origins.paragraph = r.originsNote;
    }

    base.aiUsed = true;
    base.conceptSource = data.concept || null;
    return base;
  });
}

module.exports = {
  available: available,
  state: state,
  identify: identify,
  report: report
};
