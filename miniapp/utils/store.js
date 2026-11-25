const KEY = 'painname_v1';

const state = {
  record: null,
  report: null,
  choice: null,
  logs: [],
  milestone: null,
  depth: 'present',
  originsText: ''
};

function snapshot() {
  return {
    record: state.record,
    report: state.report,
    choice: state.choice,
    logs: state.logs,
    milestone: state.milestone,
    depth: state.depth,
    originsText: state.originsText,
    updatedAt: Date.now()
  };
}

function hydrate() {
  try {
    if (typeof my === 'undefined') return state;
    const res = my.getStorageSync({ key: KEY });
    const data = res && res.data;
    if (data && typeof data === 'object') {
      state.record = data.record || null;
      state.report = data.report || null;
      state.choice = data.choice || null;
      state.logs = data.logs || [];
      state.milestone = data.milestone || null;
      state.depth = data.depth || 'present';
      state.originsText = data.originsText || '';
    }
  } catch (err) {
    // 存储不可用时保持内存态
  }
  return state;
}

function persist() {
  try {
    if (typeof my !== 'undefined') {
      my.setStorageSync({ key: KEY, data: snapshot() });
    }
  } catch (err) {
    // 静默降级
  }
}

function get() {
  return state;
}

function setRecord(record) {
  state.record = record;
  state.report = null;
  state.choice = null;
  state.logs = [];
  state.milestone = null;
  state.depth = 'present';
  state.originsText = '';
  persist();
}

function updateRecord(record) {
  state.record = record;
  persist();
}

function setReport(report) {
  state.report = report;
  persist();
}

function setChoice(choice) {
  state.choice = choice;
  persist();
}

function addLog(log) {
  state.logs.push(log);
  persist();
}

function setMilestone(milestone) {
  state.milestone = milestone;
  persist();
}

function setDepth(depth) {
  state.depth = depth;
  persist();
}

function setOriginsText(text) {
  state.originsText = text;
}

function reset() {
  state.record = null;
  state.report = null;
  state.choice = null;
  state.logs = [];
  state.milestone = null;
  state.depth = 'present';
  state.originsText = '';
  persist();
}

module.exports = {
  hydrate: hydrate,
  persist: persist,
  get: get,
  setRecord: setRecord,
  updateRecord: updateRecord,
  setReport: setReport,
  setChoice: setChoice,
  addLog: addLog,
  setMilestone: setMilestone,
  setDepth: setDepth,
  setOriginsText: setOriginsText,
  reset: reset
};
