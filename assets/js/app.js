/* 给痛苦一个名字 · 交互与状态
 * 负责：三板块切换、对话式识别的渲染与状态机、候选卡、理解报告与行动建议。
 * 网络请求统一走 assets/js/ai.js；识别状态流转见 README「识别流程」。
 */
(function () {
  'use strict';

  const D = window.PAIN_DATA;
  const E = window.Engine;
  const AI = window.AI;
  const KEY = 'painname_v1';

  const State = {
    view: 'home',
    record: null,
    aiTalk: null,
    retry: null,
    failNext: false,
    forceNoMatch: false,
    identifyCancelled: false
  };

  const viewEl = document.getElementById('view');
  const stepperEl = document.getElementById('stepper');
  const modalRoot = document.getElementById('modalRoot');
  const liveEl = document.getElementById('live');
  const demoPanel = document.getElementById('demoPanel');
  const demoToggle = document.getElementById('demoToggle');
  const topbarEl = document.querySelector('.topbar');

  /* ---------------- 主题（深浅色） ----------------
     三态：auto（跟随系统）/ light / dark。
     CSS 侧只有一份 :root[data-theme="dark"] 令牌块，这里只负责把结果写进 <html>。
     首屏防闪烁由 index.html <head> 里的引导脚本完成（先于样式表求值）。 */

  const THEME_KEY = 'painname-theme';
  const THEME_META = { light: '#F8F3ED', dark: '#16130F' };
  const THEME_ICON = { auto: '◐', light: '☀', dark: '☾' };
  const THEME_NAME = { auto: '跟随系统', light: '浅色', dark: '深色' };
  const THEME_ORDER = ['auto', 'light', 'dark'];

  const Theme = {
    mode: 'auto',
    resolved: 'light',

    init: function () {
      let mode = 'auto';
      try { mode = localStorage.getItem(THEME_KEY) || 'auto'; } catch (err) { mode = 'auto'; }
      if (THEME_ORDER.indexOf(mode) === -1) mode = 'auto';
      this.mode = mode;
      this.sync();

      // 跟随系统时，系统主题变化要实时跟着变
      const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
      if (mq) {
        const onChange = function () { if (Theme.mode === 'auto') Theme.sync(); };
        if (mq.addEventListener) mq.addEventListener('change', onChange);
        else if (mq.addListener) mq.addListener(onChange);
      }
    },

    sync: function () {
      const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
      this.resolved = this.mode === 'auto' ? (mq && mq.matches ? 'dark' : 'light') : this.mode;
      const root = document.documentElement;
      root.setAttribute('data-theme', this.resolved);
      root.setAttribute('data-theme-mode', this.mode);
      const meta = document.getElementById('themeColor');
      if (meta) meta.setAttribute('content', THEME_META[this.resolved]);
      this.render();
    },

    cycle: function () {
      const i = THEME_ORDER.indexOf(this.mode);
      this.mode = THEME_ORDER[(i + 1) % THEME_ORDER.length];
      try { localStorage.setItem(THEME_KEY, this.mode); } catch (err) { /* 隐私模式降级为内存态 */ }
      this.sync();
      announce('主题：' + THEME_NAME[this.mode]);
    },

    render: function () {
      const btn = document.getElementById('themeBtn');
      if (!btn) return;
      const icon = document.getElementById('themeIcon');
      if (icon) icon.textContent = THEME_ICON[this.mode];
      const label = '主题：' + THEME_NAME[this.mode];
      btn.setAttribute('title', label);
      btn.setAttribute('aria-label', label + '，点击切换');
    }
  };

  // 演示面板是 QA 工具，正式站点默认不出现，避免浮动控件压住正文。
  // 需要时用 ?demo=1 打开；本地开发始终可用。
  const DEMO_ENABLED = /(^|[?&])demo=1(&|$)/.test(location.search) ||
    ['localhost', '127.0.0.1', '[::1]'].indexOf(location.hostname) !== -1;
  if (!DEMO_ENABLED && demoToggle) {
    demoToggle.hidden = true;
    if (demoPanel) demoPanel.hidden = true;
  }

  const CHIPS = [
    { label: '恋爱中的不安', text: '他几个小时没有回我消息，我一直看手机，担心他其实没那么在乎我。' },
    { label: '暧昧中的不确定', text: '我们暧昧了三个月，他从来不明确说我们算什么。我每天都在猜他的意思，又不敢问。' },
    { label: '分手后的不舍', text: '分手两周了，我还是会反复想起以前的细节，不知道自己现在想要什么。' },
    { label: '关系中的自我怀疑', text: '每次他不高兴，我都在想是不是我太敏感、要求太多。我不敢提自己的需要。' }
  ];

  /* ---------------- 工具 ---------------- */

  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function clip(text, n) { return E.clip(text, n); }

  function fmt(ts) {
    const d = new Date(ts);
    const pad = function (v) { return v < 10 ? '0' + v : String(v); };
    return pad(d.getMonth() + 1) + '月' + pad(d.getDate()) + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function announce(text) {
    liveEl.textContent = '';
    window.setTimeout(function () { liveEl.textContent = text; }, 40);
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        record: State.record,
        updatedAt: Date.now()
      }));
    } catch (err) { /* 隐私模式等情况下静默降级为内存态 */ }
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      State.record = data.record || null;

      // 兼容旧版本记录：老状态只有 identified / uncertain，视为已选定概念
      if (State.record && (State.record.status === 'identified' || State.record.status === 'uncertain') &&
        State.record.confirmed === undefined) {
        State.record.confirmed = true;
      }
      // 固定问题已问完但还没收尾时，补一次本地收尾
      if (State.record && State.record.status === 'collecting' && !E.nextQuestion(State.record)) {
        E.finishChat(State.record);
      }
      // 上次停留在等待模型时刷新页面，退回本地结果，避免卡在等待态
      if (State.record && State.record.status === 'thinking') {
        E.finishChat(State.record);
      }
      if (State.record) {
        ensureUnderstand(State.record);
        ensureGrowth(State.record);
      }
    } catch (err) { /* 忽略损坏的数据 */ }
  }

  function resetRecord() {
    State.record = null;
    State.aiTalk = null;
    save();
  }

  function toast(message) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add('is-on');
    window.clearTimeout(el._timer);
    el._timer = window.setTimeout(function () { el.classList.remove('is-on'); }, 2600);
  }

  /* ---------------- 步骤 ---------------- */

  function currentStep() {
    if (State.view === 'home') return 1;
    if (State.view === 'identify') return 1;
    if (State.view === 'understand') return 2;
    if (State.view === 'growth') return 3;
    return 1;
  }

  function stepperHTML() {
    const cur = currentStep();
    const growth = State.record && State.record.growth ? State.record.growth : null;
    const understand = State.record && State.record.understand ? State.record.understand : null;
    const items = [
      { n: 1, label: '识别与命名', sub: '先弄清它是什么', target: 'identify', enabled: true },
      { n: 2, label: '理解与探索', sub: '它可能怎么运作', target: 'understand', enabled: !!(State.record && State.record.confirmed) },
      { n: 3, label: '行动与成长', sub: '把理解变成行动', target: 'growth', enabled: !!(understand && understand.situation && understand.situation.confirmed) }
    ];
    const done = {
      1: !!State.record,
      2: !!(understand && understand.situation && understand.situation.confirmed),
      3: !!((growth && growth.practices && growth.practices.length) || (growth && growth.reminder && growth.reminder.confirmed))
    };

    let html = '<div class="stepper-inner">';
    items.forEach(function (it) {
      const isCur = cur === it.n;
      let state = '未解锁';
      if (isCur) state = '当前';
      else if (it.enabled && done[it.n]) state = '已完成';
      else if (it.enabled) state = '进入 →';

      const cls = 'board' +
        (isCur ? ' is-current' : '') +
        (it.enabled && done[it.n] ? ' is-done' : '') +
        (it.enabled ? '' : ' is-locked');

      html += '<button class="' + cls + '" type="button" data-action="step" data-target="' + it.target + '"' +
        (it.enabled ? '' : ' disabled') + (isCur ? ' aria-current="step"' : '') + '>' +
        '<span class="board-top">' +
          '<span class="board-num">0' + it.n + '</span>' +
          '<span class="board-state">' + state + '</span>' +
        '</span>' +
        '<span class="board-label">' + it.label + '</span>' +
        '<span class="board-sub">' + it.sub + '</span>' +
        '</button>';
    });
    return html + '</div>';
  }

  /* ---------------- 渲染入口 ---------------- */

  function render() {
    stepperEl.innerHTML = stepperHTML();
    if (State.view === 'home') renderHome();
    else if (State.view === 'identify') renderIdentify();
    else if (State.view === 'understand') renderUnderstand();
    else if (State.view === 'growth') renderGrowth();
    try { viewEl.focus({ preventScroll: true }); } catch (err) { /* noop */ }
    syncTopbarHeight();
  }

  function goView(next) {
    State.view = next;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ---------------- 通用：吸顶高度、进行中状态 ---------------- */

  /**
   * 实测顶栏高度写入 --topbar-h。
   * 板块导航与顶栏都是 sticky，顶栏高度写死会让两者吸顶后叠在一起，
   * 顶栏里的品牌与「数据说明 / 我的档案」会被完全遮住。
   */
  function syncTopbarHeight() {
    if (!topbarEl) return;
    const h = Math.round(topbarEl.getBoundingClientRect().height);
    if (h > 0) document.documentElement.style.setProperty('--topbar-h', h + 'px');
  }

  /** 按钮进入 / 退出「进行中」：禁用 + 转圈 + aria-busy，并保留原按钮文案 */
  function setPending(btn, on, label) {
    if (!btn) return;
    if (on) {
      if (btn.dataset.idleHtml === undefined) btn.dataset.idleHtml = btn.innerHTML;
      btn.classList.add('is-pending');
      btn.setAttribute('aria-busy', 'true');
      btn.disabled = true;
      btn.innerHTML = '<span class="btn-spin" aria-hidden="true"></span><span>' + (label || '处理中…') + '</span>';
    } else {
      btn.classList.remove('is-pending');
      btn.removeAttribute('aria-busy');
      btn.disabled = false;
      if (btn.dataset.idleHtml !== undefined) {
        btn.innerHTML = btn.dataset.idleHtml;
        delete btn.dataset.idleHtml;
      }
    }
  }

  /* ---------------- 首页 ---------------- */

  function renderHome() {
    const resume = State.record
      ? '<div class="resume card">' +
          '<p class="resume-label">上次的记录还留在这里</p>' +
          '<p class="resume-text">「' + esc(clip(State.record.raw, 46)) + '」</p>' +
          '<div class="row-actions">' +
            '<button class="btn btn-ghost" type="button" data-action="resume">' + ((State.record && State.record.confirmed) ? '继续上次的理解' : '继续上次的识别') + '</button>' +
            '<button class="btn btn-quiet" type="button" data-action="restart">开始新的描述</button>' +
          '</div>' +
        '</div>'
      : '';

    viewEl.innerHTML =
      '<section class="hero">' +
        '<p class="eyebrow">不是给人贴标签，而是给痛苦一个名字</p>' +
        '<h1>最近，有什么事情<br><em>让你感到难受？</em></h1>' +
        '<p class="lede">你的痛苦，值得被认真理解。<br>不用组织语言，想到哪里，就写到哪里。</p>' +
      '</section>' +
      resume +
      '<form class="card composer" data-form="identify" novalidate>' +
        '<label class="sr-only" for="rawInput">描述你最近难受的事情</label>' +
        '<textarea id="rawInput" name="raw" maxlength="1200" placeholder="比如：他几个小时没有回我消息，我一直在看手机，脑子里反复想，是不是自己做错了什么……"></textarea>' +
        '<div class="composer-foot">' +
          '<span class="counter" id="counter">0 / 1200</span>' +
          '<button class="btn btn-primary" type="submit">看看这是什么 <span class="arrow" aria-hidden="true">→</span></button>' +
        '</div>' +
      '</form>' +
      '<div class="chips-block">' +
        '<p class="chips-label">不知道从哪开始？选一个更接近你的情境，可以再改。</p>' +
        '<div class="chips">' +
          CHIPS.map(function (c) {
            return '<button class="chip" type="button" data-action="chip" data-text="' + esc(c.text) + '">' + esc(c.label) + '</button>';
          }).join('') +
        '</div>' +
      '</div>' +
      '<p class="quiet-note">我们不给你贴人格标签，也不做心理诊断。你写下的一切，只保存在这台设备的浏览器里，随时可以删除。</p>';

    updateCounter();
  }

  function updateCounter() {
    const input = document.getElementById('rawInput');
    const counter = document.getElementById('counter');
    if (!input || !counter) return;
    counter.textContent = input.value.length + ' / 1200';
  }

  /* ---------------- 板块一 ---------------- */

  function renderChat(record) {
    const isFollow = record.status === 'followup';
    const q = isFollow ? E.currentAiQuestion(record) : E.nextQuestion(record);
    const answers = record.answers || [];
    const fixedCount = answers.filter(function (a) { return String(a.key).indexOf('ai') !== 0; }).length;
    const aiCount = answers.length - fixedCount;
    let thread = '<div class="chat-row is-user"><div class="bubble is-user">' + esc(record.raw) + '</div></div>';

    answers.forEach(function (a) {
      const meta = E.chatQuestion(a.key);
      const qText = a.question || (meta ? meta.text : '');
      if (qText) {
        thread += '<div class="chat-row is-ai"><div class="bubble is-ai">' + esc(qText) + '</div></div>';
      }
      thread += '<div class="chat-row is-user"><div class="bubble is-user' + (a.skipped ? ' is-skip' : '') + '">' +
        (a.skipped ? '这题先跳过' : esc(a.text)) + '</div></div>';
    });

    let asking = '';
    if (q) {
      asking =
        '<div class="chat-row is-ai"><div class="bubble is-ai">' + esc(q.text) + '</div></div>' +
        '<div class="chat-options">' +
          q.options.map(function (t) {
            return '<button class="option-chip" type="button" data-action="chat-option" data-text="' + esc(t) + '">' + esc(t) + '</button>';
          }).join('') +
        '</div>' +
        '<form class="chat-compose" data-form="chat">' +
          '<input type="text" name="say" maxlength="200" autocomplete="off" placeholder="也可以用自己的话说">' +
          '<button class="btn btn-primary" type="submit">发送</button>' +
        '</form>' +
        '<div class="chat-foot">' +
          '<span class="chat-progress">' +
            (isFollow
              ? '再确认 ' + (aiCount + 1) + ' / ' + Math.max((record.aiQuestions || []).length, aiCount + 1) + ' 个'
              : '已问 ' + fixedCount + ' / 最多 ' + E.chatLimit + ' 个') +
          '</span>' +
          '<button class="btn btn-quiet" type="button" data-action="chat-skip">这题跳过</button>' +
        '</div>';
    }

    viewEl.innerHTML =
      '<div class="page-head">' +
        '<span class="kicker">板块一 · 识别与命名</span>' +
        '<h2>先聊几句，我再试着命名</h2>' +
        '<p class="sub">不用组织语言，一次只问一件事。不想回答就跳过，不会影响你继续使用。</p>' +
      '</div>' +
      '<section class="chat" aria-label="对话">' + thread + asking + '</section>';
  }

  function renderThinking(record) {
    const answers = record.answers || [];
    let thread = '<div class="chat-row is-user"><div class="bubble is-user">' + esc(record.raw) + '</div></div>';
    answers.forEach(function (a) {
      const meta = E.chatQuestion(a.key);
      const qText = a.question || (meta ? meta.text : '');
      if (qText) thread += '<div class="chat-row is-ai"><div class="bubble is-ai">' + esc(qText) + '</div></div>';
      thread += '<div class="chat-row is-user"><div class="bubble is-user' + (a.skipped ? ' is-skip' : '') + '">' +
        (a.skipped ? '这题先跳过' : esc(a.text)) + '</div></div>';
    });

    viewEl.innerHTML =
      '<div class="page-head">' +
        '<span class="kicker">板块一 · 识别与命名</span>' +
        '<h2>我在概念库里对照一下</h2>' +
        '<p class="sub">只使用库里的条目，不会凭空造一个名字。</p>' +
      '</div>' +
      '<section class="chat" aria-label="对话" aria-busy="true">' + thread +
        '<div class="chat-row is-ai"><div class="bubble is-ai thinking">正在整理你的描述<span class="dots"><i></i><i></i><i></i></span></div></div>' +
      '</section>' +
      '<div class="busy-hint">模型响应通常要几秒。如果一直不动，可以先用本地规则继续。' +
        '<br><button class="btn btn-ghost" type="button" data-action="identify-local">先用本地规则识别</button>' +
      '</div>';
  }

  function renderCandidates(record) {
    const list = record.candidates || [];
    if (!list.length) { renderNoCandidates(record); return; }

    viewEl.innerHTML =
      '<div class="page-head">' +
        '<span class="kicker">板块一 · 识别与命名</span>' +
        '<h2>它比较像这几种</h2>' +
        '<p class="sub">点一张，看看它在你的经历里是怎么运作的。不是诊断；选错了，也可以回来换。</p>' +
      '</div>' +
      '<div class="candidate-list">' +
        list.map(function (c, i) {
          return '<button class="candidate-card" type="button" data-action="choose-candidate" data-id="' + esc(c.conceptId) + '">' +
            '<span class="candidate-index">0' + (i + 1) + '</span>' +
            '<strong class="candidate-name">' + esc(c.name) + '</strong>' +
            '<span class="candidate-plain">' + esc(c.plain) + '</span>' +
            (c.scene ? '<span class="candidate-scene">' + esc(c.scene) + '</span>' : '') +
            '<span class="candidate-go" aria-hidden="true">看看这个 →</span>' +
          '</button>';
        }).join('') +
      '</div>' +
      '<p class="quiet-note">这些只是可能的方向，不是结论。匹配依据、适用边界和来源会放在下一步，不堆在这里。</p>' +
      '<div class="row-actions">' +
        '<button class="btn btn-quiet" type="button" data-action="restart">重新描述</button>' +
      '</div>';
  }

  function renderNoCandidates(record) {
    const missing = E.missingLabels(record);
    viewEl.innerHTML =
      '<div class="page-head"><span class="kicker">板块一 · 识别与命名</span></div>' +
      '<article class="card uncertain-card">' +
        '<span class="kicker">目前的结论是：不确定</span>' +
        '<h2>还不够可靠地命名</h2>' +
        '<p>你说的我都读到了，但还没法在概念库里找到一个真正贴合的解释。与其硬套一个术语，我更愿意停在这里。' +
        '这不代表你的感受不重要，只说明线索还不够。</p>' +
        (missing.length
          ? '<p style="margin-top:14px;font-size:13px;color:#8B8078">还缺少的部分：</p><ul class="missing-list">' +
              missing.map(function (m) { return '<li>' + esc(m) + '</li>'; }).join('') + '</ul>'
          : '') +
        '<form class="more-form" data-form="more">' +
          '<label for="moreInput">如果愿意，可以再补充一点，我再看看。</label>' +
          '<textarea id="moreInput" name="extra" rows="3" maxlength="400" placeholder="比如：当时具体发生了什么、你后来做了什么……"></textarea>' +
          '<div class="row-actions">' +
            '<button class="btn btn-primary" type="submit">继续补充</button>' +
            '<button class="btn btn-quiet" type="button" data-action="restart">重新描述</button>' +
          '</div>' +
        '</form>' +
      '</article>';
  }

  function renderChosen(record) {
    const concept = record.primary ? E.conceptById[record.primary.conceptId] : null;
    if (!concept) { renderNoCandidates(record); return; }

    viewEl.innerHTML =
      '<div class="page-head"><span class="kicker">板块一 · 识别与命名</span></div>' +
      '<article class="card chosen-card">' +
        '<span class="kicker">你选的方向</span>' +
        '<h2>' + esc(concept.name) + '</h2>' +
        '<p class="plain">' + esc(concept.plain) + '</p>' +
        '<p class="chosen-note">接下来会在这个概念的基础上，解释它可能怎么运作，并把匹配依据、适用边界和来源放在那里。</p>' +
        '<div class="row-actions">' +
          '<button class="btn btn-primary" type="button" data-action="understood">去看看它怎么运作</button>' +
          (record.candidates && record.candidates.length
            ? '<button class="btn btn-ghost" type="button" data-action="change-candidate">换一个候选</button>'
            : '') +
          '<button class="btn btn-quiet" type="button" data-action="restart">重新描述</button>' +
        '</div>' +
      '</article>' +
      '<p class="disclaimer">以上是基于你当前描述的理解与知识匹配，不是心理诊断，也不代表你是一个怎样的人。你可以不同意它。</p>';
  }

  function renderIdentify() {
    const record = State.record;
    if (!record) { State.view = 'home'; render(); return; }

    if (record.status === 'collecting' || record.status === 'followup') renderChat(record);
    else if (record.status === 'thinking') renderThinking(record);
    else if (!record.confirmed) renderCandidates(record);
    else renderChosen(record);
  }

  /* ---------------- 板块二：共鸣 → 概念 → 场景 → 解释 → 触发情境 ---------------- */

  function conceptOf(record) {
    if (!record || !record.primary) return null;
    return E.conceptById[record.primary.conceptId] || null;
  }

  function ensureUnderstand(record) {
    if (!record.understand) {
      record.understand = {
        step: 'resonance',
        resonance: null,
        scene: { index: 0, answers: [] },
        interpret: null,
        interpretLoading: false,
        situation: null
      };
    }
    if (!record.understand.scene) record.understand.scene = { index: 0, answers: [] };
    return record.understand;
  }

  function ensureGrowth(record) {
    if (!record.growth) {
      record.growth = { step: 'carry', directionId: null, practices: [], reminder: null, feedback: null, aiReply: '' };
    }
    if (!Array.isArray(record.growth.practices)) record.growth.practices = [];
    return record.growth;
  }

  function goUStep(step) {
    ensureUnderstand(State.record).step = step;
    save();
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function goGStep(step) {
    ensureGrowth(State.record).step = step;
    save();
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function understandProgress(record) {
    const u = record && record.understand;
    if (!u) return '未开始';
    if (u.situation && u.situation.confirmed) return '已确认情境';
    if (u.interpret) return '已对应经历';
    if (u.step === 'scene') return '正在描述场景';
    if (u.step === 'concept') return '已看概念';
    return '待确认共鸣';
  }

  function growthLogCount(record) {
    const g = record && record.growth;
    if (!g || !Array.isArray(g.practices)) return 0;
    return g.practices.reduce(function (n, p) { return n + (p.logs || []).length; }, 0);
  }

  function renderUnderstand() {
    const record = State.record;
    if (!record) { State.view = 'home'; render(); return; }
    if (!record.confirmed) { State.view = 'identify'; render(); return; }
    const concept = conceptOf(record);
    if (!concept) { State.view = 'home'; render(); return; }

    const u = ensureUnderstand(record);
    if (u.step === 'concept') return renderConceptPage(concept, u);
    if (u.step === 'scene') return renderScenePage(concept, u);
    if (u.step === 'interpret') return renderInterpretPage(concept, u);
    if (u.step === 'situation') return renderSituationPage(concept, u);
    if (u.step === 'summary') return renderUnderstandSummary(concept, u);
    return renderResonancePage(concept, u);
  }

  function stepDots(current, total) {
    let html = '<div class="step-dots" aria-hidden="true">';
    for (let i = 0; i < total; i++) {
      html += '<span class="dot' + (i === current ? ' is-on' : (i < current ? ' is-done' : '')) + '"></span>';
    }
    return html + '</div>';
  }

  function renderResonancePage(concept, u) {
    const excerpt = clip(String(State.record.raw || '').replace(/\s+/g, ' '), 46);
    // 概念库里没有 scene 字段，这里按 engine 的取法回落到 indicators[0]，
    // 否则每个概念的共振句都会渲染出字面量 undefined。
    const scene = concept.scene || (concept.indicators || [])[0] || '';
    const sentence = '你提到「' + excerpt + '」。' + scene;

    viewEl.innerHTML =
      '<div class="page-head">' +
        '<span class="kicker">板块二 · 理解与探索</span>' +
        stepDots(0, 5) +
        '<h2>这句话像你吗？</h2>' +
      '</div>' +
      '<div class="card resonance-card">' +
        '<p class="resonance-text">' + esc(sentence) + '</p>' +
        '<p class="quiet-note">这是基于你刚才的描述与「' + esc(concept.name) + '」的一句话概括，不是对你或对方的判断。</p>' +
      '</div>' +
      '<div class="row-actions">' +
        '<button class="btn btn-primary" type="button" data-action="u-like">是，这很像我</button>' +
        '<button class="btn btn-quiet" type="button" data-action="u-unlike">不太像，换一个概念</button>' +
      '</div>';
  }

  function renderConceptPage(concept, u) {
    const example = concept.scene || (concept.applicable || [])[0] || '';
    viewEl.innerHTML =
      '<div class="page-head">' +
        '<span class="kicker">板块二 · 理解与探索</span>' +
        stepDots(1, 5) +
        '<h2>' + esc(concept.name) + '</h2>' +
        '<p class="sub">' + esc(concept.plain) + '</p>' +
      '</div>' +
      '<section class="card concept-block">' +
        '<h3>专业定义</h3>' +
        '<p>' + esc(concept.definition) + '</p>' +
        '<h3>通俗解释</h3>' +
        '<p>' + esc((concept.explanation || [])[0] || concept.plain) + '</p>' +
        '<h3>生活里可能的样子</h3>' +
        '<p>' + esc(example) + '</p>' +
        detailsHTML(concept) +
      '</section>' +
      '<div class="row-actions">' +
        '<button class="btn btn-primary" type="button" data-action="u-to-scene">我想把它放进自己的经历里看看</button>' +
        '<button class="btn btn-quiet" type="button" data-action="u-back-candidates">返回概念选择</button>' +
      '</div>';
  }

  function detailsHTML(concept) {
    const sources = (concept.sources || []).map(function (s) {
      return '<div class="source">' +
        '<p class="src-title">' + esc(s.authors) + ' (' + esc(s.year) + '). ' + esc(s.title) + '</p>' +
        '<p class="src-venue">' + esc(s.venue) + '</p>' +
        (s.note ? '<p class="src-note">' + esc(s.note) + '</p>' : '') +
      '</div>';
    }).join('');
    const evidence = (concept.evidence || []).map(function (e) {
      return '<div class="source">' +
        '<p class="src-title">' + esc(e.source) + '（' + esc(e.locator) + '）</p>' +
        '<p class="src-note">' + esc(e.claim) + '</p>' +
        '<p class="src-note">支持范围：' + esc(e.supports) + '</p>' +
      '</div>';
    }).join('');
    const applicable = (concept.applicable || []).map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('');
    const notApplicable = (concept.nonApplicable || []).map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('');

    return '<details class="acc">' +
      '<summary>来源、适用边界与研究限制</summary>' +
      '<div class="acc-body">' +
        (sources ? '<h4>文献来源</h4>' + sources : '') +
        (evidence ? '<h4>语料证据</h4>' + evidence : '') +
        (applicable ? '<h4>适用情境</h4><ul class="missing-list">' + applicable + '</ul>' : '') +
        (notApplicable ? '<h4>不适用情境</h4><ul class="missing-list">' + notApplicable + '</ul>' : '') +
        '<p class="src-limit">研究限制：' + esc(concept.limits) + '</p>' +
      '</div>' +
    '</details>';
  }

  function sceneQuestions(concept) {
    if (Array.isArray(concept.sceneQuestions) && concept.sceneQuestions.length) return concept.sceneQuestions;
    return (concept.indicators || []).slice(0, 3).map(function (t) {
      return '你最近一次出现「' + t + '」，是在什么情况下？';
    });
  }

  function renderScenePage(concept, u) {
    const list = sceneQuestions(concept);
    const index = Math.min(u.scene.index, list.length - 1);
    const question = list[index];

    viewEl.innerHTML =
      '<div class="page-head">' +
        '<span class="kicker">板块二 · 理解与探索</span>' +
        stepDots(2, 5) +
        '<h2>回想最近一次类似的情形</h2>' +
        '<p class="sub">这些问题是围绕「' + esc(concept.name) + '」准备的，不需要全部答完，可以跳过。</p>' +
      '</div>' +
      '<section class="card scene-card">' +
        '<p class="q-index">第 ' + (index + 1) + ' / ' + list.length + ' 个问题</p>' +
        '<h3 class="scene-q">' + esc(question) + '</h3>' +
        '<form data-form="u-scene">' +
          '<textarea name="answer" maxlength="400" rows="4" placeholder="用自己的话写，一句话也可以">' + esc((u.scene.answers[index] || {}).text || '') + '</textarea>' +
          '<div class="row-actions">' +
            '<button class="btn btn-primary" type="submit">继续</button>' +
            '<button class="btn btn-quiet" type="button" data-action="u-scene-skip">这题跳过</button>' +
          '</div>' +
        '</form>' +
      '</section>' +
      (u.scene.answers.length ? '<p class="quiet-note">已经记下 ' + u.scene.answers.filter(function (a) { return a && a.text; }).length + ' 条回答。信息不足时，我们会说明，而不是硬给结论。</p>' : '');
  }

  function localInterpret(concept, u) {
    const facts = u.scene.answers.filter(function (a) { return a && a.text; })
      .map(function (a) { return clip(a.text, 90); }).slice(0, 4);
    const matches = (concept.indicators || []).slice(0, 2).map(function (t) {
      return { fact: facts[0] || '你描述的情形', interpretation: '这与「' + t + '」有相似之处', certainty: 'hypothesis' };
    });
    return {
      facts: facts,
      matches: matches,
      unknown: ['对方当时的想法，从这里无法得知', '这件事之后会怎样，还需要时间'],
      caveat: '这部分是基于概念的可能理解，不是结论；如果和你的感受不符，可以直接修正。',
      aiUsed: false
    };
  }

  function requestInterpret(correction) {
    const record = State.record;
    const concept = conceptOf(record);
    const u = ensureUnderstand(record);
    if (!concept) return;

    u.step = 'interpret';
    u.interpretLoading = true;
    u.fixing = false;
    save();
    render();

    const payload = {
      conceptId: concept.id,
      raw: record.raw || '',
      answers: (record.answers || []).map(function (a) {
        return typeof a === 'string' ? { text: a } : { key: a.key, text: a.text, skipped: !!a.skipped };
      }),
      sceneAnswers: u.scene.answers.map(function (a) {
        return { question: a.question, text: a.text, skipped: !!a.skipped };
      }),
      correction: correction || ''
    };

    AI.interpret(payload)
      .then(function (res) {
        u.interpret = res;
        u.interpret.aiUsed = true;
        u.interpret.correction = correction || '';
      })
      .catch(function () {
        const local = localInterpret(concept, u);
        local.correction = correction || '';
        u.interpret = local;
        toast('模型暂时不可用，先用本地规则给一个保守版本');
      })
      .then(function () {
        u.interpretLoading = false;
        save();
        render();
      });
  }

  function renderInterpretPage(concept, u) {
    if (u.interpretLoading || !u.interpret) {
      viewEl.innerHTML =
        '<div class="page-head"><span class="kicker">板块二 · 理解与探索</span>' + stepDots(3, 5) + '<h2>正在把这段经历和概念对上</h2></div>' +
        '<div class="loader" role="status" aria-busy="true"><div class="loader-mark" aria-hidden="true"></div><p class="loader-text">正在整理你说过的情境与回应</p><p class="loader-dim">如果模型不可用，会先用本地规则给一个保守版本</p></div>';
      return;
    }

    const it = u.interpret;
    const matches = (it.matches || []).map(function (m) {
      const tag = m.certainty === 'fact'
        ? '<span class="tag tag-fact">你提到的</span>'
        : '<span class="tag tag-hyp">可能解释</span>';
      return '<div class="link-item">' +
        '<span class="fact">「' + esc(clip(m.fact, 80)) + '」</span>' +
        '<span class="interp">' + tag + esc(m.interpretation) + '</span>' +
      '</div>';
    }).join('');

    const correcting = !!u.fixing;

    viewEl.innerHTML =
      '<div class="page-head">' +
        '<span class="kicker">板块二 · 理解与探索</span>' +
        stepDots(3, 5) +
        '<h2>用「' + esc(concept.name) + '」再看一遍你的经历</h2>' +
        '<p class="sub">下面是把你说的内容和这个概念对应起来的结果。哪些贴近，哪些不对，由你判断。</p>' +
      '</div>' +
      '<section class="card interpret-card">' +
        '<h3>你说过的</h3>' +
        (it.facts && it.facts.length
          ? '<ul class="missing-list">' + it.facts.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul>'
          : '<p>这一次没有可以单独列出的事实，下面的解释会更保守。</p>') +
        '<h3>与概念的相似之处</h3>' +
        (matches || '<p>仅凭目前的描述，还看不出明确的相似线索。</p>') +
        '<h3>目前无法确定的</h3>' +
        '<ul class="missing-list">' + (it.unknown || []).map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>' +
        (it.caveat ? '<p class="quiet-note">' + esc(it.caveat) + '</p>' : '') +
      '</section>' +
      '<div class="row-actions">' +
        '<button class="btn btn-primary" type="button" data-action="u-interpret-ok">这个理解比较贴近</button>' +
        '<button class="btn btn-quiet" type="button" data-action="u-interpret-fix">有一部分不对，我想补充</button>' +
      '</div>' +
      (correcting
        ? '<section class="card">' +
            '<label for="correctionInput">哪里不对？补充后我会重新解释，而不是重复原来的结论。</label>' +
            '<textarea id="correctionInput" maxlength="400" rows="3">' + esc(it.correction || '') + '</textarea>' +
            '<div class="row-actions"><button class="btn btn-ghost" type="button" data-action="u-interpret-retry">按我的修正重新理解</button></div>' +
          '</section>'
        : '');
  }

  function renderSituationPage(concept, u) {
    const options = (concept.situationOptions || []).slice(0, 3);
    const s = u.situation || {};
    viewEl.innerHTML =
      '<div class="page-head">' +
        '<span class="kicker">板块二 · 理解与探索</span>' +
        stepDots(4, 5) +
        '<h2>这种反应，通常在什么时候出现？</h2>' +
        '<p class="sub">不是问你当时多难受，而是问：什么样的情境容易把你带到这里。</p>' +
      '</div>' +
      '<section class="card">' +
        '<div class="option-list">' +
          options.map(function (opt) {
            return '<button class="option-chip' + (s.answer === opt ? ' is-on' : '') + '" type="button" data-action="u-situation-pick" data-text="' + esc(opt) + '">' + esc(opt) + '</button>';
          }).join('') +
          '<button class="option-chip' + (s.answer === '其他情况' ? ' is-on' : '') + '" type="button" data-action="u-situation-pick" data-text="其他情况">其他情况</button>' +
        '</div>' +
        '<form data-form="u-situation">' +
          '<input name="answer" type="text" maxlength="120" placeholder="也可以自己写一句：比如「他连续两天没主动联系我时」" value="' + esc(s.answer && s.answer !== '其他情况' ? s.answer : '') + '">' +
          '<div class="row-actions"><button class="btn btn-primary" type="submit">形成情境总结</button></div>' +
        '</form>' +
      '</section>' +
      (s.summary
        ? '<section class="card summary-card">' +
            '<p class="summary-text">' + esc(s.summary) + '</p>' +
            '<p class="quiet-note">这个总结准确吗？你可以改，也可以推翻。</p>' +
            '<div class="row-actions">' +
              '<button class="btn btn-primary" type="button" data-action="u-situation-confirm">准确，继续</button>' +
              '<button class="btn btn-quiet" type="button" data-action="u-situation-retry">我想改一下</button>' +
            '</div>' +
          '</section>'
        : '');
  }

  function whenPhrase(answer) {
    const text = String(answer || '类似情境出现').trim();
    return /[时后]$/.test(text) ? text : text + '时';
  }

  function buildSituationSummary(u, concept) {
    const answer = (u.situation && u.situation.answer) || '';
    const behaviors = (u.scene.answers || []).filter(function (a) { return a && a.text; });
    const reaction = behaviors.length > 1 ? clip(behaviors[1].text, 40) : (concept.indicators || ['出现这种反应'])[0];
    return '听起来，当' + whenPhrase(answer) + '，你通常会' + reaction + '。';
  }

  function renderUnderstandSummary(concept, u) {
    const s = u.situation || {};
    viewEl.innerHTML =
      '<div class="page-head">' +
        '<span class="kicker">板块二 · 理解与探索</span>' +
        stepDots(5, 5) +
        '<h2>先把这一步收在这里</h2>' +
      '</div>' +
      '<section class="card summary-card">' +
        '<p class="quiet-note">你选择的概念</p>' +
        '<h3>' + esc(concept.name) + '</h3>' +
        '<p>' + esc(concept.plain) + '</p>' +
        '<p class="quiet-note" style="margin-top:16px">你确认过的情境</p>' +
        '<p class="summary-text">' + esc(s.summary || buildSituationSummary(u, concept)) + '</p>' +
        '<p class="quiet-note">这一页只是把你说过的收在一起，不构成诊断。接下来可以看看，在这样的情境里，你想多一个什么选择。</p>' +
      '</section>' +
      '<div class="row-actions">' +
        '<button class="btn btn-primary" type="button" data-action="u-to-growth">看看可以尝试的练习</button>' +
        '<button class="btn btn-quiet" type="button" data-action="u-back-scene">回去补充场景</button>' +
      '</div>';
  }

  /* ---------------- 板块三：承接 → 方向 → 练习 → 清单 → 反馈 → 回顾 ---------------- */

  function directionsForConcept(concept) {
    const ids = concept && Array.isArray(concept.directions) ? concept.directions : [];
    const list = ids.map(function (id) { return D.directions[id]; }).filter(Boolean);
    return list.length ? list : [D.directions.d_general].filter(Boolean);
  }

  function renderGrowth() {
    const record = State.record;
    if (!record) { State.view = 'home'; render(); return; }
    if (!record.confirmed) { State.view = 'identify'; render(); return; }
    const u = ensureUnderstand(record);
    if (!u.situation || !u.situation.confirmed) {
      u.step = u.situation ? 'situation' : 'resonance';
      save();
      State.view = 'understand';
      render();
      return;
    }
    const concept = conceptOf(record);
    const g = ensureGrowth(record);
    if (g.step === 'direction') return renderDirectionPick(concept, g);
    if (g.step === 'practice') return renderPracticePick(concept, g);
    if (g.step === 'list') return renderPracticeList(concept, g);
    if (g.step === 'feedback') return renderFeedbackPage(concept, g);
    if (g.step === 'review') return renderReviewPage(concept, g, u);
    return renderCarryPage(concept, g, u);
  }

  function practiceFrom(direction, task, u) {
    return {
      id: direction.id + ':' + task.id,
      directionId: direction.id,
      directionTitle: direction.title,
      taskId: task.id,
      title: task.title,
      action: task.desc,
      purpose: direction.description,
      when: (u.situation && u.situation.summary) || '当类似情境再次出现时',
      status: 'active',
      addedAt: Date.now(),
      logs: []
    };
  }

  function renderCarryPage(concept, g, u) {
    viewEl.innerHTML =
      '<div class="page-head">' +
        '<span class="kicker">板块三 · 行动与成长</span>' +
        stepDots(0, 6) +
        '<h2>从这里接着往下走</h2>' +
      '</div>' +
      '<section class="card carry-card">' +
        '<p class="quiet-note">你在板块二确认过的</p>' +
        '<p class="summary-text">' + esc((u.situation && u.situation.summary) || '') + '</p>' +
        '<p>接下来的练习，是帮你在类似情境里多一个选择。这不代表沟通的问题都由你负责，也不要求你改变对方。</p>' +
      '</section>' +
      '<div class="row-actions">' +
        '<button class="btn btn-primary" type="button" data-action="g-start">看看可以尝试的练习</button>' +
        '<button class="btn btn-quiet" type="button" data-action="g-later">暂时不选</button>' +
      '</div>' +
      '<p class="quiet-note">不看、不选都可以。这里没有打卡、积分，也没有未完成提醒。</p>';
  }

  function renderDirectionPick(concept, g) {
    const list = directionsForConcept(concept);
    viewEl.innerHTML =
      '<div class="page-head">' +
        '<span class="kicker">板块三 · 行动与成长</span>' +
        stepDots(1, 6) +
        '<h2>你想从哪个方向开始？</h2>' +
        '<p class="sub">这些方向来自你确认的情境与「' + esc(concept.name) + '」，只选一个开始就够。</p>' +
      '</div>' +
      '<div class="direction-list">' +
        list.map(function (d, i) {
          return '<article class="card direction">' +
            '<div class="dir-head"><span class="dir-num">0' + (i + 1) + '</span><h3>' + esc(d.title) + '</h3></div>' +
            '<p>' + esc(d.description) + '</p>' +
            '<div class="dir-actions"><button class="btn btn-ghost" type="button" data-action="g-pick-direction" data-id="' + d.id + '">从这个方向看看</button></div>' +
          '</article>';
        }).join('') +
      '</div>' +
      '<div class="row-actions"><button class="btn btn-quiet" type="button" data-action="g-back-carry">先回去看看</button></div>';
  }

  function renderPracticePick(concept, g) {
    const dir = D.directions[g.directionId];
    if (!dir) { g.step = 'direction'; save(); render(); return; }
    const u = ensureUnderstand(State.record);
    const chosen = g.practices.map(function (p) { return p.id; });

    viewEl.innerHTML =
      '<div class="page-head">' +
        '<span class="kicker">板块三 · 行动与成长</span>' +
        stepDots(2, 6) +
        '<h2>' + esc(dir.title) + '</h2>' +
        '<p class="sub">下面是最多三个轻量练习。可以选一个，也可以都不选。</p>' +
      '</div>' +
      dir.tasks.slice(0, 3).map(function (t) {
        const p = practiceFrom(dir, t, u);
        const added = chosen.indexOf(p.id) > -1;
        return '<article class="card practice-card">' +
          '<h3>' + esc(t.title) + '</h3>' +
          '<p class="practice-when"><span>什么时候可以试</span>' + esc(p.when) + '</p>' +
          '<p class="practice-action"><span>具体可以做什么</span>' + esc(t.desc) + '</p>' +
          '<p class="practice-goal"><span>练习的目的</span>' + esc(dir.title) + '：' + esc(clip(dir.description, 70)) + '</p>' +
          '<div class="mini-actions">' +
            (added
              ? '<button class="btn btn-quiet" type="button" data-action="g-remove-practice" data-id="' + p.id + '">已加入，移出清单</button>'
              : '<button class="btn btn-ghost" type="button" data-action="g-add-practice" data-id="' + p.id + '">加入「我想试试」</button>') +
          '</div>' +
        '</article>';
      }).join('') +
      '<div class="row-actions">' +
        '<button class="btn btn-primary" type="button" data-action="g-view-list">看看我的清单</button>' +
        '<button class="btn btn-quiet" type="button" data-action="g-back-directions">换个方向</button>' +
      '</div>';
  }

  function renderPracticeList(concept, g) {
    const list = g.practices;
    viewEl.innerHTML =
      '<div class="page-head">' +
        '<span class="kicker">板块三 · 行动与成长</span>' +
        stepDots(3, 6) +
        '<h2>我想试试</h2>' +
        '<p class="sub">这里只有你主动选进来的练习。没有每日任务，也不统计连续天数。</p>' +
      '</div>' +
      (list.length
        ? list.map(function (p) {
            return '<article class="card practice-card' + (p.status === 'paused' ? ' is-paused' : '') + '">' +
              '<h3>' + esc(p.title) + '</h3>' +
              '<p class="practice-when"><span>什么时候可以试</span>' + esc(p.when) + '</p>' +
              '<p class="practice-action"><span>具体可以做什么</span>' + esc(p.action) + '</p>' +
              (p.status === 'paused' ? '<p class="quiet-note">已暂时放下，没有任何惩罚。</p>' : '') +
              '<div class="mini-actions">' +
                '<button class="btn btn-ghost" type="button" data-action="g-record" data-id="' + p.id + '">记录这次尝试</button>' +
                (p.status === 'active'
                  ? '<button class="btn btn-quiet" type="button" data-action="g-pause-practice" data-id="' + p.id + '">暂时不做</button>'
                  : '<button class="btn btn-quiet" type="button" data-action="g-resume-practice" data-id="' + p.id + '">重新放回</button>') +
                '<button class="btn btn-quiet" type="button" data-action="g-ai-talk" data-id="' + p.id + '">和 AI 聊聊</button>' +
                '<button class="btn btn-quiet" type="button" data-action="g-remove-practice" data-id="' + p.id + '">移除</button>' +
              '</div>' +
            '</article>';
          }).join('')
        : '<section class="card"><p>清单还是空的，这完全可以。你可以先去看看方向，也可以什么都不选。</p>' +
            '<div class="row-actions"><button class="btn btn-primary" type="button" data-action="g-back-directions">看看方向</button></div></section>') +
      '<div class="row-actions">' +
        (list.length ? '<button class="btn btn-primary" type="button" data-action="g-to-review">回顾一下</button>' : '') +
        '<button class="btn btn-quiet" type="button" data-action="g-back-directions">再挑一个方向</button>' +
      '</div>';
  }

  function renderFeedbackPage(concept, g) {
    const p = g.practices.filter(function (x) { return x.id === g.feedbackId; })[0] || null;
    if (!p) { g.step = 'list'; save(); render(); return; }
    const fb = e => '<button class="option-chip' + (g.feedbackChoice === e ? ' is-on' : '') + '" type="button" data-action="g-feedback-choice" data-value="' + e + '">' + esc(E.feedbackLabel[e] || e) + '</button>';

    viewEl.innerHTML =
      '<div class="page-head">' +
        '<span class="kicker">板块三 · 行动与成长</span>' +
        stepDots(4, 6) +
        '<h2>这次尝试，怎么样？</h2>' +
        '<p class="sub">' + esc(p.title) + '。没有「失败」这个选项，也没尝试不代表任何评价。</p>' +
      '</div>' +
      '<section class="card">' +
        '<div class="option-list">' + ['done', 'tried', 'later', 'extra'].map(fb).join('') + '</div>' +
        '<label for="feedbackNote">想补充一句吗？（可以跳过）</label>' +
        '<textarea id="feedbackNote" maxlength="300" rows="3" placeholder="比如：比想象中难，但说出口之后轻了一点。">' + esc(g.feedbackNote || '') + '</textarea>' +
        '<div class="row-actions">' +
          '<button class="btn btn-primary" type="button" data-action="g-feedback-submit">记下这次</button>' +
          '<button class="btn btn-quiet" type="button" data-action="g-cancel-feedback">先不记</button>' +
        '</div>' +
      '</section>' +
      (g.aiReply
        ? '<section class="card ai-reply">' +
            '<p class="quiet-note">AI 的回应</p>' +
            '<p>' + esc(g.aiReply) + '</p>' +
            '<div class="row-actions">' +
              '<button class="btn btn-quiet" type="button" data-action="g-alt-practice">看看替代的练习</button>' +
              '<button class="btn btn-quiet" type="button" data-action="g-to-list">回到清单</button>' +
            '</div>' +
          '</section>'
        : '') +
      (g.altOpen ? renderAltPractices(concept, g) : '');
  }

  function renderAltPractices(concept, g) {
    const list = directionsForConcept(concept).filter(function (d) { return d.id !== g.directionId; });
    const dir = list[0] || directionsForConcept(concept)[0];
    const u = ensureUnderstand(State.record);
    return '<section class="card">' +
      '<h3>可以换成这些试试</h3>' +
      '<p class="quiet-note">这些不是自动派给你的任务。愿意的话，再决定要不要加进清单。</p>' +
      dir.tasks.slice(0, 2).map(function (t) {
        const p = practiceFrom(dir, t, u);
        const added = g.practices.some(function (x) { return x.id === p.id; });
        return '<div class="alt-practice">' +
          '<h4>' + esc(t.title) + '</h4>' +
          '<p>' + esc(t.desc) + '</p>' +
          (added
            ? '<p class="quiet-note">已在清单里</p>'
            : '<button class="btn btn-ghost" type="button" data-action="g-add-alt" data-dir="' + dir.id + '" data-task="' + t.id + '">加入「我想试试」</button>') +
        '</div>';
      }).join('') +
    '</section>';
  }

  function renderReviewPage(concept, g, u) {
    const logs = [];
    g.practices.forEach(function (p) {
      (p.logs || []).forEach(function (l) { logs.push({ p: p, log: l }); });
    });
    const helped = logs.filter(function (x) { return x.log.feedback === 'done'; }).length;
    const reviewed = g.reminder && g.reminder.confirmed;
    const summary = logs.length
      ? '你一共留下 ' + logs.length + ' 条记录，其中 ' + helped + ' 次觉得有帮助。' +
        (logs.length ? '最近一次记录是：' + (E.feedbackLabel[logs[logs.length - 1].log.feedback] || '一次尝试') + '。' : '')
      : '你还没有记录尝试。这不影响什么，想试的时候再试。';

    const draft = g.reminder && g.reminder.text
      ? g.reminder.text
      : '当' + whenPhrase((u.situation && u.situation.answer) || '') + '，我可以先停一下，再决定怎么回应。';

    viewEl.innerHTML =
      '<div class="page-head">' +
        '<span class="kicker">板块三 · 行动与成长</span>' +
        stepDots(5, 6) +
        '<h2>回头看一眼</h2>' +
      '</div>' +
      '<section class="card">' +
        '<h3>这段时间</h3>' +
        '<p>' + esc(summary) + '</p>' +
        (logs.length
          ? '<ul class="timeline">' + logs.slice(-5).map(function (x) {
              return '<li class="log-item"><span class="log-time">' + esc(fmt(x.log.at)) + '</span>' +
                '<span class="log-body"><strong>' + esc(E.feedbackLabel[x.log.feedback] || '记录') + '</strong>' +
                (x.log.note ? '<em>' + esc(x.log.note) + '</em>' : '') + '</span></li>';
            }).join('') + '</ul>'
          : '') +
      '</section>' +
      '<section class="card reminder-card">' +
        '<h3>给自己留一句提醒</h3>' +
        '<p class="quiet-note">这是草稿，只有你确认后才会保存。之后随时可以改。</p>' +
        '<input id="reminderInput" maxlength="120" value="' + esc(draft) + '">' +
        '<div class="row-actions">' +
          '<button class="btn btn-primary" type="button" data-action="g-save-reminder">' + (reviewed ? '更新这句提醒' : '确认并保存这句提醒') + '</button>' +
          '<button class="btn btn-quiet" type="button" data-action="g-to-list">回到清单</button>' +
        '</div>' +
        (reviewed ? '<p class="quiet-note">已保存：' + esc(g.reminder.text) + '</p>' : '') +
        '<p class="quiet-note">完成或收起练习，不代表问题已经解决，也不代表你必须做完。</p>' +
      '</section>';
  }

  /* ---------------- 板块三：AI 对话（带入当前情境与练习） ---------------- */

  function aiTalkModal(practice) {
    const record = State.record;
    const u = ensureUnderstand(record);
    const concept = conceptOf(record);
    State.aiTalk = { practice: practice, messages: [] };
    const context = [
      '概念：' + (concept ? concept.name : ''),
      '用户确认的情境：' + ((u.situation && u.situation.summary) || ''),
      '练习：' + (practice ? practice.title : ''),
      '练习内容：' + (practice ? practice.action : '')
    ].join('\n');

    openModal(
      '<div class="modal-head"><h2>和 AI 聊聊这次尝试</h2><button class="btn btn-quiet" type="button" data-action="close-modal">关闭</button></div>' +
      '<p class="quiet-note">已经带入你确认的情境和练习，不需要重复说明。</p>' +
      '<div class="ai-talk-log" id="aiTalkLog"><p class="quiet-note">想说什么都可以。AI 会先回应你的情况，再问你是否需要建议。</p></div>' +
      '<form data-form="ai-talk">' +
        '<label class="sr-only" for="aiTalkSay">说说这次尝试的情况</label>' +
        '<textarea id="aiTalkSay" name="say" maxlength="300" rows="2" placeholder="比如：我试了，但说到一半就卡住了。"></textarea>' +
        '<div class="row-actions"><button class="btn btn-primary" type="submit">发送</button></div>' +
      '</form>' +
      '<p class="quiet-note" data-context="' + esc(context) + '"></p>'
    );
  }

  function renderAITalk() {
    const root = document.getElementById('aiTalkLog');
    if (!root || !State.aiTalk) return;
    let html = State.aiTalk.messages.map(function (m) {
      return '<div class="ai-msg ' + (m.role === 'user' ? 'is-user' : 'is-ai') + '">' + esc(m.content) + '</div>';
    }).join('');
    if (State.aiTalk.pending) {
      html += '<div class="ai-msg is-ai thinking"><span class="dots"><i></i><i></i><i></i></span></div>';
    }
    root.innerHTML = html || '<p class="quiet-note">想说什么都可以。</p>';
    root.scrollTop = root.scrollHeight;
  }

  /* ---------------- 加载 / 错误 ---------------- */

  function startLoader(messages) {
    stepperEl.innerHTML = stepperHTML();
    viewEl.innerHTML = '<div class="loader" role="status">' +
      '<div class="loader-mark" aria-hidden="true"></div>' +
      '<p class="loader-text" id="loaderText">' + esc(messages[0]) + '</p>' +
      '<p class="loader-dim">这通常只需要几秒</p>' +
      '</div>';
    let i = 0;
    const timer = window.setInterval(function () {
      i = (i + 1) % messages.length;
      const el = document.getElementById('loaderText');
      if (el) el.textContent = messages[i];
    }, 820);
    return function stop() { window.clearInterval(timer); };
  }

  function markAIFallback() {
    const el = document.getElementById('aiStatus');
    if (el) {
      el.textContent = '模型：连接失败，已回退规则';
      el.classList.remove('is-on');
    }
  }

  function updateAIStatus() {
    const el = document.getElementById('aiStatus');
    if (!el) return;
    if (!AI) {
      el.textContent = '模型：本地规则模式';
      return;
    }
    const info = AI.state();
    if (!info.checked) {
      el.textContent = '模型：检测中…';
      return;
    }
    el.textContent = info.configured
      ? '模型：已连接 ' + (info.model || '')
      : '模型：本地规则模式';
    el.classList.toggle('is-on', !!info.configured);
  }

  /* ---------------- 动作 ---------------- */

  function startDraft(raw) {
    State.record = E.buildDraft(raw);
    State.record.understand = null;
    State.record.growth = null;
    save();
    State.view = 'identify';
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    announce('可以开始聊了，一次只问一件事');
  }

  function afterChatUpdate() {
    save();
    render();
    const input = document.querySelector('.chat-compose input');
    if (input) {
      input.focus({ preventScroll: true });
      input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    }
  }

  function activeQuestion() {
    const record = State.record;
    if (!record) return null;
    if (record.status === 'followup') return E.currentAiQuestion(record);
    if (record.status === 'collecting') return E.nextQuestion(record);
    return null;
  }

  function requestIdentify(round) {
    const record = State.record;
    if (!record) return;

    const canModel = AI && AI.available() && location.protocol !== 'file:' && !State.forceNoMatch;
    if (!canModel) {
      fallbackLocal(record);
      return;
    }

    record.status = 'thinking';
    State.identifyCancelled = false;
    save();
    render();
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });

    const payload = {
      raw: record.raw,
      answers: (record.answers || []).map(function (a) {
        return { key: a.key, text: a.text, skipped: !!a.skipped };
      }),
      askedQuestions: (record.answers || []).map(function (a) { return a.question; }).filter(Boolean),
      followUpRounds: round
    };

    AI.identify(payload).then(function (res) {
      if (State.identifyCancelled) return;
      if (!State.record || State.record.id !== record.id) return;

      if (res.followUps.length && round < 1) {
        E.setAiFollowUps(record, res.followUps);
        save();
        render();
        const input = document.querySelector('.chat-compose input');
        if (input) input.focus({ preventScroll: true });
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
        announce('还想再确认两件事');
        return;
      }

      if (res.candidates.length) {
        E.applyAiCandidates(record, res.candidates, res.confidence, res.note);
      } else {
        record.candidates = [];
        record.aiConfidence = res.confidence;
        record.aiNote = res.note;
        record.followUpDone = true;
        record.chatDone = true;
        record.status = 'insufficient_information';
      }

      save();
      render();
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      announce(res.candidates.length ? '已经聊完，可以看看这几个可能' : '信息还不够，先到这里');
    }).catch(function () {
      if (State.identifyCancelled) return;
      if (!State.record || State.record.id !== record.id) return;
      markAIFallback();
      toast('模型暂时不可用，已用本地规则识别');
      fallbackLocal(record);
    });
  }

  function fallbackLocal(record) {
    E.finishChat(record);
    if (State.forceNoMatch) {
      record.candidates = [];
      record.status = 'insufficient_information';
      record.libraryEmpty = true;
      State.forceNoMatch = false;
    }
    save();
    render();
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    announce(record.candidates && record.candidates.length ? '已经聊完，可以看看这几个可能' : '线索还不足');
  }

  function answerChat(key, text, skipped, question) {
    const record = State.record;
    if (!record) return;
    if (record.status !== 'collecting' && record.status !== 'followup') return;

    if (E.detectCrisis((record.raw || '') + ' ' + (text || ''))) {
      crisisModal();
      return;
    }

    if (record.status === 'followup') {
      E.addAiAnswer(record, text, skipped, question);
      save();
      if (!E.currentAiQuestion(record)) {
        requestIdentify(1);
        return;
      }
      afterChatUpdate();
      announce('已记录，继续下一问');
      return;
    }

    E.addAnswer(record, key, text, skipped, question);
    save();

    if (!E.nextQuestion(record)) {
      requestIdentify(0);
      return;
    }

    afterChatUpdate();
    announce('已记录，继续下一个问题');
  }

  function chooseCandidate(conceptId) {
    const record = State.record;
    if (!record) return;
    State.record = E.chooseConcept(record, conceptId);
    State.record.understand = null;
    State.record.growth = null;
    save();
    goView('understand');
    announce('已选定这个概念，进入理解与探索');
  }

  /**
   * 板块三：把用户的反馈交给模型，先回应情况，再决定是否提建议。
   * 失败时保留上一步的本地回应，不阻塞流程。
   */
  function sendFeedbackToAI(practice, choice, note) {
    if (!AI || !AI.available() || location.protocol === 'file:') return;
    const record = State.record;
    const concept = conceptOf(record);
    const u = ensureUnderstand(record);
    const label = E.feedbackLabel[choice] || '一次尝试';
    const messages = [
      {
        role: 'system',
        content: [
          '你是「给痛苦一个名字」的陪伴助手。用户刚记录了一次练习尝试。',
          '先用一到两句回应他的情况，说清楚你听到了什么；不要评判，不把没尝试说成失败。',
          '如果用户表达出想调整的意愿，再问一句是否需要替代方案；不要自动派发新任务，不要一次给多条建议。',
          '不提诊断，不推断伴侣的动机，不超过 120 字。'
        ].join('\n')
      },
      {
        role: 'user',
        content: [
          '概念：' + (concept ? concept.name : '未命名'),
          '确认的情境：' + ((u.situation && u.situation.summary) || '未提供'),
          '练习：' + practice.title,
          '这次的结果：' + label,
          note ? '用户补充：' + note : '用户没有补充文字'
        ].join('\n')
      }
    ];
    AI.chat(messages, 300).then(function (reply) {
      const g = ensureGrowth(State.record);
      g.aiReply = reply;
      save();
      if (g.step === 'feedback') render();
    }).catch(function () {
      toast('模型暂时不可用，已保留本地回应');
    });
  }

  /* ---------------- 弹层 ---------------- */

  let modalTrigger = null;

  function openModal(html) {
    modalTrigger = document.activeElement;
    modalRoot.innerHTML = '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">' + html + '</div>';
    modalRoot.hidden = false;
    document.body.style.overflow = 'hidden';
    const title = modalRoot.querySelector('.modal-head h2') || modalRoot.querySelector('h2');
    if (title) {
      title.id = 'modalTitle';
      modalRoot.querySelector('.modal').setAttribute('aria-labelledby', 'modalTitle');
    }
    const first = modalRoot.querySelector('.btn');
    if (first) first.focus();
  }

  function closeModal() {
    modalRoot.hidden = true;
    modalRoot.innerHTML = '';
    document.body.style.overflow = '';
    // 关闭后把焦点还给触发它的按钮，否则键盘用户会掉回页面顶部
    const back = modalTrigger;
    modalTrigger = null;
    if (back && document.body.contains(back)) {
      try { back.focus({ preventScroll: true }); } catch (err) { /* noop */ }
    }
  }

  function privacyModal() {
    const aiInfo = AI && AI.state();
    const aiLine = aiInfo && aiInfo.configured
      ? '<li>当前已连接大模型（' + esc(aiInfo.model || '') + '）：你输入的文字会发送给模型服务商，仅用于生成这一次的识别与报告；其数据留存与使用政策以服务商说明为准。</li>'
      : '<li>当前使用的是本地规则引擎，你输入的内容不会离开这台设备。</li>';
    openModal(
      '<div class="modal-head"><span class="kicker">数据与边界</span>' +
      '<h2>关于你的内容</h2></div>' +
      '<ul>' +
        '<li>你写下的描述、档案、报告和记录，保存在当前浏览器的本地存储里；清除浏览器数据或点「清空数据」即删除。</li>' +
        aiLine +
        '<li>你可以在「我的档案」里删除这条记录，或清空全部数据。删除后无法恢复。</li>' +
        '<li>请不要在这里填写真实姓名、联系方式、住址等可以识别身份的信息。</li>' +
        '<li>这不是心理诊断、心理治疗或危机干预服务。如果你正处在危险中，请优先联系现实中的专业帮助。</li>' +
      '</ul>' +
      '<div class="row-actions">' +
        '<button class="btn btn-primary" type="button" data-action="close-modal">我知道了</button>' +
      '</div>'
    );
  }

  function archiveModal() {
    const r = State.record;
    if (!r) {
      openModal('<div class="modal-head"><span class="kicker">我的档案</span><h2>这里还是空的</h2></div>' +
        '<p>你写下第一段描述之后，这里会保存对应的痛苦分析档案与后续记录。</p>' +
        '<div class="row-actions"><button class="btn btn-ghost" type="button" data-action="close-modal">关闭</button></div>');
      return;
    }
    const concept = r.primary ? E.conceptById[r.primary.conceptId] : null;
    openModal(
      '<div class="modal-head"><span class="kicker">我的档案</span><h2>这条记录</h2></div>' +
      '<div class="archive-quote">「' + esc(clip(r.raw, 120)) + '」</div>' +
      '<div class="archive-meta">' +
        '<div class="data-row"><span>识别结果</span><span>' + esc(concept ? concept.name + '（' + r.confidence + '）' : '尚未可靠命名') + '</span></div>' +
        '<div class="data-row"><span>创建时间</span><span>' + esc(fmt(r.createdAt)) + '</span></div>' +
        '<div class="data-row"><span>理解进度</span><span>' + esc(understandProgress(r)) + '</span></div>' +
        '<div class="data-row"><span>练习记录</span><span>' + growthLogCount(r) + ' 条</span></div>' +
      '</div>' +
      '<div class="row-actions">' +
        '<button class="btn btn-ghost" type="button" data-action="close-modal">关闭</button>' +
        '<button class="btn btn-quiet" type="button" data-action="delete-record">删除这条记录</button>' +
        '<button class="btn btn-quiet" type="button" data-action="wipe-all">清空全部数据</button>' +
      '</div>' +
      '<p class="archive-note">删除会同时移除对应的报告、成长记录和里程碑。</p>'
    );
  }

  function crisisModal() {
    const c = D.crisis;
    openModal(
      '<div class="modal-head"><span class="kicker">安全优先</span><h2>' + esc(c.title) + '</h2></div>' +
      '<p>' + esc(c.body) + '</p>' +
      '<ul class="crisis-list">' +
        c.actions.map(function (a) {
          const tel = String(a.value).replace(/[^0-9]/g, '');
          return '<li><span>' + esc(a.label) + '</span>' +
            '<a class="crisis-call" href="tel:' + esc(tel) + '"><strong>' + esc(a.value) + '</strong></a></li>';
        }).join('') +
      '</ul>' +
      '<p>' + esc(c.footer) + '</p>' +
      '<div class="row-actions">' +
        '<button class="btn btn-primary" type="button" data-action="close-modal">我明白了</button>' +
        '<button class="btn btn-quiet" type="button" data-action="go-home">先回到首页</button>' +
      '</div>'
    );
  }

  /* ---------------- 事件 ---------------- */

  document.addEventListener('click', function (e) {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.getAttribute('data-action');

    switch (action) {
      case 'cycle-theme':
        Theme.cycle();
        break;
      case 'go-home':
        closeModal();
        goView('home');
        break;
      case 'step': {
        const target = el.getAttribute('data-target');
        if (target === 'identify' && State.record) { goView('identify'); break; }
        if (target === 'understand' && State.record && State.record.confirmed) { goView('understand'); break; }
        if (target === 'growth' && State.record && State.record.confirmed) { goView('growth'); break; }
        if (target === 'identify' && !State.record) { goView('home'); break; }
        break;
      }
      case 'chip': {
        const input = document.getElementById('rawInput');
        if (input) {
          input.value = el.getAttribute('data-text') || '';
          updateCounter();
          input.focus();
        }
        break;
      }
      case 'chat-option': {
        const q = activeQuestion();
        if (q) answerChat(q.key || ('ai' + (State.record.aiAsked || 0)), el.getAttribute('data-text') || '', false, q.text);
        break;
      }
      case 'chat-skip': {
        const q = activeQuestion();
        if (q) answerChat(q.key || ('ai' + (State.record.aiAsked || 0)), '', true, q.text);
        break;
      }
      case 'choose-candidate':
        chooseCandidate(el.getAttribute('data-id'));
        break;
      case 'change-candidate':
        if (State.record) {
          State.record.confirmed = false;
          State.record.primary = null;
          save();
          render();
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
        break;
      case 'understood':
        goView('understand');
        break;
      case 'restart':
        resetRecord();
        State.view = 'home';
        render();
        window.scrollTo({ top: 0, behavior: 'smooth' });
        announce('已开始新的描述');
        break;
      case 'resume':
        if (!State.record) { goView('home'); break; }
        goView((State.record && State.record.confirmed) ? 'understand' : 'identify');
        break;
      case 'growth':
        goView('growth');
        break;

      /* ---- 板块二：五步流程 ---- */
      case 'u-like': {
        const u = ensureUnderstand(State.record);
        u.resonance = 'like';
        u.step = 'concept';
        save();
        render();
        window.scrollTo({ top: 0, behavior: 'smooth' });
        break;
      }
      case 'u-unlike':
        State.record.confirmed = false;
        State.record.primary = null;
        State.record.understand = null;
        save();
        render();
        window.scrollTo({ top: 0, behavior: 'smooth' });
        announce('已返回概念选择');
        break;
      case 'u-back-candidates':
        State.record.confirmed = false;
        State.record.primary = null;
        State.record.understand = null;
        save();
        render();
        break;
      case 'u-to-scene':
        goUStep('scene');
        break;
      case 'u-scene-skip': {
        const u = ensureUnderstand(State.record);
        const concept = conceptOf(State.record);
        const list = sceneQuestions(concept);
        const index = Math.min(u.scene.index, list.length - 1);
        u.scene.answers[index] = { question: list[index], text: '', skipped: true };
        u.scene.index = index + 1;
        if (u.scene.index >= list.length) { requestInterpret(''); break; }
        save();
        render();
        break;
      }
      case 'u-interpret-ok':
        goUStep('situation');
        break;
      case 'u-interpret-fix': {
        const u = ensureUnderstand(State.record);
        u.fixing = true;
        save();
        render();
        break;
      }
      case 'u-interpret-retry': {
        const input = document.getElementById('correctionInput');
        requestInterpret(input ? input.value.trim() : '');
        break;
      }
      case 'u-situation-pick': {
        const u = ensureUnderstand(State.record);
        u.situation = u.situation || {};
        u.situation.answer = el.getAttribute('data-text') || '';
        u.situation.summary = '';
        save();
        render();
        break;
      }
      case 'u-situation-retry': {
        const u = ensureUnderstand(State.record);
        u.situation.summary = '';
        u.situation.confirmed = false;
        save();
        render();
        break;
      }
      case 'u-situation-confirm': {
        const u = ensureUnderstand(State.record);
        if (!u.situation || !u.situation.summary) break;
        u.situation.confirmed = true;
        u.step = 'summary';
        ensureGrowth(State.record).step = 'carry';
        save();
        render();
        window.scrollTo({ top: 0, behavior: 'smooth' });
        break;
      }
      case 'u-to-growth':
        goView('growth');
        break;
      case 'u-back-scene':
        goUStep('scene');
        break;

      /* ---- 板块三：六步流程 ---- */
      case 'g-start':
        goGStep('direction');
        break;
      case 'g-later':
        goGStep('list');
        break;
      case 'g-pick-direction': {
        const g = ensureGrowth(State.record);
        g.directionId = el.getAttribute('data-id');
        g.step = 'practice';
        save();
        render();
        window.scrollTo({ top: 0, behavior: 'smooth' });
        break;
      }
      case 'g-add-practice': {
        const g = ensureGrowth(State.record);
        const dir = D.directions[g.directionId];
        const id = el.getAttribute('data-id') || '';
        if (!dir) break;
        const taskId = id.split(':')[1];
        const task = dir.tasks.filter(function (t) { return t.id === taskId; })[0];
        if (!task) break;
        if (!g.practices.some(function (p) { return p.id === id; })) {
          g.practices.push(practiceFrom(dir, task, ensureUnderstand(State.record)));
          save();
          render();
          announce('已加入「我想试试」');
        }
        break;
      }
      case 'g-remove-practice': {
        const g = ensureGrowth(State.record);
        const id = el.getAttribute('data-id');
        g.practices = g.practices.filter(function (p) { return p.id !== id; });
        save();
        render();
        break;
      }
      case 'g-pause-practice':
      case 'g-resume-practice': {
        const g = ensureGrowth(State.record);
        const id = el.getAttribute('data-id');
        g.practices.forEach(function (p) {
          if (p.id === id) p.status = action === 'g-pause-practice' ? 'paused' : 'active';
        });
        save();
        render();
        break;
      }
      case 'g-view-list':
      case 'g-to-list':
        goGStep('list');
        break;
      case 'g-back-directions':
        goGStep('direction');
        break;
      case 'g-back-carry':
        goGStep('carry');
        break;
      case 'g-record': {
        const g = ensureGrowth(State.record);
        g.feedbackId = el.getAttribute('data-id');
        g.feedbackChoice = '';
        g.feedbackNote = '';
        g.aiReply = '';
        g.altOpen = false;
        g.step = 'feedback';
        save();
        render();
        window.scrollTo({ top: 0, behavior: 'smooth' });
        break;
      }
      case 'g-feedback-choice': {
        const g = ensureGrowth(State.record);
        g.feedbackChoice = el.getAttribute('data-value');
        save();
        render();
        break;
      }
      case 'g-feedback-submit': {
        const g = ensureGrowth(State.record);
        const note = document.getElementById('feedbackNote');
        const text = note ? note.value.trim() : '';
        const practice = g.practices.filter(function (p) { return p.id === g.feedbackId; })[0];
        if (!practice) break;
        g.feedbackNote = text;
        const choice = g.feedbackChoice || 'extra';
        practice.logs = practice.logs || [];
        practice.logs.push({ at: Date.now(), feedback: choice, note: text });
        g.aiReply = '已记下。' + (choice === 'done' ? '有帮助的部分，值得记住它当时是怎么发生的。' :
          choice === 'tried' ? '不太适合也很重要，它说明这个方式和你现在的处境不完全匹配。' :
          choice === 'later' ? '这次没能尝试，不代表任何评价，也不需要补交。' :
          '谢谢你愿意补充，这一段会被留在你的记录里。');
        save();
        render();
        sendFeedbackToAI(practice, choice, text);
        break;
      }
      case 'g-cancel-feedback':
        goGStep('list');
        break;
      case 'g-alt-practice': {
        const g = ensureGrowth(State.record);
        g.altOpen = true;
        save();
        render();
        break;
      }
      case 'g-add-alt': {
        const g = ensureGrowth(State.record);
        const dir = D.directions[el.getAttribute('data-dir')];
        const taskId = el.getAttribute('data-task');
        if (!dir) break;
        const task = dir.tasks.filter(function (t) { return t.id === taskId; })[0];
        if (!task) break;
        const p = practiceFrom(dir, task, ensureUnderstand(State.record));
        if (!g.practices.some(function (x) { return x.id === p.id; })) {
          g.practices.push(p);
          save();
          render();
          announce('已加入「我想试试」');
        }
        break;
      }
      case 'g-to-review':
        goGStep('review');
        break;
      case 'g-save-reminder': {
        const g = ensureGrowth(State.record);
        const input = document.getElementById('reminderInput');
        const text = input ? input.value.trim() : '';
        if (!text) { toast('可以写一句，或者先不保存'); break; }
        g.reminder = { text: text, confirmed: true, updatedAt: Date.now() };
        save();
        render();
        announce('提醒已保存');
        break;
      }
      case 'g-ai-talk': {
        const g = ensureGrowth(State.record);
        const practice = g.practices.filter(function (p) { return p.id === el.getAttribute('data-id'); })[0];
        aiTalkModal(practice || null);
        break;
      }

      case 'open-privacy':
        privacyModal();
        break;
      case 'open-archive':
        archiveModal();
        break;
      case 'close-modal':
        closeModal();
        break;
      case 'delete-record':
        resetRecord();
        closeModal();
        State.view = 'home';
        render();
        announce('记录已删除');
        break;
      case 'wipe-all':
        resetRecord();
        try { localStorage.removeItem(KEY); } catch (err) { /* noop */ }
        closeModal();
        State.view = 'home';
        render();
        announce('全部本地数据已清空');
        toast('已清空全部本地数据');
        break;
      case 'identify-local':
        if (State.record) {
          State.identifyCancelled = true;
          fallbackLocal(State.record);
          toast('已改用本地规则识别');
        }
        break;
      case 'demo-at01':
        fillAndGo('他几个小时没有回我消息，我一直看手机，担心他其实没那么在乎我。');
        break;
      case 'demo-at02':
        fillAndGo('我很难受。');
        break;
      case 'demo-nomatch':
        State.forceNoMatch = true;
        fillAndGo('最近有点累，也说不上来具体是怎么了。');
        toast('已开启「无匹配」模拟，提交后查看兜底');
        break;
      case 'demo-fail':
        State.failNext = true;
        toast('下一次生成会模拟失败');
        break;
      default:
        break;
    }
  });

  function fillAndGo(text) {
    State.view = 'home';
    render();
    const input = document.getElementById('rawInput');
    if (input) {
      input.value = text;
      updateCounter();
      input.focus();
    }
    if (demoPanel) demoPanel.hidden = true;
    if (demoToggle) demoToggle.setAttribute('aria-expanded', 'false');
  }

  document.addEventListener('submit', function (e) {
    e.preventDefault();
    const form = e.target;
    const type = form.getAttribute('data-form');

    if (type === 'identify') {
      const raw = form.elements.raw.value.trim();
      if (raw.length < 2) {
        toast('可以再多写一点点，哪怕一句');
        return;
      }
      if (E.detectCrisis(raw)) {
        crisisModal();
        return;
      }
      startDraft(raw);
      return;
    }

    if (type === 'chat') {
      const q = activeQuestion();
      if (!q) return;
      const text = form.elements.say.value.trim();
      if (!text) {
        toast('可以写一句，或点上面的选项');
        return;
      }
      answerChat(q.key || ('ai' + (State.record.aiAsked || 0)), text, false, q.text);
      return;
    }

    if (type === 'u-scene') {
      const record = State.record;
      const concept = conceptOf(record);
      if (!record || !concept) return;
      const u = ensureUnderstand(record);
      const list = sceneQuestions(concept);
      const index = Math.min(u.scene.index, list.length - 1);
      const text = form.elements.answer.value.trim();
      if (!text) {
        toast('可以写一句，或点「这题跳过」');
        return;
      }
      u.scene.answers[index] = { question: list[index], text: text, skipped: false };
      u.scene.index = index + 1;
      if (u.scene.index >= list.length) { requestInterpret(''); return; }
      save();
      render();
      announce('已记下，继续下一个问题');
      return;
    }

    if (type === 'u-situation') {
      const record = State.record;
      if (!record) return;
      const u = ensureUnderstand(record);
      const typed = form.elements.answer.value.trim();
      const answer = typed || (u.situation && u.situation.answer) || '';
      if (!answer) {
        toast('可以选一个情境，或自己写一句');
        return;
      }
      u.situation = u.situation || {};
      u.situation.answer = answer;
      u.situation.summary = buildSituationSummary(u, conceptOf(record));
      save();
      render();
      announce('已形成情境总结，你可以确认或修改');
      return;
    }

    if (type === 'ai-talk') {
      const text = form.elements.say.value.trim();
      if (!text) return;
      if (!State.aiTalk) return;
      State.aiTalk.messages.push({ role: 'user', content: text });
      renderAITalk();
      form.reset();
      const record = State.record;
      const u = ensureUnderstand(record);
      const concept = conceptOf(record);
      const practice = State.aiTalk.practice;
      const messages = [
        {
          role: 'system',
          content: [
            '你是「给痛苦一个名字」的陪伴助手，正在和用户聊一次具体的练习尝试。',
            '先回应他刚说的内容，再决定是否需要提问或给建议；不要评判，不推断伴侣的动机。',
            '如果用户没有主动要建议，不要直接派发新任务；一次最多一个建议，不超过 120 字。',
            '概念：' + (concept ? concept.name : '未命名'),
            '确认的情境：' + ((u.situation && u.situation.summary) || '未提供'),
            '练习：' + (practice ? practice.title + '（' + practice.action + '）' : '未指定')
          ].join('\n')
        }
      ].concat(State.aiTalk.messages);
      const sendBtn = form.querySelector('button[type="submit"]');
      const sayInput = form.elements.say;
      State.aiTalk.pending = true;
      setPending(sendBtn, true, '发送中…');
      if (sayInput) sayInput.disabled = true;
      renderAITalk();
      AI.chat(messages, 400).then(function (reply) {
        State.aiTalk.messages.push({ role: 'assistant', content: reply });
      }).catch(function () {
        State.aiTalk.messages.push({ role: 'assistant', content: '模型暂时不可用。你说的这些已经留在这条记录里，可以稍后再试。' });
      }).then(function () {
        State.aiTalk.pending = false;
        setPending(sendBtn, false);
        if (sayInput) sayInput.disabled = false;
        renderAITalk();
        if (sayInput) { try { sayInput.focus({ preventScroll: true }); } catch (err) { /* noop */ } }
      });
      return;
    }

    if (type === 'more') {
      const extra = form.elements.extra.value.trim();
      if (!extra) {
        toast('可以再写一句');
        return;
      }
      if (E.detectCrisis(extra)) {
        crisisModal();
        return;
      }
      E.continueRecord(State.record, extra);
      save();
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      announce('已补充，重新看了匹配');
      return;
    }
  });

  document.addEventListener('input', function (e) {
    if (e.target.id === 'rawInput') updateCounter();
  });

  document.addEventListener('keydown', function (e) {
    if (modalRoot.hidden) return;
    if (e.key === 'Escape') { closeModal(); return; }
    if (e.key !== 'Tab') return;

    // 焦点锁在弹层内部，避免 Tab 跑到弹层后面的页面上
    const items = modalRoot.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (!items.length) return;
    const list = Array.prototype.slice.call(items);
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !modalRoot.contains(active)) { e.preventDefault(); last.focus(); }
    } else if (active === last || !modalRoot.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  });

  modalRoot.addEventListener('click', function (e) {
    if (e.target === modalRoot) closeModal();
  });

  if (demoToggle) demoToggle.addEventListener('click', function () {
    const open = demoPanel.hidden;
    demoPanel.hidden = !open;
    demoToggle.setAttribute('aria-expanded', String(open));
  });

  /* ---------------- 启动 ---------------- */

  load();
  render();
  Theme.init();
  syncTopbarHeight();
  window.addEventListener('resize', syncTopbarHeight);
  if (window.ResizeObserver && topbarEl) {
    new ResizeObserver(syncTopbarHeight).observe(topbarEl);
  }
  if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
    document.fonts.ready.then(syncTopbarHeight);
  }

  if (location.protocol === 'file:') {
    const el = document.getElementById('aiStatus');
    if (el) el.textContent = '模型：本地规则模式（需 node 启动）';
  } else if (AI) {
    AI.check().then(updateAIStatus);
  } else {
    updateAIStatus();
  }
})();
