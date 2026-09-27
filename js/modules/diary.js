/* ============================================
   Diary - 每日日记模块
   写日记、今日列表、月历浏览
   ============================================ */

const Diary = {
  STORAGE_KEY: 'diary_entries',
  MOOD_KEY: 'diary_moods',

  /* 获取某日日记 */
  getEntry(dateStr) {
    return Store.getDate(this.STORAGE_KEY, dateStr);
  },

  /* 保存/更新日记 */
  saveEntry(dateStr, data) {
    const entry = this.getEntry(dateStr) || { id: Utils.uid(), createdAt: dateStr };
    const updated = {
      ...entry,
      date: dateStr,
      content: data.content || '',
      mood: data.mood || '',
      review: data.review || '',
      images: data.images || entry.images || [],
      pinned: data.pinned !== undefined ? data.pinned : (entry.pinned || false),
      updatedAt: new Date().toISOString()
    };
    Store.setDate(this.STORAGE_KEY, dateStr, updated);
    return updated;
  },

  /* 删除日记 */
  async deleteEntry(dateStr) {
    if (!await Utils.confirm('确定删除此日记？')) return false;
    Store.setDate(this.STORAGE_KEY, dateStr, null);
    return true;
  },

  /* 所有有内容的日期 */
  getActiveDates() {
    return Store.getDateKeys(this.STORAGE_KEY).filter(d => {
      const entry = Store.getDate(this.STORAGE_KEY, d);
      return entry && entry.content;
    }).sort().reverse();
  },

  /* 搜索日记 */
  search(keyword) {
    const dates = this.getActiveDates();
    return dates.filter(d => {
      const entry = Store.getDate(this.STORAGE_KEY, d);
      const text = (entry.content + ' ' + (entry.review || '')).toLowerCase();
      return text.includes(keyword.toLowerCase());
    }).map(d => Store.getDate(this.STORAGE_KEY, d));
  },

  /* ---- 情绪数据（保留历史记录，供仪表盘曲线） ---- */
  setMood(dateStr, moodVal) {
    Store.setDate(this.MOOD_KEY, dateStr, moodVal);
  },

  getMood(dateStr) {
    return Store.getDate(this.MOOD_KEY, dateStr);
  },

  getMoodList() {
    const keys = Store.getDateKeys(this.MOOD_KEY).sort();
    return keys.map(k => ({ date: k, mood: Store.getDate(this.MOOD_KEY, k) }));
  },

  /* ---- 渲染 ---- */
  renderDiaryPage(container) {
    const today = Utils.today();
    const entry = this.getEntry(today);
    const hasToday = !!(entry && entry.content);
    const todayLabel = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
    container.innerHTML = `
      <div class="card mb-16">
        <div class="flex items-center justify-between">
          <div>
            <div class="font-bold" style="font-size:1.05rem;">${todayLabel}</div>
            <div class="text-sm" style="color:${hasToday ? 'var(--accent-green)' : 'var(--text-muted)'};margin-top:2px;">${hasToday ? '已写' : '未写'}</div>
          </div>
          <button class="btn btn-primary" style="padding:12px 32px;font-size:1rem;border-radius:var(--radius-lg);" onclick="Diary.showEditor('${today}')">写日记</button>
        </div>
      </div>
      <div id="diary-today-list"></div>
      <div class="card mb-16">
        <div class="card-title">
          <span>日记月历</span>
          <button class="btn btn-sm btn-secondary" onclick="Diary.showSearch()">搜索</button>
        </div>
        <div id="diary-calendar"></div>
      </div>
      <div id="diary-all-list"></div>
    `;

    this.renderTodayList(document.getElementById('diary-today-list'));
    this.renderCalendar(document.getElementById('diary-calendar'), today);
    this.renderAllList(document.getElementById('diary-all-list'));
  },

  /* 今日日记列表（只呈现当日） */
  renderTodayList(container) {
    const today = Utils.today();
    const entry = this.getEntry(today);
    if (!entry || !entry.content) {
      container.innerHTML = `
        <div class="card mb-16">
          <div class="card-title"><span>今日日记</span></div>
          <div class="empty-state-text">今天还没有写日记</div>
        </div>
      `;
      return;
    }
    const preview = entry.content.replace(/<[^>]*>/g, '').slice(0, 120);
    container.innerHTML = `
      <div class="card mb-16">
        <div class="card-title"><span>今日日记</span></div>
        <div class="list-item">
          <div class="list-item-main" onclick="Diary.showEditor('${today}')" style="cursor:pointer;">
            <div class="list-item-title">${today}</div>
            <div class="list-item-sub">${preview || '(空)'}</div>
          </div>
          <div class="list-item-actions">
            <button class="btn btn-sm btn-secondary" onclick="Diary.showEditor('${today}')">编辑</button>
            <button class="btn btn-sm btn-danger" onclick="Diary.deleteEntry('${today}').then(()=>App.refresh())">删除</button>
          </div>
        </div>
      </div>
    `;
  },

  /* 全部日记列表（位于月历下方） */
  renderAllList(container) {
    const dates = this.getActiveDates();
    if (dates.length === 0) {
      container.innerHTML = `
        <div class="card">
          <div class="card-title"><span>日记列表</span></div>
          <div class="empty-state-text">还没有日记</div>
        </div>
      `;
      return;
    }
    let html = '<div class="card"><div class="card-title"><span>日记列表</span></div>';
    dates.forEach(d => {
      const entry = Store.getDate(this.STORAGE_KEY, d);
      if (!entry || !entry.content) return;
      const preview = entry.content.replace(/<[^>]*>/g, '').slice(0, 60);
      html += `
        <div class="list-item">
          <div class="list-item-main" onclick="Diary.showEditor('${d}')" style="cursor:pointer;">
            <div class="list-item-title">${d}</div>
            <div class="list-item-sub">${preview || '(空)'}</div>
          </div>
          <div class="list-item-actions">
            <button class="btn btn-sm btn-secondary" onclick="Diary.showEditor('${d}')">编辑</button>
          </div>
        </div>
      `;
    });
    html += '</div>';
    container.innerHTML = html;
  },

  _calMonth: null,
  _calYear: null,

  renderCalendar(container, focusDate) {
    const now = focusDate ? Utils.parseDate(focusDate) : new Date();
    const year = this._calYear || now.getFullYear();
    const month = this._calMonth || (now.getMonth() + 1);
    this._calYear = year;
    this._calMonth = month;

    const daysInMonth = Utils.getMonthDays(year, month);
    const firstDay = Utils.getMonthFirstDay(year, month);
    const today = Utils.today();
    const activeDates = this.getActiveDates();

    let html = `
      <div class="calendar-header">
        <div class="calendar-nav">
          <button class="icon-btn" onclick="Diary.prevMonth()">‹</button>
          <span class="calendar-month">${year} 年 ${month} 月</span>
          <button class="icon-btn" onclick="Diary.nextMonth()">›</button>
          <button class="btn btn-sm btn-secondary" onclick="Diary.goToday()">今天</button>
        </div>
      </div>
      <div class="calendar-grid">
    `;

    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    weekdays.forEach(w => { html += `<div class="calendar-weekday">${w}</div>`; });

    for (let i = 0; i < firstDay; i++) {
      html += '<div></div>';
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const isToday = dateStr === today;
      const hasContent = activeDates.includes(dateStr);
      const cls = `calendar-day${isToday ? ' today' : ''}${hasContent ? ' has-content' : ''}`;

      html += `<div class="${cls}" onclick="Diary.onDayClick('${dateStr}')">${d}</div>`;
    }

    html += '</div>';
    container.innerHTML = html;
  },

  prevMonth() {
    if (this._calMonth === 1) { this._calMonth = 12; this._calYear--; }
    else { this._calMonth--; }
    const cal = document.getElementById('diary-calendar');
    if (cal) this.renderCalendar(cal);
  },

  nextMonth() {
    if (this._calMonth === 12) { this._calMonth = 1; this._calYear++; }
    else { this._calMonth++; }
    const cal = document.getElementById('diary-calendar');
    if (cal) this.renderCalendar(cal);
  },

  goToday() {
    this._calYear = null;
    this._calMonth = null;
    const cal = document.getElementById('diary-calendar');
    if (cal) this.renderCalendar(cal, Utils.today());
  },

  onDayClick(dateStr) {
    this.showEditor(dateStr);
  },

  showEditor(dateStr) {
    const entry = this.getEntry(dateStr) || { content: '', images: [] };
    const container = document.getElementById('page-container');
    container.innerHTML = `
      <div class="card page-enter">
        <div class="card-title">
          <span>${dateStr} 日记</span>
          <button class="btn btn-sm btn-secondary" onclick="App.refresh()">← 返回</button>
        </div>
        <div class="form-group">
          <label class="form-label">日记内容</label>
          <textarea class="textarea" id="diary-content" rows="10" placeholder="记录今天的点点滴滴…">${entry.content || ''}</textarea>
        </div>
        <div class="form-group">
          <label class="form-label">图片</label>
          <input type="file" accept="image/*" id="diary-image-input" class="input" multiple>
          <div id="diary-image-preview" style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
            ${(entry.images || []).map(img => `<div style="position:relative;"><img src="${img}" style="width:80px;height:80px;object-fit:cover;border-radius:6px;"><button class="btn btn-sm btn-danger" style="position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:50%;padding:0;font-size:10px;" onclick="Diary.removeImage('${dateStr}','${img}')">×</button></div>`).join('')}
          </div>
        </div>
        <div class="flex gap-8 mt-16">
          <button class="btn btn-primary" onclick="Diary.saveEditor('${dateStr}')">保存</button>
          <button class="btn btn-secondary" onclick="App.refresh()">取消</button>
        </div>
      </div>
    `;

    /* 图片上传 */
    const imgInput = document.getElementById('diary-image-input');
    if (imgInput) {
      imgInput.addEventListener('change', function() {
        const files = Array.from(this.files);
        files.forEach(f => {
          const reader = new FileReader();
          reader.onload = function(e) {
            const entry = Diary.getEntry(dateStr) || { content: '', images: [] };
            entry.images = entry.images || [];
            entry.images.push(e.target.result);
            Diary.saveEntry(dateStr, entry);
            Diary.showEditor(dateStr);
          };
          reader.readAsDataURL(f);
        });
      });
    }
  },

  removeImage(dateStr, img) {
    const entry = this.getEntry(dateStr);
    if (entry) {
      entry.images = (entry.images || []).filter(i => i !== img);
      Store.setDate(this.STORAGE_KEY, dateStr, entry);
      this.showEditor(dateStr);
    }
  },

  saveEditor(dateStr) {
    const content = document.getElementById('diary-content')?.value || '';
    this.saveEntry(dateStr, { content });
    App.refresh();
  },

  showSearch() {
    const container = document.getElementById('page-container');
    container.innerHTML = `
      <div class="card page-enter">
        <div class="card-title">
          <span>搜索日记</span>
          <button class="btn btn-sm btn-secondary" onclick="App.refresh()">← 返回</button>
        </div>
        <div class="form-group">
          <input class="input" id="search-input" placeholder="输入关键词搜索…" oninput="Diary.doSearch()">
        </div>
        <div id="search-results"></div>
      </div>
    `;
    document.getElementById('search-input')?.focus();
  },

  doSearch() {
    const keyword = document.getElementById('search-input')?.value || '';
    const results = document.getElementById('search-results');
    if (!keyword) { results.innerHTML = ''; return; }
    const list = this.search(keyword);
    if (list.length === 0) {
      results.innerHTML = '<div class="empty-state"><div class="empty-state-text">未找到匹配结果</div></div>';
      return;
    }
    let html = '';
    list.forEach(entry => {
      const preview = entry.content.replace(/<[^>]*>/g, '').slice(0, 80);
      html += `<div class="list-item" style="cursor:pointer;" onclick="Diary.showEditor('${entry.date}')">
        <div class="list-item-main">
          <div class="list-item-title">${entry.date}</div>
          <div class="list-item-sub">${preview}</div>
        </div>
      </div>`;
    });
    results.innerHTML = html;
  },

  /* 获取情绪数据用于仪表盘图表 */
  getMoodChartData() {
    const list = this.getMoodList().slice(-30);
    const moodValues = { happy: 4, excited: 5, fulfilled: 4, neutral: 3, tired: 2, anxious: 1, sad: 1, irritated: 1 };
    return list.map(item => ({
      label: item.date.slice(5),
      value: moodValues[item.mood] || 3,
      date: item.date
    }));
  }
};
