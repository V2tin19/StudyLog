/* ============================================
   Study - 学习打卡 / 自我提升模块
   学习台账、书籍清单、技能清单
   ============================================ */

const Study = {
  SESSIONS_KEY: 'study_sessions',
  TASKS_KEY: 'study_tasks',
  BOOKS_KEY: 'study_books',
  SKILLS_KEY: 'study_skills',
  CHECKIN_KEY: 'study_checkin',

  /* ---- 学习台账 ---- */
  getSessions() { return Store.getList(this.SESSIONS_KEY); },

  addSession(data) {
    return Store.addItem(this.SESSIONS_KEY, {
      ...data,
      date: data.date || Utils.today()
    });
  },

  deleteSession(id) { return Store.removeItem(this.SESSIONS_KEY, id); },

  getTodaySessions() {
    return this.getSessions().filter(s => s.date === Utils.today());
  },

  getTotalDuration(sessions) {
    return (sessions || this.getSessions()).reduce((s, x) => s + (x.duration || 0), 0);
  },

  getDurationByDate(dateStr) {
    return this.getSessions().filter(s => s.date === dateStr).reduce((s, x) => s + (x.duration || 0), 0);
  },

  getDurationByWeek(dateStr) {
    const start = Utils.getWeekStart(dateStr);
    return this.getSessions().filter(s => s.date >= start && s.date <= dateStr).reduce((s, x) => s + (x.duration || 0), 0);
  },

  getDurationByMonth(dateStr) {
    const month = dateStr.slice(0, 7);
    return this.getSessions().filter(s => s.date && s.date.startsWith(month)).reduce((s, x) => s + (x.duration || 0), 0);
  },

  formatDuration(minutes) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h > 0 ? `${h}小时${m}分钟` : `${m}分钟`;
  },

  /* ---- 任务管理（供仪表盘汇总使用） ---- */
  getTasks() { return Store.getList(this.TASKS_KEY); },

  addTask(data) {
    return Store.addItem(this.TASKS_KEY, {
      ...data,
      date: data.date || Utils.today(),
      done: false
    });
  },

  toggleTask(id) {
    const task = Store.getItem(this.TASKS_KEY, id);
    if (task) {
      task.done = !task.done;
      if (task.done) task.doneAt = new Date().toISOString();
      else task.doneAt = null;
      Store.updateItem(this.TASKS_KEY, id, task);
    }
  },

  deleteTask(id) { return Store.removeItem(this.TASKS_KEY, id); },

  getTodayTasks() {
    return this.getTasks().filter(t => t.date === Utils.today());
  },

  /* ---- 打卡签到（供仪表盘统计使用） ---- */
  checkin(dateStr) {
    Store.setDate(this.CHECKIN_KEY, dateStr, true);
  },

  isCheckedIn(dateStr) {
    return !!Store.getDate(this.CHECKIN_KEY, dateStr);
  },

  getCheckinDates() {
    return Store.getDateKeys(this.CHECKIN_KEY).filter(d => Store.getDate(this.CHECKIN_KEY, d));
  },

  getStreak() {
    const dates = this.getCheckinDates().sort().reverse();
    if (dates.length === 0) return { current: 0, max: 0 };
    let current = 0, max = 0, streak = 0;
    const today = Utils.today();
    /* 今日或昨日是否打卡 */
    const lastDate = dates[0];
    const diff = (Utils.parseDate(today) - Utils.parseDate(lastDate)) / 86400000;
    if (diff > 1) { current = 0; } else { current = 1; }

    for (let i = 0; i < dates.length; i++) {
      if (i === 0) { streak = 1; continue; }
      const prev = Utils.parseDate(dates[i - 1]);
      const cur = Utils.parseDate(dates[i]);
      if ((prev - cur) / 86400000 === 1) { streak++; }
      else {
        max = Math.max(max, streak);
        streak = 1;
      }
    }
    max = Math.max(max, streak);

    if (diff <= 1) {
      for (let i = 1; i < dates.length; i++) {
        if ((Utils.parseDate(dates[i - 1]) - Utils.parseDate(dates[i])) / 86400000 === 1) current++;
        else break;
      }
    }

    return { current, max };
  },

  /* ---- 书籍管理 ---- */
  getBooks() { return Store.getList(this.BOOKS_KEY); },

  addBook(data) {
    return Store.addItem(this.BOOKS_KEY, {
      ...data,
      status: data.status || 'reading'
    });
  },

  /* 勾选完成 / 取消归档（局部刷新 + 单条目滑动动画） */
  toggleBookDone(id) {
    const el = document.getElementById('study-book-list');
    if (!el) return;
    /* First：记录各条目当前位置 */
    const firstPos = {};
    [...el.querySelectorAll('.list-item')].forEach(item => {
      firstPos[item.dataset.id] = item.getBoundingClientRect().top;
    });
    const book = Store.getItem(this.BOOKS_KEY, id);
    if (book) {
      book.status = book.status === 'done' ? 'reading' : 'done';
      Store.updateItem(this.BOOKS_KEY, id, book);
      el.innerHTML = this.renderBooks();
      this._animateReorder(el, firstPos);
    }
  },

  /* FLIP 动画：条目从原位平滑滑到重排后的新位置 */
  _animateReorder(listEl, firstPos) {
    [...listEl.querySelectorAll('.list-item')].forEach(el => {
      const oldTop = firstPos[el.dataset.id];
      const newTop = el.getBoundingClientRect().top;
      if (oldTop !== undefined && oldTop !== newTop) {
        const delta = oldTop - newTop;
        el.style.transition = 'none';
        el.style.transform = `translateY(${delta}px)`;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            el.style.transition = 'transform 0.5s cubic-bezier(0.22, 1, 0.36, 1)';
            el.style.transform = 'translateY(0)';
          });
        });
      }
    });
  },

  /* ---- 技能清单 ---- */
  getSkills() { return Store.getList(this.SKILLS_KEY); },

  addSkill(data) {
    return Store.addItem(this.SKILLS_KEY, {
      ...data,
      status: data.status || 'active'
    });
  },

  updateSkill(id, data) {
    return Store.updateItem(this.SKILLS_KEY, id, data);
  },

  /* 勾选完成 / 取消归档（局部刷新 + 单条目滑动动画） */
  toggleSkillDone(id) {
    const el = document.getElementById('study-skill-list');
    if (!el) return;
    const firstPos = {};
    [...el.querySelectorAll('.list-item')].forEach(item => {
      firstPos[item.dataset.id] = item.getBoundingClientRect().top;
    });
    const skill = Store.getItem(this.SKILLS_KEY, id);
    if (skill) {
      skill.status = skill.status === 'done' ? 'active' : 'done';
      Store.updateItem(this.SKILLS_KEY, id, skill);
      el.innerHTML = this.renderSkills();
      this._animateReorder(el, firstPos);
    }
  },

  /* ---- 渲染 ---- */
  renderStudyPage(container) {
    const today = Utils.today();

    container.innerHTML = `
      <div class="card mb-16">
        <div class="card-title">
          <span>学习台账</span>
          <button class="btn btn-sm btn-primary" onclick="Study.showAddSession()">+ 记录</button>
        </div>
        <div id="study-sessions">
          ${this.renderSessionList()}
        </div>
      </div>
      <div class="card-grid card-grid-2 study-cols">
        <div class="card">
          <div class="card-title">
            <span>书籍</span>
            <button class="btn btn-sm btn-primary" onclick="Study.showAddBook()">+ 添加</button>
          </div>
          <div id="study-book-list">${this.renderBooks()}</div>
        </div>
        <div class="card">
          <div class="card-title">
            <span>技能</span>
            <button class="btn btn-sm btn-primary" onclick="Study.showAddSkill()">+ 添加</button>
          </div>
          <div id="study-skill-list">${this.renderSkills()}</div>
        </div>
      </div>
    `;
  },

  renderSessionList() {
    const sessions = this.getSessions().slice(0, 20);
    if (sessions.length === 0) return '<div class="empty-state-text">暂无学习记录</div>';
    return sessions.map(s => `
      <div class="list-item">
        <div class="list-item-main">
          <div class="list-item-title">${s.subject || '未分类'} · ${this.formatDuration(s.duration || 0)}</div>
          <div class="list-item-sub">${s.date} ${s.content || ''}</div>
        </div>
        <button class="btn btn-sm btn-danger" onclick="Study.deleteSession('${s.id}');App.refresh()">×</button>
      </div>
    `).join('');
  },

  showAddSession() {
    const container = document.getElementById('page-container');
    container.innerHTML = `
      <div class="card page-enter">
        <div class="card-title"><span>添加学习记录</span><button class="btn btn-sm btn-secondary" onclick="App.refresh()">← 返回</button></div>
        <div class="form-group">
          <label class="form-label">科目</label>
          <input class="input" id="session-subject" placeholder="如：数学、英语、编程…">
        </div>
        <div class="form-group">
          <label class="form-label">学习时长（分钟）</label>
          <input class="input" id="session-duration" type="number" min="1" placeholder="30">
        </div>
        <div class="form-group">
          <label class="form-label">学习内容</label>
          <textarea class="textarea" id="session-content" rows="4" placeholder="学了什么…"></textarea>
        </div>
        <div class="form-group">
          <label class="form-label">日期</label>
          <input class="input" id="session-date" type="date" value="${Utils.today()}">
        </div>
        <button class="btn btn-primary" onclick="Study.saveSession()">保存</button>
      </div>
    `;
  },

  saveSession() {
    const subject = document.getElementById('session-subject')?.value || '未分类';
    const duration = parseInt(document.getElementById('session-duration')?.value) || 0;
    const content = document.getElementById('session-content')?.value || '';
    const date = document.getElementById('session-date')?.value || Utils.today();
    if (!duration) { alert('请输入学习时长'); return; }
    this.addSession({ subject, duration, content, date });
    App.refresh();
  },

  /* ---- 书籍列表（进行中在前，已归档沉底） ---- */
  renderBooks() {
    const books = this.getBooks();
    const reading = books.filter(b => b.status !== 'done');
    const done = books.filter(b => b.status === 'done');
    const sorted = [...reading, ...done];
    if (sorted.length === 0) return '<div class="empty-state-text">暂无书籍，点击上方添加</div>';
    return sorted.map(b => `
      <div class="list-item${b.status === 'done' ? ' archived' : ''}" data-id="${b.id}">
        <div class="habit-check${b.status === 'done' ? ' done' : ''}" onclick="Study.toggleBookDone('${b.id}')"></div>
        <div class="list-item-main">
          <div class="list-item-title">${b.title || '未命名'}</div>
          ${b.notes ? `<div class="list-item-sub">${b.notes}</div>` : ''}
        </div>
      </div>
    `).join('');
  },

  showAddBook() {
    const container = document.getElementById('page-container');
    container.innerHTML = `
      <div class="card page-enter">
        <div class="card-title"><span>添加书籍</span><button class="btn btn-sm btn-secondary" onclick="App.refresh()">← 返回</button></div>
        <div class="form-group"><label class="form-label">书名</label><input class="input" id="book-title" placeholder="书名…"></div>
        <div class="form-group"><label class="form-label">备注</label><textarea class="textarea" id="book-notes" rows="4" placeholder="备注…"></textarea></div>
        <button class="btn btn-primary" onclick="Study.saveBook()">保存</button>
      </div>
    `;
  },

  saveBook() {
    const title = document.getElementById('book-title')?.value;
    if (!title) { alert('请输入书名'); return; }
    const notes = document.getElementById('book-notes')?.value || '';
    this.addBook({ title, notes });
    App.refresh();
  },

  /* ---- 技能列表（进行中在前，已归档沉底） ---- */
  renderSkills() {
    const skills = this.getSkills();
    const active = skills.filter(s => s.status !== 'done');
    const done = skills.filter(s => s.status === 'done');
    const sorted = [...active, ...done];
    if (sorted.length === 0) return '<div class="empty-state-text">暂无技能，点击上方添加</div>';
    return sorted.map(s => `
      <div class="list-item${s.status === 'done' ? ' archived' : ''}" data-id="${s.id}">
        <div class="habit-check${s.status === 'done' ? ' done' : ''}" onclick="Study.toggleSkillDone('${s.id}')"></div>
        <div class="list-item-main">
          <div class="list-item-title">${s.name || '未命名'}</div>
          ${s.notes ? `<div class="list-item-sub">${s.notes}</div>` : ''}
        </div>
        <button class="btn btn-sm btn-secondary" onclick="Study.showEditSkill('${s.id}')">编辑</button>
      </div>
    `).join('');
  },

  showAddSkill() {
    const container = document.getElementById('page-container');
    container.innerHTML = `
      <div class="card page-enter">
        <div class="card-title"><span>添加技能</span><button class="btn btn-sm btn-secondary" onclick="App.refresh()">← 返回</button></div>
        <div class="form-group"><label class="form-label">技能名称</label><input class="input" id="skill-name" placeholder="如：Python、吉他…"></div>
        <div class="form-group"><label class="form-label">备注</label><textarea class="textarea" id="skill-notes" rows="4" placeholder="备注…"></textarea></div>
        <button class="btn btn-primary" onclick="Study.saveSkill()">保存</button>
      </div>
    `;
  },

  saveSkill() {
    const name = document.getElementById('skill-name')?.value;
    if (!name) { alert('请输入技能名称'); return; }
    const notes = document.getElementById('skill-notes')?.value || '';
    this.addSkill({ name, notes });
    App.refresh();
  },

  showEditSkill(id) {
    const skill = Store.getItem(this.SKILLS_KEY, id);
    if (!skill) return;
    const container = document.getElementById('page-container');
    container.innerHTML = `
      <div class="card page-enter">
        <div class="card-title"><span>编辑技能</span><button class="btn btn-sm btn-secondary" onclick="App.refresh()">← 返回</button></div>
        <div class="form-group"><label class="form-label">技能名称</label><input class="input" id="skill-name" value="${skill.name}"></div>
        <div class="form-group"><label class="form-label">备注</label><textarea class="textarea" id="skill-notes" rows="4">${skill.notes || ''}</textarea></div>
        <button class="btn btn-primary" onclick="Study.saveEditSkill('${id}')">保存</button>
      </div>
    `;
  },

  saveEditSkill(id) {
    const name = document.getElementById('skill-name')?.value;
    if (!name) { alert('请输入技能名称'); return; }
    const notes = document.getElementById('skill-notes')?.value || '';
    this.updateSkill(id, { name, notes });
    App.refresh();
  },

  /* 获取学习时长图表数据（仪表盘用） */
  getStudyChartData(days) {
    days = days || 7;
    const data = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = Utils.formatDate(d);
      data.push({
        label: dateStr.slice(5),
        value: this.getDurationByDate(dateStr),
        date: dateStr
      });
    }
    return data;
  }
};
