/* 给痛苦一个名字 · 账号与支付（前端）
 * 账号态由服务端 Cookie 维持，权益来自 /api/me。
 * 免费功能不依赖这里，加载失败时按未登录处理。
 */
window.Auth = (function () {
  const state = {
    loaded: false,
    degraded: false,
    user: null,
    plan: { unlocked: false, aiUsed: 0, aiLimit: 30 },
    csrfToken: ''
  };

  function request(url, options) {
    const opts = Object.assign({ credentials: 'same-origin' }, options || {});
    const method = (opts.method || 'GET').toUpperCase();
    opts.headers = Object.assign({}, opts.headers || {});
    if (method !== 'GET' && state.csrfToken) {
      opts.headers['X-CSRF-Token'] = state.csrfToken;
    }
    return fetch(url, opts).then(function (res) {
      return res.text().then(function (text) {
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (err) { data = null; }
        if (!res.ok) {
          const err = new Error((data && data.error) || 'http_' + res.status);
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  function apply(me) {
    state.loaded = true;
    state.degraded = !!me.degraded;
    state.user = me.user || null;
    state.plan = me.plan || { unlocked: false, aiUsed: 0, aiLimit: 30 };
    state.csrfToken = me.csrfToken || '';
    return state;
  }

  function loadMe() {
    return request('/api/me')
      .then(apply)
      .catch(function () {
        state.loaded = true;
        state.degraded = true;
        return state;
      });
  }

  function login(next) {
    const target = next || (location.pathname + location.search);
    location.href = '/api/auth/alipay/start?next=' + encodeURIComponent(target);
  }

  function logout() {
    return request('/api/auth/logout', { method: 'POST' })
      .catch(function () { /* 已失效时也按登出处理 */ })
      .then(function () {
        state.user = null;
        state.plan = { unlocked: false, aiUsed: 0, aiLimit: 30 };
        state.csrfToken = '';
        return state;
      });
  }

  function createOrder() {
    return request('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product: 'growth_unlock' })
    });
  }

  function orderStatus(outTradeNo) {
    return request('/api/orders/' + encodeURIComponent(outTradeNo));
  }

  function practices(conceptId) {
    return request('/api/practices?conceptId=' + encodeURIComponent(conceptId));
  }

  return {
    loadMe: loadMe,
    login: login,
    logout: logout,
    createOrder: createOrder,
    orderStatus: orderStatus,
    practices: practices,
    state: function () { return state; },
    user: function () { return state.user; },
    plan: function () { return state.plan; },
    unlocked: function () { return !!(state.plan && state.plan.unlocked); },
    degraded: function () { return !!state.degraded; },
    loaded: function () { return !!state.loaded; }
  };
})();
