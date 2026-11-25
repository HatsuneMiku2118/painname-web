const store = require('../../utils/store');
const E = require('../../utils/engine');
const AI = require('../../utils/ai');

const DEPTHS = [
  { key: 'present', letter: 'A', title: '理解当下', desc: '看看现在的情绪、想法和行为，是怎么互相维持的' },
  { key: 'origins', letter: 'B', title: '探索形成因素', desc: '如果你愿意，看看更早的经历可能留下了什么' },
  { key: 'combined', letter: 'C', title: '两者结合', desc: '先理解当下，再去看可能的形成因素' }
];

const DEPTH_LABEL = {
  present: '理解当下',
  origins: '探索形成因素',
  combined: '先理解当下，再看形成因素'
};

function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function paragraph(text) {
  return '<p style="margin:0 0 14px;font-size:15px;line-height:1.95;color:#544B44;">' + esc(text) + '</p>';
}

function paragraphs(list) {
  return (list || []).map(paragraph).join('');
}

function block(title, items, colors) {
  const list = (items || []).map(function (item) {
    return '<li style="margin-bottom:8px;">' + esc(item) + '</li>';
  }).join('');
  return '<div style="padding:16px 18px;border:1px solid ' + colors.border + ';border-radius:12px;background:' + colors.bg + ';margin-bottom:12px;">' +
    '<p style="margin:0 0 8px;font-size:12px;letter-spacing:1px;font-weight:600;color:' + colors.text + ';">' + esc(title) + '</p>' +
    '<ul style="margin:0;padding-left:20px;font-size:14px;line-height:1.85;color:#544B44;">' + list + '</ul>' +
    '</div>';
}

