/* 给痛苦一个名字 · 模型调用层（可选）
 * 通过服务端代理 /api/report 调用模型：概念内容由服务端按 id 从 data/concepts.json 读取，
 * 前端只提交用户描述与所选概念 id，不再把整个概念库塞进请求。
 * 代理未启动、未配置 Key 或模型不稳定时，调用方会回退到本地规则生成的报告。
 */
window.AI = (function () {
  const E = window.Engine;

  const TIMEOUT = 45000;
  let info = { checked: false, configured: false, model: '' };

  function postJSON(url, payload, timeout) {
    const controller = new AbortController();
    const timer = window.setTimeout(function () { controller.abort(); }, timeout || TIMEOUT);
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    }).then(function (res) {
      return res.text().then(function (text) {
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch (err) {
          data = null;
        }
        if (!res.ok || !data) {
          const detail = data && data.error ? data.error : 'http_' + res.status;
          throw new Error(detail);
        }
        return data;
      });
    }).finally(function () { window.clearTimeout(timer); });
  }

  function answersPayload(record) {
    return (record.answers || []).map(function (a) {
      if (typeof a === 'string') return { text: a };
      return { key: a.key, text: a.text, skipped: !!a.skipped };
    });
  }

  /**
   * 生成理解报告。
   * 成功时返回补全后的报告对象；失败时抛出异常，由调用方回退到本地报告。
   */
  function report(record, depth, originsText) {
    const base = E.buildReport(record, depth, originsText);
    const conceptId = record && record.primary ? record.primary.conceptId : '';
    if (!conceptId) return Promise.resolve(base);

    const payload = {
      conceptId: conceptId,
      raw: record.raw || '',
      answers: answersPayload(record),
      profile: record.profile || {},
      depth: depth || 'present',
      originsText: originsText || ''
    };

    return postJSON('/api/report', payload).then(function (data) {
      if (!data.ok || !data.report) throw new Error('bad_report');
      const r = data.report;

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

  /**
   * 识别：服务端检索候选概念后由模型排序，必要时返回 1–2 个追加追问。
   * 失败时抛出异常，由调用方回退到本地规则候选。
   */
  function identify(payload) {
    return postJSON('/api/identify', payload, 30000).then(function (data) {
      return {
        candidates: Array.isArray(data.candidates) ? data.candidates : [],
        followUps: Array.isArray(data.followUps) ? data.followUps : [],
        confidence: data.confidence || '有限',
        note: data.note || '',
        meta: data.meta || null
      };
    });
  }

  function check() {
    const controller = new AbortController();
    const timer = window.setTimeout(function () { controller.abort(); }, 2500);
    return fetch('/api/health', { signal: controller.signal })
      .then(function (res) { return res.json(); })
      .then(function (json) {
        info = { checked: true, configured: !!json.configured, model: json.model || '' };
        return info;
      })
      .catch(function () {
        info = { checked: true, configured: false, model: '' };
        return info;
      })
      .finally(function () { window.clearTimeout(timer); });
  }

  return {
    check: check,
    identify: identify,
    report: report,
    available: function () { return info.configured; },
    state: function () { return info; }
  };
})();
