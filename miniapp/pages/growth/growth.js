const store = require('../../utils/store');
const E = require('../../utils/engine');
const D = require('../../data/concepts');

function fmtTime(ts) {
  const d = new Date(ts);
  const pad = (v) => (v < 10 ? '0' + v : String(v));
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

Page({
  data: {
    hint: '',
    directions: [],
    choice: null,
    activeDirection: null,
    active: false,
    logs: [],
    hasLogs: false,
    milestone: null,
    pendingTaskId: '',
    pendingFeedback: '',
    feedbackDone: E.feedbackLabel.done,
    feedbackTried: E.feedbackLabel.tried,
    feedbackLater: E.feedbackLabel.later
  },

  onShow() {
    store.hydrate();
    const state = store.get();
    if (!state.record) {
      my.redirectTo({ url: '/pages/index/index' });
      return;
    }
    if (!state.report) {
      my.redirectTo({ url: '/pages/understand/understand' });
      return;
    }
    this.draftReflection = '';
    this.present();
  },

  present() {
    const state = store.get();
    const choice = state.choice;
    const list = E.directionsFor(state.record);

    const directions = list.map(function (direction) {
      const selected = choice && choice.directionId === direction.id;
      let action = 'select';
      let actionLabel = '设为当前方向';
      if (selected) {
        if (choice.status === 'active') {
          action = 'pause';
          actionLabel = '暂时暂停这个方向';
        } else {
          action = 'resume';
          actionLabel = '继续这个方向';
        }
      }
      return {
        id: direction.id,
        title: direction.title,
        description: direction.description,
        scene: direction.scene,
        change: direction.change,
        selected: selected,
        action: action,
        actionLabel: actionLabel
      };
    });

    let activeDirection = null;
    let active = false;
    if (choice) {
      const raw = D.directions[choice.directionId];
      if (raw) {
        activeDirection = {
          id: raw.id,
          title: raw.title,
          tasks: raw.tasks
        };
        active = choice.status === 'active';
      }
    }

    const logs = state.logs.slice().reverse().map(function (log) {
      return {
        id: log.id,
        time: fmtTime(log.createdAt),
        feedback: E.feedbackLabel[log.feedback] || '记录',
        reflection: log.reflection || ''
      };
    });

    let milestone = null;
    if (state.milestone) {
      milestone = {
        title: state.milestone.title,
        description: state.milestone.description,
        evidenceCount: (state.milestone.evidenceLogIds || []).length,
        time: fmtTime(state.milestone.createdAt),
        confirmed: state.milestone.status === 'confirmed'
      };
    }

    const firstHit = state.record.primary && state.record.primary.hits && state.record.primary.hits[0];
    const hint = firstHit && firstHit.words && firstHit.words.length
      ? '结合你提到的「' + firstHit.words[0] + '」和上面那份理解，我想到这几个方向。'
      : '从你写下的内容和上面那份理解出发，我想到这几个方向。';

    this.setData({
      hint: hint,
      directions: directions,
      choice: choice,
      activeDirection: activeDirection,
      active: active,
      logs: logs,
      hasLogs: logs.length > 0,
      milestone: milestone,
      pendingTaskId: '',
      pendingFeedback: ''
    });
  },

  onDirectionAction(e) {
    const id = e.currentTarget.dataset.id;
    const action = e.currentTarget.dataset.action;
    if (action === 'select') {
      store.setChoice({ directionId: id, status: 'active', selectedAt: Date.now() });
      this.present();
      my.showToast({ content: '已设为当前方向，可以随时暂停', type: 'none' });
      return;
    }
    const choice = store.get().choice;
    if (!choice) return;
    if (action === 'pause') {
      choice.status = 'paused';
      store.setChoice(choice);
      this.present();
      my.showToast({ content: '方向已暂停，没有产生任何负面记录', type: 'none' });
      return;
    }
    if (action === 'resume') {
      choice.status = 'active';
      store.setChoice(choice);
      this.present();
    }
  },

  onFeedback(e) {
    this.setData({
      pendingTaskId: e.currentTarget.dataset.task,
      pendingFeedback: e.currentTarget.dataset.feedback
    });
  },

  onReflection(e) {
    this.draftReflection = e.detail.value || '';
  },

  onCancelLog() {
    this.draftReflection = '';
    this.setData({ pendingTaskId: '', pendingFeedback: '' });
  },

  onSaveLog() {
    const state = store.get();
    if (!state.choice || !this.data.pendingTaskId) return;
    store.addLog({
      id: 'log_' + Date.now().toString(36),
      directionId: state.choice.directionId,
      taskId: this.data.pendingTaskId,
      feedback: this.data.pendingFeedback,
      reflection: (this.draftReflection || '').trim(),
      createdAt: Date.now()
    });
    this.draftReflection = '';
    this.present();
    my.showToast({ content: '记录已保存', type: 'none' });
  },

  onMilestone() {
    const state = store.get();
    if (!state.logs.length) {
      my.showToast({ content: '先留下一条记录', type: 'none' });
      return;
    }
    const direction = state.choice ? D.directions[state.choice.directionId] : null;
    my.showLoading({ content: '正在回看你留下的记录' });
    setTimeout(() => {
      store.setMilestone(E.buildMilestone(state.logs, direction));
      my.hideLoading();
      this.present();
      my.pageScrollTo({ scrollTop: 900 });
    }, 700);
  },

  onConfirmMilestone() {
    const state = store.get();
    if (!state.milestone) return;
    state.milestone.status = 'confirmed';
    state.milestone.confirmedAt = Date.now();
    store.setMilestone(state.milestone);
    this.present();
    my.showToast({ content: '里程碑已确认保存', type: 'none' });
  },

  onDiscardMilestone() {
    store.setMilestone(null);
    this.present();
  },

  onBackReport() {
    my.navigateBack({ delta: 1 });
  }
});
