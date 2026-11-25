const D = require('../data/concepts');

/**
 * 高风险表达的兜底：不继续普通流程，优先给出可拨打的现实支持。
 * 小程序内拨号必须由用户点击触发，因此用 confirm 的确认按钮承接。
 */
function show() {
  const crisis = D.crisis;
  const lines = crisis.actions.map((item) => item.label + '：' + item.value).join('\n');
  my.confirm({
    title: crisis.title,
    content: crisis.body + '\n\n' + lines + '\n\n' + crisis.footer,
    confirmButtonText: '拨打 12356',
    cancelButtonText: '我知道了',
    success: (res) => {
      if (res.confirm) my.makePhoneCall({ number: '12356' });
    }
  });
}

module.exports = { show: show };
