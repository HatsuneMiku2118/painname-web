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
    report: null,
    choice: null,
    logs: [],
    milestone: null,
    depth: 'present',
    originsText: '',
    pendingFeedback: null,
    retry: null,
    failNext: false,
    forceNoMatch: false
  };

  const viewEl = document.getElementById('view');
  const stepperEl = document.getElementById('stepper');
  const modalRoot = document.getElementById('modalRoot');
  const liveEl = document.getElementById('live');
  const demoPanel = document.getElementById('demoPanel');
  const demoToggle = document.getElementById('demoToggle');

  const CHIPS = [
    { label: '恋爱中的不安', text: '他几个小时没有回我消息，我一直看手机，担心他其实没那么在乎我。' },
    { label: '暧昧中的不确定', text: '我们暧昧了三个月，他从来不明确说我们算什么。我每天都在猜他的意思，又不敢问。' },
    { label: '分手后的不舍', text: '分手两周了，我还是会反复想起以前的细节，不知道自己现在想要什么。' },
    { label: '关系中的自我怀疑', text: '每次他不高兴，我都在想是不是我太敏感、要求太多。我不敢提自己的需要。' }
  ];

  const DEPTH_LABEL = { present: '理解当下', origins: '探索形成因素', combined: '先理解当下，再看形成因素' };

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
        report: State.report,
        choice: State.choice,
        logs: State.logs,
        milestone: State.milestone,
        depth: State.depth,
        originsText: State.originsText,
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
      State.report = data.report || null;
      State.choice = data.choice || null;
      State.logs = data.logs || [];
      State.milestone = data.milestone || null;
      State.depth = data.depth || 'present';
      State.originsText = data.originsText || '';

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
    } catch (err) { /* 忽略损坏的数据 */ }
  }

  function resetRecord() {
    State.record = null;
    State.report = null;
    State.choice = null;
    State.logs = [];
    State.milestone = null;
    State.depth = 'present';
    State.originsText = '';
    State.pendingFeedback = null;
    State.forceNoMatch = false;
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
    const items = [
      { n: 1, label: '识别与命名', sub: '先弄清它是什么', target: 'identify', enabled: true },
      { n: 2, label: '理解与探索', sub: '它可能怎么运作', target: 'understand', enabled: !!(State.record && State.record.confirmed) },
      { n: 3, label: '行动与成长', sub: '把理解变成行动', target: 'growth', enabled: !!State.report }
    ];
    const done = {
      1: !!State.record,
      2: !!State.report,
      3: State.logs.length > 0 || !!(State.milestone && State.milestone.status === 'confirmed')
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
  }

  function goView(next) {
    State.view = next;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ---------------- 首页 ---------------- */

  function renderHome() {
    const resume = State.record
      ? '<div class="resume card">' +
          '<p class="resume-label">上次的记录还留在这里</p>' +
          '<p class="resume-text">「' + esc(clip(State.record.raw, 46)) + '」</p>' +
          '<div class="row-actions">' +
            '<button class="btn btn-ghost" type="button" data-action="resume">' + ((State.report || (State.record && State.record.confirmed)) ? '继续上次的理解' : '继续上次的识别') + '</button>' +
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
      '<section class="chat" aria-label="对话">' + thread +
        '<div class="chat-row is-ai"><div class="bubble is-ai thinking">正在整理你的描述<span class="dots"><i></i><i></i><i></i></span></div></div>' +
      '</section>';
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

  /* ---------------- 板块二 ---------------- */

  function renderUnderstand() {
    if (!State.record) { State.view = 'home'; render(); return; }
    if (!State.record.confirmed) { State.view = 'identify'; render(); return; }
    if (State.report) renderReport();
    else renderDepthPick();
  }

  function renderDepthPick() {
    const depths = [
      { key: 'present', letter: 'A', title: '理解当下', desc: '看看现在的情绪、想法和行为，是怎么互相维持的' },
      { key: 'origins', letter: 'B', title: '探索形成因素', desc: '如果你愿意，看看更早的经历可能留下了什么' },
      { key: 'combined', letter: 'C', title: '两者结合', desc: '先理解当下，再去看可能的形成因素' }
    ];
    const needsOrigins = State.depth === 'origins' || State.depth === 'combined';

    viewEl.innerHTML =
      '<div class="page-head">' +
        '<span class="kicker">板块二 · 理解与探索</span>' +
        '<h2>你想理解到哪一层？</h2>' +
        '<p class="sub">这里不会再问你已经说过的事。你在板块一写下的内容会被直接带过来。</p>' +
      '</div>' +
      '<div class="depth-list">' +
        depths.map(function (d) {
          return '<button class="depth-card' + (State.depth === d.key ? ' is-selected' : '') + '" type="button" data-action="depth" data-depth="' + d.key + '" aria-pressed="' + (State.depth === d.key) + '">' +
            '<span class="depth-key">' + d.letter + '</span>' +
            '<span class="depth-body"><strong>' + d.title + '</strong><em>' + d.desc + '</em></span>' +
          '</button>';
        }).join('') +
      '</div>' +
      (needsOrigins
        ? '<div class="card origins-box">' +
            '<label for="originsInput">可选：如果你愿意，可以先补充一点更早的经历</label>' +
            '<p class="hint">没有补充也完全可以。我们不会替你推断童年、家庭或过去的关系。</p>' +
            '<textarea id="originsInput" maxlength="600" placeholder="比如：小时候家里不太谈情绪，我习惯了有事先自己消化……">' + esc(State.originsText) + '</textarea>' +
          '</div>'
        : '') +
      '<div class="row-actions">' +
        '<button class="btn btn-primary" type="button" data-action="generate-report">生成我的理解</button>' +
        '<button class="btn btn-quiet" type="button" data-action="step" data-target="identify">回到板块一看看</button>' +
      '</div>' +
      '<p class="quiet-note">报告中会标出哪些是你提到的事实、哪些只是基于理论的可能解释，以及哪些目前还不知道。</p>';
  }

  function linksHTML(report) {
    if (!report.links.length) return '<p>这一段暂时没有可以对应到具体线索的内容。</p>';
    return report.links.map(function (l) {
      const tag = l.certainty === 'fact'
        ? '<span class="tag tag-fact">你提到的</span>'
        : (l.certainty === 'guess' ? '<span class="tag tag-guess">推测</span>' : '<span class="tag tag-hyp">理论解释</span>');
      return '<div class="link-item">' +
        '<span class="fact">「' + esc(clip(l.fact, 80)) + '」</span>' +
        '<span class="interp">' + tag + esc(l.interpretation) + '</span>' +
      '</div>';
    }).join('');
  }

  function separationHTML(report) {
    return '<div class="sep-grid">' +
      '<div class="sep-col is-fact"><h4><span class="tag tag-fact">事实</span>你自己说过的</h4><ul>' +
        (report.facts.length ? report.facts.map(function (f) { return '<li>' + esc(clip(f, 70)) + '</li>'; }).join('') : '<li>你在描述里没有明确写出可以单独列出的事实。</li>') +
      '</ul></div>' +
      '<div class="sep-col is-hyp"><h4><span class="tag tag-hyp">解释</span>基于理论的可能理解</h4><ul>' +
        (report.hypotheses.length ? report.hypotheses.map(function (h) { return '<li>' + esc(h) + '</li>'; }).join('') : '<li>目前没有足够的依据给出理论解释。</li>') +
      '</ul></div>' +
      '<div class="sep-col is-unknown"><h4><span class="tag tag-unknown">未知</span>现在还无法确定的</h4><ul>' +
        (report.unknowns.length ? report.unknowns.map(function (u) { return '<li>' + esc(u) + '</li>'; }).join('') : '<li>暂时没有列出待确认的信息。</li>') +
      '</ul></div>' +
    '</div>';
  }

  function sourcesHTML(report) {
    if (!report.sources.length) {
      return '<p>这次没有引用具体文献，因为还没有匹配到可追溯的概念条目。这比引用一个不确定的来源更诚实。</p>';
    }
    return '<details class="acc sources"><summary>查看概念来源与证据范围</summary><div class="acc-body">' +
      report.sources.map(function (s) {
        return '<div class="source">' +
          '<p class="src-title">' + esc(s.authors) + ' (' + esc(s.year) + '). ' + esc(s.title) + '</p>' +
          '<p class="src-venue">' + esc(s.venue) + '</p>' +
          (s.note ? '<p class="src-note">' + esc(s.note) + '</p>' : '') +
        '</div>';
      }).join('') +
      '<p class="src-limit">证据范围与局限：' + esc(report.limits) + '</p>' +
      '</div></details>';
  }

  function renderReport() {
    const report = State.report;
    const record = State.record;
    const concept = report.conceptId ? E.conceptById[report.conceptId] : null;
    const title = concept ? '关于「' + concept.name + '」的一份理解' : '关于这份感受的一份理解';
    const badge = report.status !== 'identified'
      ? '<div class="report-banner">这份报告建立在有限的信息上。它更像一个可以讨论的方向，而不是结论。</div>'
      : '';

    const sections = [];
    sections.push({
      title: '这个痛苦叫什么',
      body: '<p>' + report.explain.map(esc).join('</p><p>') + '</p>' +
        (concept ? '<p class="quiet-note" style="margin-top:14px">专业定义：' + esc(concept.definition) + '</p>' : '')
    });

    if (report.mechanism.length) {
      sections.push({
        title: '它是怎么维持的',
        body: '<p>' + report.mechanism.map(esc).join('</p><p>') + '</p>' +
          (report.cycle.length
            ? '<ol class="cycle">' + report.cycle.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>'
            : '')
      });
    }

    sections.push({ title: '它在你身上长什么样', body: linksHTML(report) });

    if (report.depth === 'origins' || report.depth === 'combined') {
      const qs = !report.origins.provided
        ? '<p style="margin-top:14px;font-size:13px;color:#8B8078">可以从这些问题开始，也可以完全跳过：</p><ul class="missing-list">' +
            report.origins.questions.map(function (q) { return '<li>' + esc(q) + '</li>'; }).join('') + '</ul>'
        : '';
      sections.push({
        title: '更早的经历，可能留下了什么',
        body: '<p>' + esc(report.origins.paragraph) + '</p>' + qs +
          '<p style="margin-top:12px"><span class="tag tag-unknown">待探索</span> 这一节不是诊断，也不代表过去一定发生了什么。</p>'
      });
    }

    sections.push({ title: '哪些是事实，哪些是解释', body: separationHTML(report) });
    sections.push({ title: '把它重新说一遍', body: '<p class="summary-text">' + esc(report.summary) + '</p>' });
    sections.push({ title: '理论依据', body: sourcesHTML(report) });

    viewEl.innerHTML =
      '<div class="page-head">' +
        '<span class="kicker">板块二 · 理解与探索</span>' +
        '<h2>' + esc(title) + '</h2>' +
        (concept ? '<p class="sub">它描述的是：' + esc(concept.plain) + '</p>' : '') +
        '<p class="meta">' + esc(DEPTH_LABEL[report.depth] || '') + ' · 基于你在板块一写下的内容</p>' +
      '</div>' +
      badge +
      '<div class="report">' +
        sections.map(function (s, i) {
          return '<section class="report-section">' +
            '<h3><span class="sec-index">' + String(i + 1).padStart(2, '0') + '</span>' + esc(s.title) + '</h3>' +
            s.body +
          '</section>';
        }).join('') +
      '</div>' +
      '<div class="row-actions">' +
        '<button class="btn btn-primary" type="button" data-action="growth">看看我可以往哪里走</button>' +
        '<button class="btn btn-quiet" type="button" data-action="reset-report">换一个探索深度</button>' +
      '</div>' +
      '<p class="disclaimer">这份报告基于你提供的描述与概念库中的公开知识，不构成诊断，也不是对你或对方的定论。对方当时的想法，从这里无法得知。</p>';
  }

  /* ---------------- 板块三 ---------------- */

  function directionsHTML() {
    const directions = E.directionsFor(State.record);
    const chosen = State.choice ? State.choice.directionId : null;
    return directions.map(function (d, i) {
      const isSelected = chosen === d.id;
      return '<article class="card direction' + (isSelected ? ' is-selected' : '') + '">' +
        '<div class="dir-head">' +
          '<span class="dir-num">0' + (i + 1) + '</span>' +
          '<h3>' + esc(d.title) + '</h3>' +
          (isSelected ? '<span class="badge">当前方向</span>' : '') +
        '</div>' +
        '<p>' + esc(d.description) + '</p>' +
        '<div class="scene"><span>可能的一个场景</span><p>' + esc(d.scene) + '</p></div>' +
        '<p class="change"><span>可能带来的变化</span>' + esc(d.change) + '</p>' +
        '<div class="dir-actions">' +
          (isSelected
            ? (State.choice.status === 'active'
                ? '<button class="btn btn-ghost" type="button" data-action="pause-direction">暂时暂停这个方向</button>'
                : '<button class="btn btn-ghost" type="button" data-action="resume-direction">继续这个方向</button>')
            : '<button class="btn btn-ghost" type="button" data-action="pick-direction" data-id="' + d.id + '">设为当前方向</button>') +
        '</div>' +
      '</article>';
    }).join('');
  }

  function tasksHTML(direction) {
    const pending = State.pendingFeedback;
    return '<div class="tasks">' +
      direction.tasks.map(function (t) {
        const isPending = pending && pending.taskId === t.id;
        return '<div class="task">' +
          '<h4>' + esc(t.title) + '</h4>' +
          '<p>' + esc(t.desc) + '</p>' +
          '<div class="task-actions">' +
            ['done', 'tried', 'later'].map(function (f) {
              return '<button class="fb-btn" type="button" data-action="feedback" data-task="' + t.id + '" data-feedback="' + f + '">' + esc(E.feedbackLabel[f]) + '</button>';
            }).join('') +
          '</div>' +
          (isPending
            ? '<div class="reflection">' +
                '<label for="reflectionInput">想补一句当时的感受吗？（可以跳过）</label>' +
                '<input id="reflectionInput" maxlength="140" placeholder="比如：比想象中难，但做完之后轻了一点。">' +
                '<div class="row-actions">' +
                  '<button class="btn btn-primary" type="button" data-action="save-log">保存这条记录</button>' +
                  '<button class="btn btn-quiet" type="button" data-action="cancel-log">不写了</button>' +
                '</div>' +
              '</div>'
            : '') +
        '</div>';
      }).join('') +
    '</div>';
  }

  function logsHTML() {
    if (!State.logs.length) {
      return '<p class="mile-empty">还没有记录。你不需要每天都来，也不需要完成任何任务。</p>';
    }
    const list = State.logs.slice().reverse().map(function (log) {
      return '<li class="log-item">' +
        '<span class="log-time">' + esc(fmt(log.createdAt)) + '</span>' +
        '<span class="log-body">' +
          '<strong class="log-feedback-' + esc(log.feedback) + '">' + esc(E.feedbackLabel[log.feedback] || '记录') + '</strong>' +
          (log.reflection ? '<em>' + esc(log.reflection) + '</em>' : '<span>没有补充文字，也完全可以。</span>') +
        '</span>' +
      '</li>';
    }).join('');
    return '<ul class="timeline">' + list + '</ul>';
  }

  function milestoneHTML() {
    const dir = State.choice ? D.directions[State.choice.directionId] : null;
    if (!State.logs.length) {
      return '<p class="mile-empty">留下一条记录之后，这里会帮你整理一个里程碑草稿。它不会用连续天数或完成率来评价你。</p>';
    }
    if (!State.milestone) {
      return '<div class="row-actions"><button class="btn btn-ghost" type="button" data-action="generate-milestone">把这段时间整理成一个里程碑</button></div>' +
        '<p class="mile-empty">草稿会先给你看，只有你确认之后才会保存。</p>';
    }
    const m = State.milestone;
    const confirmed = m.status === 'confirmed';
    const hasNew = confirmed && State.logs.length > (m.evidenceLogIds || []).length;
    return '<div class="mile-card' + (confirmed ? ' confirmed' : '') + '">' +
      '<div class="mile-head">' +
        '<h4>' + esc(m.title) + '</h4>' +
        '<span class="badge' + (confirmed ? ' is-soft' : '') + '">' + (confirmed ? '已确认' : '待你确认') + '</span>' +
      '</div>' +
      '<p>' + esc(m.description) + '</p>' +
      '<p class="mile-evidence">依据 ' + (m.evidenceLogIds || []).length + ' 条真实记录 · ' + esc(fmt(m.createdAt)) + '</p>' +
      (confirmed
        ? (hasNew ? '<div class="mile-actions"><button class="btn btn-ghost" type="button" data-action="generate-milestone">有新的记录，重新整理</button></div>' : '')
        : '<div class="mile-actions">' +
            '<button class="btn btn-primary" type="button" data-action="confirm-milestone">确认并保存</button>' +
            '<button class="btn btn-quiet" type="button" data-action="discard-milestone">先不保存</button>' +
          '</div>') +
      '<p class="mile-empty">里程碑描述的是你的觉察或选择，而不是任务数量。' + (dir ? '它不会因为你暂停「' + esc(dir.title) + '」而失效。' : '') + '</p>' +
    '</div>';
  }

  function renderGrowth() {
    if (!State.record) { State.view = 'home'; render(); return; }
    if (!State.report) { goView('understand'); return; }

    const firstHit = State.record.primary && State.record.primary.hits[0];
    const clue = firstHit ? (firstHit.words[0] || firstHit.label) : '';
    const hint = clue
      ? '结合你提到的「' + clue + '」和上面那份理解，我想到这几个方向。'
      : '从你写下的内容和上面那份理解出发，我想到这几个方向。';
    const choice = State.choice;
    const direction = choice ? D.directions[choice.directionId] : null;
    const active = choice && choice.status === 'active';

    viewEl.innerHTML =
      '<div class="page-head">' +
        '<span class="kicker">板块三 · 行动与成长</span>' +
        '<h2>如果愿意，可以从这里开始</h2>' +
        '<p class="sub">' + esc(hint) + '这些是邀请，不是任务清单。你可以只看看，也可以暂时什么都不选。</p>' +
      '</div>' +
      directionsHTML() +
      '<p class="dir-note">暂时不选也完全可以。方向随时可以改，不需要给自己一个交代。</p>' +
      (choice && direction
        ? '<section class="card growth-panel" id="growthPanel">' +
            '<div class="panel-head">' +
              '<span class="kicker">你选择的方向</span>' +
              '<h3>' + esc(direction.title) + '</h3>' +
              (choice.status === 'paused' ? '<span class="badge">已暂停</span>' : '') +
            '</div>' +
            '<p>' + (active
              ? '下面这些是可以试试的小事，不是每日任务。做与不做，都不会影响任何评价。'
              : '这个方向现在停在这里，没有任何惩罚。你想继续时，随时可以继续。') + '</p>' +
            (active ? tasksHTML(direction) : '') +
            '<div class="milestone">' +
              '<h3 style="font-size:17px">你留下的记录</h3>' +
              logsHTML() +
              '<h3 style="font-size:17px;margin-top:24px">成长里程碑</h3>' +
              milestoneHTML() +
            '</div>' +
          '</section>'
        : '') +
  '<p class="disclaimer">这一板块不设打卡、积分、等级或排行榜。任务可以跳过，方向可以暂停，里程碑只有你确认后才会保存。</p>';
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

  function delay(ms) {
    return new Promise(function (resolve) { window.setTimeout(resolve, ms); });
  }

  function showLoader(messages, done) {
    const stop = startLoader(messages);
    window.setTimeout(function () {
      stop();
      if (State.failNext) {
        State.failNext = false;
        renderFailure();
      } else {
        done();
      }
    }, 2050);
  }

  function renderFailure() {
    viewEl.innerHTML = '<article class="card error-card">' +
      '<span class="kicker">生成中断</span>' +
      '<h2>这次没有生成成功</h2>' +
      '<p>已经完成的档案还在，不需要重新填写。</p>' +
      '<div class="row-actions">' +
        '<button class="btn btn-primary" type="button" data-action="retry">再试一次</button>' +
        '<button class="btn btn-quiet" type="button" data-action="go-home">先回首页</button>' +
      '</div>' +
    '</article>';
    announce('生成失败，可以重试');
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
    State.report = null;
    State.choice = null;
    State.logs = [];
    State.milestone = null;
    State.depth = 'present';
    State.originsText = '';
    State.pendingFeedback = null;
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
    State.report = null;
    State.choice = null;
    State.logs = [];
    State.milestone = null;
    State.depth = 'present';
    State.originsText = '';
    save();
    goView('understand');
    announce('已选定这个概念，进入理解与探索');
  }

  function doReport() {
    State.retry = 'report';
    const originsInput = document.getElementById('originsInput');
    if (originsInput) State.originsText = originsInput.value;
    const messages = ['正在重新读一遍你的档案', '把概念放回你的描述里', '整理哪些是事实，哪些是解释'];

    const apply = function (report) {
      State.report = report;
      save();
      State.view = 'understand';
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    if (State.failNext) {
      showLoader(messages, function () {});
      return;
    }

    if (!AI || !AI.available() || location.protocol === 'file:') {
      showLoader(messages, function () {
        apply(E.buildReport(State.record, State.depth, State.originsText));
      });
      return;
    }

    const stop = startLoader(messages);
    Promise.all([AI.report(State.record, State.depth, State.originsText), delay(1600)])
      .then(function (out) { stop(); apply(out[0]); })
      .catch(function () {
        stop();
        markAIFallback();
        toast('模型暂时不可用，已用本地规则生成报告');
        apply(E.buildReport(State.record, State.depth, State.originsText));
      });
  }

  function doMilestone() {
    State.retry = 'milestone';
    if (!State.logs.length) { toast('先留下一条记录'); return; }
    const direction = State.choice ? D.directions[State.choice.directionId] : null;
    showLoader(['正在回看你留下的记录', '只把真实发生过的事写进去'], function () {
      State.milestone = E.buildMilestone(State.logs, direction);
      save();
      State.view = 'growth';
      render();
      const panel = document.getElementById('growthPanel');
      if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  /* ---------------- 弹层 ---------------- */

  function openModal(html) {
    modalRoot.innerHTML = '<div class="modal" role="dialog" aria-modal="true">' + html + '</div>';
    modalRoot.hidden = false;
    document.body.style.overflow = 'hidden';
    const first = modalRoot.querySelector('.btn');
    if (first) first.focus();
  }

  function closeModal() {
    modalRoot.hidden = true;
    modalRoot.innerHTML = '';
    document.body.style.overflow = '';
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
      '<div style="margin-top:16px">' +
        '<div class="data-row"><span>识别结果</span><span>' + esc(concept ? concept.name + '（' + r.confidence + '）' : '尚未可靠命名') + '</span></div>' +
        '<div class="data-row"><span>创建时间</span><span>' + esc(fmt(r.createdAt)) + '</span></div>' +
        '<div class="data-row"><span>理解报告</span><span>' + (State.report ? esc(DEPTH_LABEL[State.report.depth] || '已生成') : '未生成') + '</span></div>' +
        '<div class="data-row"><span>成长记录</span><span>' + State.logs.length + ' 条' + (State.milestone ? ' · 里程碑' + (State.milestone.status === 'confirmed' ? '已确认' : '待确认') : '') + '</span></div>' +
      '</div>' +
      '<div class="row-actions">' +
        '<button class="btn btn-ghost" type="button" data-action="close-modal">关闭</button>' +
        '<button class="btn btn-quiet" type="button" data-action="delete-record">删除这条记录</button>' +
        '<button class="btn btn-quiet" type="button" data-action="wipe-all">清空全部数据</button>' +
      '</div>' +
      '<p style="font-size:12.5px;color:#8B8078;margin-top:16px">删除会同时移除对应的报告、成长记录和里程碑。</p>'
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
      case 'go-home':
        closeModal();
        goView('home');
        break;
      case 'step': {
        const target = el.getAttribute('data-target');
        if (target === 'identify' && State.record) { goView('identify'); break; }
        if (target === 'understand' && State.record && State.record.confirmed) { goView('understand'); break; }
        if (target === 'growth' && State.report) { goView('growth'); break; }
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
        goView((State.report || State.record.confirmed) ? 'understand' : 'identify');
        break;
      case 'depth': {
        State.depth = el.getAttribute('data-depth') || 'present';
        const ta = document.getElementById('originsInput');
        if (ta) State.originsText = ta.value;
        render();
        break;
      }
      case 'generate-report':
        doReport();
        break;
      case 'reset-report':
        State.report = null;
        save();
        render();
        break;
      case 'growth':
        goView('growth');
        break;
      case 'pick-direction':
        State.choice = {
          directionId: el.getAttribute('data-id'),
          status: 'active',
          selectedAt: Date.now()
        };
        State.pendingFeedback = null;
        save();
        render();
        (function () {
          const panel = document.getElementById('growthPanel');
          if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
        })();
        announce('已设为当前方向，可以随时暂停');
        break;
      case 'pause-direction':
        if (State.choice) {
          State.choice.status = 'paused';
          State.pendingFeedback = null;
          save();
          render();
          announce('方向已暂停，没有产生任何负面记录');
        }
        break;
      case 'resume-direction':
        if (State.choice) {
          State.choice.status = 'active';
          save();
          render();
          announce('方向已继续');
        }
        break;
      case 'feedback':
        State.pendingFeedback = {
          taskId: el.getAttribute('data-task'),
          feedback: el.getAttribute('data-feedback')
        };
        render();
        break;
      case 'cancel-log':
        State.pendingFeedback = null;
        render();
        break;
      case 'save-log': {
        const input = document.getElementById('reflectionInput');
        const reflection = input ? input.value.trim() : '';
        if (!State.pendingFeedback || !State.choice) break;
        State.logs.push({
          id: 'log_' + Date.now().toString(36),
          directionId: State.choice.directionId,
          taskId: State.pendingFeedback.taskId,
          feedback: State.pendingFeedback.feedback,
          reflection: reflection,
          createdAt: Date.now()
        });
        State.pendingFeedback = null;
        save();
        render();
        announce('记录已保存');
        break;
      }
      case 'generate-milestone':
        doMilestone();
        break;
      case 'confirm-milestone':
        if (State.milestone) {
          State.milestone.status = 'confirmed';
          State.milestone.confirmedAt = Date.now();
          save();
          render();
          announce('里程碑已确认保存');
        }
        break;
      case 'discard-milestone':
        State.milestone = null;
        save();
        render();
        break;
      case 'retry':
        if (State.retry === 'report') doReport();
        else if (State.retry === 'milestone') doMilestone();
        else goView('home');
        break;
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
    demoToggle.setAttribute('aria-expanded', 'false');
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
    if (e.target.id === 'originsInput') State.originsText = e.target.value;
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !modalRoot.hidden) closeModal();
  });

  modalRoot.addEventListener('click', function (e) {
    if (e.target === modalRoot) closeModal();
  });

  demoToggle.addEventListener('click', function () {
    const open = demoPanel.hidden;
    demoPanel.hidden = !open;
    demoToggle.setAttribute('aria-expanded', String(open));
  });

  /* ---------------- 启动 ---------------- */

  load();
  render();

  if (location.protocol === 'file:') {
    const el = document.getElementById('aiStatus');
    if (el) el.textContent = '模型：本地规则模式（需 node 启动）';
  } else if (AI) {
    AI.check().then(updateAIStatus);
  } else {
    updateAIStatus();
  }
})();
