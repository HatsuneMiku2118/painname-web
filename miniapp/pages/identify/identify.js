const store = require('../../utils/store');
const E = require('../../utils/engine');
const AI = require('../../utils/ai');
const crisis = require('../../utils/crisis');

Page({
  data: {
    thread: [],
    question: null,
    options: [],
    askedCount: 0,
    total: 6,
    progressText: '',
    thinking: false,
    followMode: false,
    candidates: [],
    status: '',
    confirmed: false,
    concept: null,
    fallbackMissing: [],
    canChange: false,
    hasReport: false,
    hasLogs: false,
    say: '',
    extra: ''
  },

  onShow() {
    store.hydrate();
    const state = store.get();
    if (!state.record) {
      my.redirectTo({ url: '/pages/index/index' });
      return;
    }

    const record = state.record;
    // 兼容旧版本记录
    if ((record.status === 'identified' || record.status === 'uncertain') && record.confirmed === undefined) {
      record.confirmed = true;
      store.updateRecord(record);
    }
    // 固定问题已问完但还没收尾时，补一次本地收尾
    if (record.status === 'collecting' && !E.nextQuestion(record)) {
      E.finishChat(record);
      store.updateRecord(record);
    }
    // 上次停留在等待模型时刷新页面，退回本地结果
    if (record.status === 'thinking') {
      E.finishChat(record);
      store.updateRecord(record);
    }

    this.setData({
      hasReport: !!state.report,
      hasLogs: state.logs.length > 0
    });
    this.present(record);
    my.pageScrollTo({ scrollTop: 9999, duration: 0 });
  },

  present(record) {
    const answers = record.answers || [];
    const thread = [{ role: 'user', text: record.raw, skip: false }];

    answers.forEach((a) => {
      const meta = E.chatQuestion(a.key);
      const qText = a.question || (meta ? meta.text : '');
      if (qText) thread.push({ role: 'ai', text: qText, skip: false });
      thread.push({ role: 'user', text: a.skipped ? '这题先跳过' : a.text, skip: !!a.skipped });
    });

    let question = null;
    if (record.status === 'followup') question = E.currentAiQuestion(record);
    else if (record.status === 'collecting') question = E.nextQuestion(record);

    const concept = record.primary ? E.conceptById[record.primary.conceptId] : null;
    const fixedCount = answers.filter((a) => String(a.key).indexOf('ai') !== 0).length;
    const aiCount = answers.length - fixedCount;
    const progressText = record.status === 'followup'
      ? '再确认 ' + (aiCount + 1) + ' / ' + Math.max((record.aiQuestions || []).length, aiCount + 1) + ' 个'
      : '已问 ' + fixedCount + ' / 最多 6 个';

    this.setData({
      thread: thread,
      question: question,
      options: question ? question.options : [],
      askedCount: fixedCount,
      total: 6,
      progressText: progressText,
      thinking: record.status === 'thinking',
      followMode: record.status === 'followup',
      candidates: record.candidates || [],
      status: record.status,
      confirmed: !!record.confirmed,
      concept: concept ? { name: concept.name, plain: concept.plain } : null,
      fallbackMissing: E.missingLabels(record),
      canChange: !!(record.candidates && record.candidates.length)
    });
  },

  requestIdentify(round) {
    const record = store.get().record;
    if (!record) return;

    if (!AI.available()) {
      this.fallbackLocal(record);
      return;
    }

    record.status = 'thinking';
    store.updateRecord(record);
    this.present(record);
    my.pageScrollTo({ scrollTop: 9999, duration: 200 });

    AI.identify({
      raw: record.raw,
      answers: (record.answers || []).map((a) => ({ key: a.key, text: a.text, skipped: !!a.skipped })),
      askedQuestions: (record.answers || []).map((a) => a.question).filter(Boolean),
      followUpRounds: round
    }).then((res) => {
      const current = store.get().record;
      if (!current || current.id !== record.id) return;

      if (res.followUps.length && round < 1) {
        E.setAiFollowUps(current, res.followUps);
        store.updateRecord(current);
        this.present(current);
        my.pageScrollTo({ scrollTop: 9999, duration: 200 });
        return;
      }

      if (res.candidates.length) {
        E.applyAiCandidates(current, res.candidates, res.confidence, res.note);
      } else {
        current.candidates = [];
        current.aiConfidence = res.confidence;
        current.aiNote = res.note;
        current.followUpDone = true;
        current.chatDone = true;
        current.status = 'insufficient_information';
      }

      store.updateRecord(current);
      this.present(current);
      my.pageScrollTo({ scrollTop: 9999, duration: 200 });
    }).catch(() => {
      my.showToast({ content: '模型暂时不可用，已用本地规则识别', type: 'none' });
      this.fallbackLocal(store.get().record);
    });
  },

  fallbackLocal(record) {
    if (!record) return;
    E.finishChat(record);
    store.updateRecord(record);
    this.present(record);
    my.pageScrollTo({ scrollTop: 9999, duration: 200 });
  },

  onSayInput(e) {
    this.setData({ say: e.detail.value || '' });
  },

  onExtraInput(e) {
    this.setData({ extra: e.detail.value || '' });
  },

  answer(text, skipped) {
    const record = store.get().record;
    if (!record) return;
    const follow = record.status === 'followup';
    if (!follow && record.status !== 'collecting') return;

    const q = follow ? E.currentAiQuestion(record) : E.nextQuestion(record);
    if (!q) return;

    if (!skipped && !String(text || '').trim()) {
      my.showToast({ content: '可以写一句，或点上面的选项', type: 'none' });
      return;
    }
    if (E.detectCrisis((record.raw || '') + ' ' + (text || ''))) {
      crisis.show();
      return;
    }

    if (follow) {
      E.addAiAnswer(record, text, skipped, q.text);
      store.updateRecord(record);
      this.setData({ say: '' });
      if (!E.currentAiQuestion(record)) {
        this.requestIdentify(1);
        return;
      }
      this.present(record);
      my.pageScrollTo({ scrollTop: 9999, duration: 200 });
      return;
    }

    E.addAnswer(record, q.key, text, skipped, q.text);
    store.updateRecord(record);
    this.setData({ say: '' });

    if (!E.nextQuestion(record)) {
      this.requestIdentify(0);
      return;
    }

    this.present(record);
    my.pageScrollTo({ scrollTop: 9999, duration: 200 });
  },

  onOption(e) {
    this.answer(e.currentTarget.dataset.text || '', false);
  },

  onSkip() {
    this.answer('', true);
  },

  onSend() {
    this.answer((this.data.say || '').trim(), false);
  },

  onChoose(e) {
    const id = e.currentTarget.dataset.id;
    const record = store.get().record;
    if (!record || !id) return;
    store.updateRecord(E.chooseConcept(record, id));
    my.navigateTo({ url: '/pages/understand/understand' });
  },

  onMore() {
    const extra = (this.data.extra || '').trim();
    if (!extra) {
      my.showToast({ content: '可以再写一句', type: 'none' });
      return;
    }
    if (E.detectCrisis(extra)) {
      crisis.show();
      return;
    }
    const record = store.get().record;
    E.continueRecord(record, extra);
    store.updateRecord(record);
    this.setData({ extra: '' });
    this.present(record);
    my.pageScrollTo({ scrollTop: 0 });
  },

  onChangeCandidate() {
    const record = store.get().record;
    if (!record) return;
    record.confirmed = false;
    record.primary = null;
    store.updateRecord(record);
    this.present(record);
    my.pageScrollTo({ scrollTop: 0 });
  },

  onContinue() {
    my.navigateTo({ url: '/pages/understand/understand' });
  },

  onRestart() {
    store.reset();
    my.redirectTo({ url: '/pages/index/index' });
  }
});
