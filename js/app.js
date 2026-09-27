/* ============================================
   App - 主控制器 / 路由 / 初始化
   全站 SPA 路由、导航切换、数据加载
   ============================================ */

const App = {
  currentPage: 'timeline',

  /* 是否已经渲染过一次。用来区分「首次进入」和「同页重渲染」——
     只有前者该播入场动画。 */
  _renderedOnce: false,

  pages: {
    timeline: { title: '时间线', render: (c) => Timeline.render(c) },
    dashboard: { title: '仪表盘', render: (c) => Dashboard.render(c) },
    diary: { title: '日记', render: (c) => Diary.renderDiaryPage(c) },
    study: { title: '学习', render: (c) => Study.renderStudyPage(c) },
    schedule: { title: '日程', render: (c) => Extras.renderSchedulePage(c) },
    goals: { title: '目标', render: (c) => Extras.renderGoalsPage(c) },
    settings: { title: '设置', render: (c) => Settings.render(c) }
  },

  init() {
    /* 初始化各模块 */
    Settings.init();

    /* 更新日期显示 */
    this.updateHeaderDate();

    /* 设置路由监听 */
    this.setupRouter();

    /* 设置导航事件 */
    this.setupNavigation();

    /* 设置主题切换 */
    this.setupThemeToggle();

    /* 设置菜单切换（移动端） */
    this.setupMenuToggle();

    /* 根据 hash 导航到对应页面 */
    const hash = location.hash.slice(1) || '/timeline';
    const page = hash.replace('/', '');
    this.navigate(this.pages[page] ? page : 'timeline');

    /* 每分钟更新日期 */
    setInterval(() => this.updateHeaderDate(), 60000);
  },

  setupRouter() {
    window.addEventListener('hashchange', () => {
      const hash = location.hash.slice(1) || '/timeline';
      const page = hash.replace('/', '');
      if (this.pages[page]) {
        this.navigate(page);
      }
    });
  },

  setupNavigation() {
    /* 侧边导航点击 */
    document.querySelectorAll('.nav-item, .bottom-nav-item').forEach(el => {
      el.addEventListener('click', (e) => {
        const page = el.dataset.page;
        if (page && this.pages[page]) {
          /* 关闭移动端侧栏 */
          document.getElementById('sidebar')?.classList.remove('open');
          document.getElementById('sidebar-overlay')?.classList.remove('open');
        }
      });
    });
  },

  setupThemeToggle() {
    document.getElementById('theme-toggle')?.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      const next = current === 'dark' ? 'light' : 'dark';
      Settings.updateConfig({ theme: next });
      App.refresh();
    });
  },

  setupMenuToggle() {
    const toggle = document.getElementById('menu-toggle');
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    if (toggle && sidebar && overlay) {
      toggle.addEventListener('click', () => {
        sidebar.classList.toggle('open');
        overlay.classList.toggle('open');
      });
      overlay.addEventListener('click', () => {
        sidebar.classList.remove('open');
        overlay.classList.remove('open');
      });
    }
  },

  navigate(page) {
    if (!this.pages[page]) page = 'timeline';

    /* 换页才播入场动画。同一个页面重渲染（写完一条推进记录之类）不播 ——
       否则每写一笔，整屏卡片就一起重播一次位移，眼睛很难受。 */
    const switching = !this._renderedOnce || page !== this.currentPage;

    this.currentPage = page;

    /* 更新页面标题 */
    document.getElementById('page-title').textContent = this.pages[page].title;

    /* 更新导航高亮 */
    document.querySelectorAll('.nav-item, .bottom-nav-item').forEach(el => {
      el.classList.toggle('active', el.dataset.page === page);
    });

    /* 渲染页面内容 */
    const container = document.getElementById('page-container');
    container.innerHTML = '';
    this.pages[page].render(container);

    /* 入场动画只在换页时播。
       这里走 Web Animations 而不是挂 CSS class：class 方案要等下一次样式重算动画才起步，
       实测中间会露出 2~3 帧的全亮页面，看着像闪一下；fill:'backwards' 让首帧立刻生效。 */
    if (switching) {
      container.animate(
        [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'translateY(0)' }],
        { duration: 220, easing: 'ease-out', fill: 'backwards' }
      );
    }
    this._renderedOnce = true;

    /* 滚动到顶部 */
    window.scrollTo({ top: 0, behavior: 'smooth' });

    /* 更新 hash（避免循环） */
    if (location.hash !== `#/${page}`) {
      history.pushState(null, '', `#/${page}`);
    }
  },

  refresh() {
    this.navigate(this.currentPage);
  },

  updateHeaderDate() {
    const el = document.getElementById('header-date');
    if (el) {
      const now = new Date();
      const opts = { month: 'short', day: 'numeric', weekday: 'short' };
      el.textContent = now.toLocaleDateString('zh-CN', opts);
    }
  }
};

/* ---- 应用启动 ---- */
document.addEventListener('DOMContentLoaded', () => {
  /* 先按本地缓存渲染，界面立刻可用 */
  App.init();

  /* 再后台跟云端对一次：拉回别处写的、补传本地新写的。
     不 await —— 网络慢的时候不能让打开页面卡住。 */
  if (typeof Sync !== 'undefined' && Sync.boot) Sync.boot();
});