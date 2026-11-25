const store = require('../../utils/store');
const E = require('../../utils/engine');
const AI = require('../../utils/ai');
const crisis = require('../../utils/crisis');

const CHIPS = [
  { label: '恋爱中的不安', text: '他几个小时没有回我消息，我一直看手机，担心他其实没那么在乎我。' },
  { label: '暧昧中的不确定', text: '我们暧昧了三个月，他从来不明确说我们算什么。我每天都在猜他的意思，又不敢问。' },
  { label: '分手后的不舍', text: '分手两周了，我还是会反复想起以前的细节，不知道自己现在想要什么。' },
  { label: '关系中的自我怀疑', text: '每次他不高兴，我都在想是不是我太敏感、要求太多。我不敢提自己的需要。' }
];

Page({
  data: {
    raw: '',
    count: 0,
    chips: CHIPS,
    hasRecord: false,
    hasReport: false,
    hasLogs: false,
    canUnderstand: false,
    continueLabel: '继续上次的识别',
    resumeText: '',
    aiLabel: ''
  },

  onShow() {
    store.hydrate();
    const ai = AI.state();
    this.setData({
      aiLabel: ai.configured ? '引擎：模型 ' + (ai.model || '已启用') : '引擎：本地规则'
    });
    this.refreshResume();
  },

  refreshResume() {
    const state = store.get();
    const understood = !!(state.report || (state.record && state.record.confirmed));
    this.setData({
      hasRecord: !!state.record,
      hasReport: !!state.report,
      hasLogs: state.logs.length > 0,
      canUnderstand: !!(state.record && state.record.confirmed),
      continueLabel: understood ? '继续上次的理解' : '继续上次的识别',
      resumeText: state.record ? '「' + E.clip(state.record.raw, 42) + '」' : ''
    });
  },

  onInput(e) {
    const value = e.detail.value || '';
    this.setData({ raw: value, count: value.length });
  },

  onChip(e) {
    const text = e.currentTarget.dataset.text || '';
    this.setData({ raw: text, count: text.length });
  },

  onSubmit() {
    if (this.busy) return;
    const raw = (this.data.raw || '').trim();
    if (raw.length < 2) {
      my.showToast({ content: '可以再多写一点点，哪怕一句', type: 'none' });
      return;
    }
    if (E.detectCrisis(raw)) {
      crisis.show();
      return;
    }

    this.busy = true;
    my.showLoading({ content: '正在读你写下的内容' });
    setTimeout(() => {
      this.busy = false;
      store.setRecord(E.buildDraft(raw));
      my.hideLoading();
      my.navigateTo({ url: '/pages/identify/identify' });
    }, 450);
  },

  onContinue() {
    const state = store.get();
    const understood = !!(state.report || (state.record && state.record.confirmed));
    my.navigateTo({ url: understood ? '/pages/understand/understand' : '/pages/identify/identify' });
  },

  onRestart() {
    store.reset();
    this.setData({ hasRecord: false, hasReport: false, hasLogs: false, raw: '', count: 0, resumeText: '' });
    my.showToast({ content: '已开始新的描述', type: 'none' });
  },

  onPrivacy() {
    const ai = AI.state();
    const modeLine = ai.configured
      ? '当前已连接模型（' + (ai.model || '已启用') + '），你输入的文字会发送给模型服务商用于本次生成。'
      : '当前使用本地规则引擎，输入内容不会离开本机。';
    my.alert({
      title: '关于你的内容',
      content: '这是原型版本。你写下的描述、档案、报告和记录只保存在本机的小程序存储里。' + modeLine + '服务端只转发请求、不保存原文；请求失败会自动改用本地规则。你可以在「我的档案」里清空全部数据。这不是心理诊断、心理治疗或危机干预服务。'
    });
  },

  onArchive() {
    const state = store.get();
    if (!state.record) {
      my.alert({ title: '我的档案', content: '你写下第一段描述之后，这里会保存对应的痛苦分析档案与后续记录。' });
      return;
    }
    const concept = state.record.primary ? E.conceptById[state.record.primary.conceptId] : null;
    const text = '识别结果：' + (concept ? concept.name : '尚未可靠命名') +
      '\n理解报告：' + (state.report ? '已生成' : '未生成') +
      '\n成长记录：' + state.logs.length + ' 条' +
      (state.milestone ? ' · 里程碑' + (state.milestone.status === 'confirmed' ? '已确认' : '待确认') : '') +
      '\n\n清空后不可恢复。';
    my.confirm({
      title: '我的档案',
      content: text,
      confirmButtonText: '清空全部',
      cancelButtonText: '关闭',
      success: (res) => {
        if (res.confirm) {
          store.reset();
          this.setData({ hasRecord: false, hasReport: false, hasLogs: false, resumeText: '' });
          my.showToast({ content: '已清空全部本地数据', type: 'none' });
        }
      }
    });
  }
});
