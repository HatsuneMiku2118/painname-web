const store = require('./utils/store');

App({
  onLaunch() {
    store.hydrate();
  },
  onShow() {
    store.hydrate();
  },
  onError(err) {
    console.error('app error', err);
  }
});