Page({
  data: {
    hasReport: false,
    depth: 'present',
    needsOrigins: false,
    originsText: '',
    depths: DEPTHS,
    reportView: null,
    sourcesIndex: '',
    showSources: false
  },

  onShow() {
    store.hydrate();
    const state = store.get();
    if (!state.record) {
      my.redirectTo({ url: '/pages/index/index' });
      return;
    }
    if (!state.report && !state.record.confirmed) {
      my.redirectTo({ url: '/pages/identify/identify' });
      return;
    }
    if (state.report) {
      this.setData({
        hasReport: true,
        depth: state.report.depth,
        reportView: this.buildReportView(state.report)
      });
      return;
    }
    const depth = state.depth || 'present';
    this.setData({
      hasReport: false,
      depth: depth,
      needsOrigins: depth === 'origins' || depth === 'combined',
      originsText: state.originsText || ''
    });
  },

  onDepth(e) {
    const depth = e.currentTarget.dataset.depth;
    store.setDepth(depth);
    this.setData({
      depth: depth,
      needsOrigins: depth === 'origins' || depth === 'combined'
    });
  },

  onOrigins(e) {
    const value = e.detail.value || '';
    store.setOriginsText(value);
    this.setData({ originsText: value });
  },

  onGenerate() {
    if (this.busy) return;
    const state = store.get();
    const depth = this.data.depth;
    const origins = this.data.originsText;

    if (AI.available()) {
      this.busy = true;
      my.showLoading({ content: '正在整理你的理解报告' });
      AI.report(state.record, depth, origins)
        .then((report) => {
          this.finishReport(report, false);
        })
        .catch(() => {
          this.finishReport(E.buildReport(state.record, depth, origins), true);
        });
      return;
    }

    my.showLoading({ content: '正在整理你的理解报告' });
    setTimeout(() => {
      this.finishReport(E.buildReport(state.record, depth, origins), false);
    }, 800);
  },

  finishReport(report, fallback) {
    this.busy = false;
    store.setReport(report);
    my.hideLoading();
    if (fallback) {
      my.showToast({ content: '模型暂时不可用，已用本地规则生成报告', type: 'none' });
    }
    this.setData({
      hasReport: true,
      reportView: this.buildReportView(report),
      showSources: false
    });
    my.pageScrollTo({ scrollTop: 0 });
  },

  buildReportView(report) {
    const concept = report.conceptId ? E.conceptById[report.conceptId] : null;
    const sections = [];

    sections.push({
      index: '01',
      title: '这个痛苦叫什么',
      html: paragraphs(report.explain) +
        (concept ? '<p style="margin:0;font-size:13px;line-height:1.9;color:#8B8078;">专业定义：' + esc(concept.definition) + '</p>' : '')
    });

    if (report.mechanism && report.mechanism.length) {
      const cycle = (report.cycle || []).map(function (step) {
        return '<li style="margin-bottom:10px;">' + esc(step) + '</li>';
      }).join('');
      sections.push({
        index: '02',
        title: '它是怎么维持的',
        html: paragraphs(report.mechanism) +
          (cycle ? '<ol style="margin:12px 0 0;padding-left:22px;border-left:1px solid #D9C9BA;font-size:14px;line-height:1.85;color:#544B44;">' + cycle + '</ol>' : '')
      });
    }

    const links = (report.links || []).map(function (link) {
      const tag = link.certainty === 'fact'
        ? '<span style="display:inline-block;padding:1px 8px;border-radius:20px;font-size:11px;background:#E9EFE5;color:#5F7259;border:1px solid #D8E2D2;">你提到的</span>'
        : (link.certainty === 'guess'
          ? '<span style="display:inline-block;padding:1px 8px;border-radius:20px;font-size:11px;background:#fff;color:#8B8078;border:1px dashed #D9C9BA;">推测</span>'
          : '<span style="display:inline-block;padding:1px 8px;border-radius:20px;font-size:11px;background:#F6EBD8;color:#94702F;border:1px solid #EBD9BB;">理论解释</span>');
      return '<div style="padding:14px 16px;border:1px solid #E7DCD1;border-radius:12px;background:#FFFDFA;margin-bottom:10px;">' +
        '<p style="margin:0 0 8px;font-family:serif;font-size:15px;line-height:1.85;color:#231E1A;">「' + esc(E.clip(link.fact, 80)) + '」</p>' +
        '<p style="margin:0;font-size:14px;line-height:1.85;color:#544B44;">' + tag + ' ' + esc(link.interpretation) + '</p>' +
        '</div>';
    }).join('');
    sections.push({
      index: '03',
      title: '它在你身上长什么样',
      html: links || paragraph('这一段暂时没有可以对应到具体线索的内容。')
    });

    if (report.depth === 'origins' || report.depth === 'combined') {
      const questions = !report.origins.provided
        ? '<p style="margin:14px 0 8px;font-size:13px;color:#8B8078;">可以从这些问题开始，也可以完全跳过：</p>' +
          '<ul style="margin:0;padding-left:20px;font-size:14px;line-height:1.9;color:#544B44;">' +
          report.origins.questions.map(function (q) { return '<li style="margin-bottom:6px;">' + esc(q) + '</li>'; }).join('') +
          '</ul>'
        : '';
      sections.push({
        index: '04',
        title: '更早的经历，可能留下了什么',
        html: paragraph(report.origins.paragraph) + questions +
          '<p style="margin:12px 0 0;font-size:13px;color:#6B7A83;">待探索 · 这一节不是诊断，也不代表过去一定发生了什么。</p>'
      });
    }

    sections.push({
      index: report.depth === 'present' ? '04' : '05',
      title: '哪些是事实，哪些是解释',
      html: block('事实 · 你自己说过的', report.facts.length ? report.facts : ['你在描述里没有明确写出可以单独列出的事实。'], { bg: '#FAFCF8', border: '#DFE7D9', text: '#5F7259' }) +
        block('解释 · 基于理论的可能理解', report.hypotheses.length ? report.hypotheses : ['目前没有足够的依据给出理论解释。'], { bg: '#FDFAF3', border: '#EEE1CB', text: '#94702F' }) +
        block('未知 · 现在还无法确定的', report.unknowns, { bg: '#F9FBFC', border: '#E0E7EA', text: '#6B7A83' })
    });

    sections.push({
      index: report.depth === 'present' ? '05' : '06',
      title: '把它重新说一遍',
      html: '<p style="margin:0;font-family:serif;font-size:17px;line-height:2;color:#231E1A;">' + esc(report.summary) + '</p>'
    });

    return {
      title: concept ? '关于「' + concept.name + '」的一份理解' : '关于这份感受的一份理解',
      subtitle: concept ? '它描述的是：' + concept.plain : '',
      meta: DEPTH_LABEL[report.depth] + ' · 基于你在板块一写下的内容' + (report.aiUsed ? ' · 模型生成' : ''),
      banner: report.status !== 'identified' ? '这份报告建立在有限的信息上。它更像一个可以讨论的方向，而不是结论。' : '',
      sections: sections,
      sourcesIndex: report.depth === 'present' ? '06' : '07',
      sources: report.sources || [],
      limits: report.limits || ''
    };
  },

  onToggleSources() {
    this.setData({ showSources: !this.data.showSources });
  },

  onReset() {
    const state = store.get();
    store.setReport(null);
    const depth = state.depth || 'present';
    this.setData({
      hasReport: false,
      reportView: null,
      showSources: false,
      depth: depth,
      needsOrigins: depth === 'origins' || depth === 'combined',
      originsText: state.originsText || ''
    });
    my.pageScrollTo({ scrollTop: 0 });
  },

  onGrowth() {
    my.navigateTo({ url: '/pages/growth/growth' });
  },

  onBackIdentify() {
    my.navigateBack({ delta: 1 });
  }
});
