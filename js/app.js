/* ============================================
   App - 主控制器 / 路由 / 初始化
   全站 SPA 路由、导航切换、数据加载
   ============================================ */

const App = {
  currentPage: 'dashboard',

  pages: {
    dashboard: { title: '仪表盘', render: (c) => Dashboard.render(c) },
    diary: { title: '日记', render: (c) => Diary.renderDiaryPage(c) },
    study: { title: '学习', render: (c) => Study.renderStudyPage(c) },
    schedule: { title: '日程', render: (c) => Extras.renderSchedulePage(c) },
    goals: { title: '目标', render: (c) => Extras.renderGoalsPage(c) },
    settings: { title: '设置', render: (c) => Settings.render(c) }
  },

  init() {
    /* 初始化各模块 */
    Diary.init();
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
    const hash = location.hash.slice(1) || '/dashboard';
    const page = hash.replace('/', '');
    this.navigate(this.pages[page] ? page : 'dashboard');

    /* 每分钟更新日期 */
    setInterval(() => this.updateHeaderDate(), 60000);
  },

  setupRouter() {
    window.addEventListener('hashchange', () => {
      const hash = location.hash.slice(1) || '/dashboard';
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
    if (!this.pages[page]) page = 'dashboard';

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
  App.init();
});