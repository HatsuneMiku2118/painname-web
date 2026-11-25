Component({
  props: {
    current: 1,
    done1: false,
    done2: false,
    done3: false,
    enabled2: false,
    enabled3: false
  },

  methods: {
    go(url) {
      if (!url) return;
      const pages = getCurrentPages();
      const top = pages.length ? pages[pages.length - 1] : null;
      const route = top && top.route ? '/' + top.route.replace(/^\/+/, '') : '';
      if (route === url) return;
      my.redirectTo({ url: url });
    },

    onIdentify() {
      this.go('/pages/index/index');
    },

    onUnderstand() {
      if (!this.props.enabled2) return;
      this.go('/pages/understand/understand');
    },

    onGrowth() {
      if (!this.props.enabled3) return;
      this.go('/pages/growth/growth');
    }
  }
});
