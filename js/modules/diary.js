/* ============================================
   Diary - 每日日记 / 生活打卡模块
   包含日志、心情、复盘、便签、日历
   ============================================ */

const Diary = {
  STORAGE_KEY: 'diary_entries',
  MOOD_KEY: 'diary_moods',
  NOTES_KEY: 'diary_notes',
  TEMPLATE_KEY: 'diary_template',

  moods: [
    { label: '开心', value: 'happy' },
    { label: '平淡', value: 'neutral' },
    { label: '疲惫', value: 'tired' },
    { label: '焦虑', value: 'anxious' },
    { label: '充实', value: 'fulfilled' },
    { label: '难过', value: 'sad' },
    { label: '烦躁', value: 'irritated' },
    { label: '兴奋', value: 'excited' }
  ],

  init() {
    if (!Store.get(this.TEMPLATE_KEY)) {
      Store.set(this.TEMPLATE_KEY, '今日完成：\n今日不足：\n明日计划：');
    }
  },

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

  /* 切换置顶 */
  togglePin(dateStr) {
    const entry = this.getEntry(dateStr);
    if (entry) {
      entry.pinned = !entry.pinned;
      Store.setDate(this.STORAGE_KEY, dateStr, entry);
    }
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

  /* ---- 心情 ---- */
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

  getMoodLabel(moodVal) {
    const m = this.moods.find(m => m.value === moodVal);
    return m ? m.label : '';
  },

  /* ---- 便签 ---- */
  getNotes() {
    return Store.getList(this.NOTES_KEY);
  },

  addNote(text) {
    return Store.addItem(this.NOTES_KEY, { text, pinned: false });
  },

  deleteNote(id) {
    return Store.removeItem(this.NOTES_KEY, id);
  },

  /* ---- 复盘模板 ---- */
  getTemplate() {
    return Store.get(this.TEMPLATE_KEY, '今日完成：\n今日不足：\n明日计划：');
  },

  setTemplate(tpl) {
    Store.set(this.TEMPLATE_KEY, tpl);
  },

  /* ---- 渲染 ---- */
  renderDiaryPage(container) {
    const today = Utils.today();
    /* 使用全局 Calendar 状态 */
    container.innerHTML = `
      <div class="card mb-16">
        <div class="card-title">
          <span>日记</span>
          <div class="flex gap-8">
            <button class="btn btn-sm btn-secondary" onclick="Diary.showSearch()">搜索</button>
            <button class="btn btn-sm btn-secondary" onclick="Diary.showNotes()">便签</button>
          </div>
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px;">
          <button class="btn btn-sm btn-primary" onclick="Diary.showEditor('${today}')">写日记</button>
          <button class="btn btn-sm btn-secondary" onclick="Diary.showReviewEditor('${today}')">今日复盘</button>
        </div>
        <div id="diary-calendar"></div>
      </div>
      <div id="diary-entry-list"></div>
    `;

    this.renderCalendar(document.getElementById('diary-calendar'), today);
    this.renderEntryList(document.getElementById('diary-entry-list'));
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
    const entry = this.getEntry(dateStr);
    if (entry && entry.content) {
      this.showEditor(dateStr);
    } else {
      this.showEditor(dateStr);
    }
  },

  renderEntryList(container) {
    const dates = this.getActiveDates();
    const pinned = dates.filter(d => { const e = Store.getDate(this.STORAGE_KEY, d); return e && e.pinned; });
    const normal = dates.filter(d => !pinned.includes(d));

    if (dates.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-text">还没有日记，点击日期开始记录吧</div></div>';
      return;
    }

    let html = '<div class="card"><div class="card-title"><span>日记列表</span></div>';
    [...pinned, ...normal].forEach(d => {
      const entry = Store.getDate(this.STORAGE_KEY, d);
      if (!entry || !entry.content) return;
      const preview = entry.content.replace(/<[^>]*>/g, '').slice(0, 60);
      const moodLabel = entry.mood ? this.getMoodLabel(entry.mood) : '';
      html += `
        <div class="list-item">
          <div class="list-item-main" onclick="Diary.showEditor('${d}')" style="cursor:pointer;">
            <div class="list-item-title">${entry.pinned ? '置顶 · ' : ''}${d} ${moodLabel}</div>
            <div class="list-item-sub">${preview || '(空)'}</div>
          </div>
          <div class="list-item-actions">
            <button class="btn btn-sm btn-secondary" onclick="Diary.togglePin('${d}');App.refresh()">${entry.pinned ? '取消置顶' : '置顶'}</button>
            <button class="btn btn-sm btn-danger" onclick="Diary.deleteEntry('${d}').then(()=>App.refresh())">删除</button>
          </div>
        </div>
      `;
    });
    html += '</div>';
    container.innerHTML = html;
  },

  showEditor(dateStr) {
    const entry = this.getEntry(dateStr) || { content: '', mood: '', review: '', images: [] };
    const container = document.getElementById('page-container');
    const moodOptions = this.moods.map(m =>
      `<button class="mood-btn${entry.mood === m.value ? ' selected' : ''}" data-mood="${m.value}" onclick="Diary.selectMood('${m.value}')">${m.label}</button>`
    ).join('');

    container.innerHTML = `
      <div class="card page-enter">
        <div class="card-title">
          <span>${dateStr} 日记</span>
          <button class="btn btn-sm btn-secondary" onclick="App.refresh()">← 返回</button>
        </div>
        <div class="form-group">
          <label class="form-label">今日心情</label>
          <div class="mood-selector" id="mood-selector">
            ${moodOptions}
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">日记内容</label>
          <textarea class="textarea" id="diary-content" rows="8" placeholder="记录今天的点点滴滴…">${entry.content || ''}</textarea>
        </div>
        <div class="form-group">
          <label class="form-label">每日复盘</label>
          <textarea class="textarea" id="diary-review" rows="4" placeholder="今日复盘…">${entry.review || ''}</textarea>
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
            const entry = Diary.getEntry(dateStr) || { content: '', mood: '', review: '', images: [] };
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

  _selectedMood: null,
  selectMood(val) {
    this._selectedMood = val;
    document.querySelectorAll('.mood-btn').forEach(b => {
      b.classList.toggle('selected', b.dataset.mood === val);
    });
  },

  saveEditor(dateStr) {
    const content = document.getElementById('diary-content')?.value || '';
    const review = document.getElementById('diary-review')?.value || '';
    const mood = this._selectedMood || Store.getDate(this.MOOD_KEY, dateStr) || '';
    this.saveEntry(dateStr, { content, mood, review });
    if (mood) this.setMood(dateStr, mood);
    this._selectedMood = null;
    App.refresh();
  },

  showReviewEditor(dateStr) {
    const entry = this.getEntry(dateStr) || { content: '', mood: '', review: '', images: [] };
    const tpl = this.getTemplate();
    const container = document.getElementById('page-container');
    container.innerHTML = `
      <div class="card page-enter">
        <div class="card-title">
          <span>${dateStr} 复盘</span>
          <button class="btn btn-sm btn-secondary" onclick="App.refresh()">← 返回</button>
        </div>
        <div class="form-group">
          <label class="form-label">复盘内容</label>
          <textarea class="textarea" id="review-content" rows="8" placeholder="今日复盘…">${entry.review || tpl}</textarea>
        </div>
        <div class="flex gap-8 mt-16">
          <button class="btn btn-primary" onclick="Diary.saveReview('${dateStr}')">保存</button>
          <button class="btn btn-secondary" onclick="App.refresh()">取消</button>
        </div>
      </div>
    `;
  },

  saveReview(dateStr) {
    const review = document.getElementById('review-content')?.value || '';
    const entry = this.getEntry(dateStr) || { content: '', mood: '', images: [] };
    this.saveEntry(dateStr, { ...entry, review });
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

  showNotes() {
    const container = document.getElementById('page-container');
    const notes = this.getNotes();
    container.innerHTML = `
      <div class="card page-enter">
        <div class="card-title">
          <span>随手便签</span>
          <button class="btn btn-sm btn-secondary" onclick="App.refresh()">← 返回</button>
        </div>
        <div class="flex gap-8 mb-16">
          <input class="input" id="note-input" placeholder="输入便签内容…" onkeydown="if(event.key==='Enter')Diary.addNoteBtn()">
          <button class="btn btn-primary" onclick="Diary.addNoteBtn()">添加</button>
        </div>
        <div id="note-list">
          ${notes.length === 0 ? '<div class="empty-state-text">暂无便签</div>' :
            notes.map(n => `
              <div class="note-card mb-8">
                <button class="note-close" onclick="Diary.deleteNoteBtn('${n.id}')">×</button>
                <div class="note-text">${n.text}</div>
                <div class="note-time">${Utils.formatDateTime(n.createdAt)}</div>
              </div>
            `).join('')}
        </div>
      </div>
    `;
  },

  addNoteBtn() {
    const input = document.getElementById('note-input');
    if (input && input.value.trim()) {
      this.addNote(input.value.trim());
      input.value = '';
      this.showNotes();
    }
  },

  async deleteNoteBtn(id) {
    if (await Utils.confirm('删除此便签？')) {
      this.deleteNote(id);
      this.showNotes();
    }
  },

  /* 获取情绪数据用于图表 */
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