/* ============================================
   Timeline - 时间线模块
   左侧时间线展示日记，顶部最新、底部最旧
   支持全部 / 周 / 月份筛选，每页 15 条分页
   筛选切换仅局部更新，避免整页刷新动画
   ============================================ */

const Timeline = {
  PER_PAGE: 15,

  _filter: 'all',      /* all | month | week */
  _filterYear: null,
  _filterMonth: null,  /* 1-12 */
  _filterWeek: null,   /* 第几周 */
  _page: 1,

  render(container) {
    const now = new Date();
    if (this._filterYear === null) this._filterYear = now.getFullYear();
    if (this._filterMonth === null) this._filterMonth = now.getMonth() + 1;

    const today = Utils.today();
    container.innerHTML = `
      <div class="card mb-16">
        <div class="card-title">
          <span>时间线</span>
          <button class="btn btn-sm btn-primary" onclick="Diary.showEditor('${today}')">写今日日记</button>
        </div>
        <div class="timeline-filter">
          <button class="filter-pill" data-filter="all" onclick="Timeline.setFilter('all')">全部</button>
          <button class="filter-pill" data-filter="week" onclick="Timeline.setFilter('week')">周</button>
          <button class="filter-pill" data-filter="month" onclick="Timeline.setFilter('month')">月份</button>
        </div>
        <div id="timeline-panel"></div>
        <div class="text-sm text-muted mt-8" id="timeline-count"></div>
      </div>
      <div class="timeline" id="timeline-wrap"></div>
      <div id="timeline-pagination"></div>
    `;

    this.updateView();
  },

  /* 仅更新可变区域（胶囊高亮/面板/计数/列表/分页），外层卡片不动 */
  updateView() {
    document.querySelectorAll('.filter-pill').forEach(el => {
      el.classList.toggle('active', el.dataset.filter === this._filter);
    });

    const panel = document.getElementById('timeline-panel');
    if (panel) {
      panel.innerHTML = this._filter === 'month' ? this.renderMonthPanel()
        : this._filter === 'week' ? this.renderWeekPanel() : '';
    }

    const allDates = this.getFilteredDates();
    const total = allDates.length;
    const totalPages = Math.max(1, Math.ceil(total / this.PER_PAGE));
    if (this._page > totalPages) this._page = totalPages;
    const pageDates = allDates.slice((this._page - 1) * this.PER_PAGE, this._page * this.PER_PAGE);

    const count = document.getElementById('timeline-count');
    if (count) count.textContent = `${this.filterLabel()} · 共 ${total} 篇`;

    const wrap = document.getElementById('timeline-wrap');
    if (wrap) this.renderItems(wrap, pageDates);

    const pag = document.getElementById('timeline-pagination');
    if (pag) {
      pag.innerHTML = totalPages > 1 ? `
        <div class="pagination">
          <button class="btn btn-sm btn-secondary${this._page <= 1 ? ' disabled' : ''}" onclick="Timeline.setPage(${this._page - 1})">上一页</button>
          <span class="pagination-info">${this._page} / ${totalPages}</span>
          <button class="btn btn-sm btn-secondary${this._page >= totalPages ? ' disabled' : ''}" onclick="Timeline.setPage(${this._page + 1})">下一页</button>
        </div>` : '';
    }
  },

  /* 筛选后的完整日期列表（倒序） */
  getFilteredDates() {
    const all = Diary.getActiveDates();
    if (this._filter === 'month' && this._filterMonth) {
      const prefix = `${this._filterYear}-${String(this._filterMonth).padStart(2, '0')}`;
      return all.filter(d => d.startsWith(prefix));
    }
    if (this._filter === 'week' && this._filterMonth && this._filterWeek) {
      const prefix = `${this._filterYear}-${String(this._filterMonth).padStart(2, '0')}`;
      return all.filter(d => {
        if (!d.startsWith(prefix)) return false;
        return Math.ceil(parseInt(d.slice(8, 10), 10) / 7) === this._filterWeek;
      });
    }
    return all;
  },

  filterLabel() {
    if (this._filter === 'month' && this._filterMonth) return `${this._filterYear}年${this._filterMonth}月`;
    if (this._filter === 'week' && this._filterMonth && this._filterWeek) return `${this._filterYear}年${this._filterMonth}月 第${this._filterWeek}周`;
    return '全部时间';
  },

  renderItems(wrap, dates) {
    if (dates.length === 0) {
      wrap.innerHTML = '<div class="empty-state"><div class="empty-state-text">该范围内还没有日记</div></div>';
      return;
    }
    let html = '';
    dates.forEach(d => {
      const entry = Diary.getEntry(d);
      if (!entry || !entry.content) return;
      const content = entry.content.replace(/<[^>]*>/g, '').trim();
      const imgs = entry.images || [];
      const weekLabel = ['日', '一', '二', '三', '四', '五', '六'][new Date(d + 'T00:00:00').getDay()];
      html += `
        <div class="timeline-item">
          <span class="timeline-dot"></span>
          <span class="timeline-date">${d.slice(5)} 周${weekLabel}</span>
          <div class="timeline-card" onclick="Diary.showEditor('${d}')">
            <div class="timeline-card-text">${content || '(空)'}</div>
            ${imgs.length ? `<div class="timeline-imgs">${imgs.slice(0, 3).map(img => `<img src="${img}" alt="日记图片">`).join('')}</div>` : ''}
          </div>
        </div>
      `;
    });
    wrap.innerHTML = html;
  },

  /* ---- 筛选交互（仅局部更新） ---- */
  setFilter(type) {
    const now = new Date();
    if (this._filter === type) {
      this._filter = 'all';
      this._filterMonth = null;
      this._filterWeek = null;
    } else {
      this._filter = type;
      this._filterYear = now.getFullYear();
      this._filterMonth = null;
      this._filterWeek = null;
      if (type === 'week') this._filterMonth = now.getMonth() + 1;
    }
    this._page = 1;
    this.updateView();
  },

  setMonth(m) {
    this._filterMonth = m;
    this._filterWeek = null;
    this._page = 1;
    this.updateView();
  },

  setWeek(w) {
    this._filterWeek = w;
    this._page = 1;
    this.updateView();
  },

  setPage(p) {
    this._page = p;
    this.updateView();
  },

  changeFilterYear(dir) {
    this._filterYear += dir;
    this._filterMonth = null;
    this._filterWeek = null;
    this._page = 1;
    this.updateView();
  },

  changeFilterMonth(dir) {
    let m = this._filterMonth + dir;
    if (m < 1) { m = 12; this._filterYear--; }
    if (m > 12) { m = 1; this._filterYear++; }
    this._filterMonth = m;
    this._filterWeek = null;
    this._page = 1;
    this.updateView();
  },

  /* ---- 面板渲染 ---- */
  renderMonthPanel() {
    const y = this._filterYear;
    let html = `
      <div class="filter-panel">
        <div class="filter-panel-head">
          <button class="icon-btn" onclick="Timeline.changeFilterYear(-1)">‹</button>
          <span class="filter-panel-title">${y} 年</span>
          <button class="icon-btn" onclick="Timeline.changeFilterYear(1)">›</button>
        </div>
        <div class="filter-month-grid">`;
    for (let m = 1; m <= 12; m++) {
      html += `<button class="filter-month${this._filterMonth === m ? ' active' : ''}" onclick="Timeline.setMonth(${m})">${m}月</button>`;
    }
    html += '</div></div>';
    return html;
  },

  renderWeekPanel() {
    const y = this._filterYear;
    const m = this._filterMonth || new Date().getMonth() + 1;
    const daysInMonth = Utils.getMonthDays(y, m);
    const weekCount = Math.ceil(daysInMonth / 7);
    let html = `
      <div class="filter-panel">
        <div class="filter-panel-head">
          <button class="icon-btn" onclick="Timeline.changeFilterMonth(-1)">‹</button>
          <span class="filter-panel-title">${y} 年 ${m} 月</span>
          <button class="icon-btn" onclick="Timeline.changeFilterMonth(1)">›</button>
        </div>
        <div class="filter-week-list">`;
    for (let w = 1; w <= weekCount; w++) {
      html += `<button class="filter-week${this._filterWeek === w ? ' active' : ''}" onclick="Timeline.setWeek(${w})">第${w}周</button>`;
    }
    html += '</div></div>';
    return html;
  }
};
