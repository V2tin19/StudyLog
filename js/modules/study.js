/* ============================================
   Study - 学习打卡 / 自我提升模块
   包含学习台账、时长统计、任务管理、书籍、技能、专注计时
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

  /* ---- 任务管理 ---- */
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

  /* ---- 书籍管理 ---- */
  getBooks() { return Store.getList(this.BOOKS_KEY); },

  addBook(data) {
    return Store.addItem(this.BOOKS_KEY, {
      ...data,
      progress: data.progress || 0,
      status: data.status || 'reading'
    });
  },

  updateBookProgress(id, progress) {
    return Store.updateItem(this.BOOKS_KEY, id, {
      progress: Math.min(100, Math.max(0, progress)),
      status: progress >= 100 ? 'done' : 'reading'
    });
  },

  deleteBook(id) { return Store.removeItem(this.BOOKS_KEY, id); },

  /* ---- 技能清单 ---- */
  getSkills() { return Store.getList(this.SKILLS_KEY); },

  addSkill(data) {
    return Store.addItem(this.SKILLS_KEY, {
      ...data,
      progress: data.progress || 0
    });
  },

  updateSkill(id, data) {
    return Store.updateItem(this.SKILLS_KEY, id, data);
  },

  deleteSkill(id) { return Store.removeItem(this.SKILLS_KEY, id); },

  /* ---- 打卡签到 ---- */
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

  /* ---- 专注计时器 ---- */
  _timerInterval: null,
  _timerRunning: false,
  _timerSeconds: 0,
  _timerMode: 'countup',
  _timerTarget: 0,
  _timerStartTime: null,

  startTimer(mode, targetMinutes) {
    if (this._timerRunning) return;
    this._timerRunning = true;
    this._timerMode = mode || 'countup';
    this._timerTarget = (targetMinutes || 0) * 60;
    if (mode === 'countdown') this._timerSeconds = this._timerTarget;
    else this._timerSeconds = 0;
    this._timerStartTime = Date.now();

    this._timerInterval = setInterval(() => {
      if (this._timerMode === 'countup') {
        this._timerSeconds++;
      } else {
        this._timerSeconds = Math.max(0, this._timerTarget - Math.floor((Date.now() - this._timerStartTime) / 1000));
      }
      this.updateTimerDisplay();
      if (this._timerMode === 'countdown' && this._timerSeconds <= 0) {
        this.stopTimer(true);
      }
    }, 1000);
  },

  stopTimer(autoSave) {
    this._timerRunning = false;
    if (this._timerInterval) {
      clearInterval(this._timerInterval);
      this._timerInterval = null;
    }
    if (autoSave && this._timerSeconds > 0) {
      const minutes = Math.ceil(this._timerSeconds / 60);
      this.addSession({
        subject: '专注计时',
        content: `专注了 ${this.formatDuration(minutes)}`,
        duration: minutes,
        date: Utils.today()
      });
    }
  },

  resetTimer() {
    this.stopTimer(false);
    this._timerSeconds = 0;
    this.updateTimerDisplay();
  },

  updateTimerDisplay() {
    const el = document.getElementById('timer-display');
    if (!el) return;
    const mins = Math.floor(this._timerSeconds / 60);
    const secs = this._timerSeconds % 60;
    el.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  },

  getTimerSeconds() { return this._timerSeconds; },

  /* ---- 渲染 ---- */
  renderStudyPage(container) {
    const today = Utils.today();
    const checkedIn = this.isCheckedIn(today);
    const streak = this.getStreak();
    const todaySessions = this.getTodaySessions();
    const todayDuration = this.getTotalDuration(todaySessions);
    const monthDuration = this.getDurationByMonth(today);
    const todayTasks = this.getTodayTasks();
    const doneTasks = todayTasks.filter(t => t.done).length;

    container.innerHTML = `
      <div class="card-grid card-grid-2">
        <div class="card">
          <div class="card-title"><span>打卡签到</span></div>
          <div class="text-center">
            <div class="stat-value" style="font-size:2rem;">${checkedIn ? '已签到' : '未签到'}</div>
            <div class="mt-8">
              <button class="btn ${checkedIn ? 'btn-secondary' : 'btn-primary'}" onclick="Study.toggleCheckin()">
                ${checkedIn ? '已签到' : '今日打卡'}
              </button>
            </div>
            <div class="text-sm text-muted mt-8">连续 ${streak.current} 天 · 最长 ${streak.max} 天</div>
          </div>
        </div>
        <div class="card">
          <div class="card-title"><span>今日学习</span></div>
          <div class="text-center">
            <div class="stat-value">${this.formatDuration(todayDuration)}</div>
            <div class="text-sm text-muted mt-8">本月累计 ${this.formatDuration(monthDuration)}</div>
          </div>
        </div>
      </div>
      <div class="card mt-16">
        <div class="card-title">
          <span>今日任务 (${doneTasks}/${todayTasks.length})</span>
          <button class="btn btn-sm btn-primary" onclick="Study.showAddTask()">+ 添加</button>
        </div>
        <div id="study-task-list">
          ${todayTasks.length === 0 ? '<div class="empty-state-text">暂无今日任务</div>' :
            todayTasks.map(t => `
              <div class="list-item">
                <div class="habit-check${t.done ? ' done' : ''}" onclick="Study.toggleTask('${t.id}');App.refresh()"></div>
                <div class="list-item-main">
                  <div class="list-item-title" style="${t.done ? 'text-decoration:line-through;color:var(--text-muted)' : ''}">${t.title}</div>
                  ${t.note ? `<div class="list-item-sub">${t.note}</div>` : ''}
                </div>
                <button class="btn btn-sm btn-danger" onclick="Study.deleteTask('${t.id}');App.refresh()">×</button>
              </div>
            `).join('')}
        </div>
      </div>
      <div class="card mt-16">
        <div class="card-title">
          <span>学习台账</span>
          <button class="btn btn-sm btn-primary" onclick="Study.showAddSession()">+ 记录</button>
        </div>
        <div id="study-sessions">
          ${this.renderSessionList()}
        </div>
      </div>
      <div class="card mt-16">
        <div class="tabs">
          <button class="tab active" onclick="Study.switchStudyTab('books',this)">书籍</button>
          <button class="tab" onclick="Study.switchStudyTab('skills',this)">技能</button>
          <button class="tab" onclick="Study.switchStudyTab('timer',this)">专注计时</button>
        </div>
        <div id="study-sub-content">${this.renderBooks()}</div>
      </div>
    `;
  },

  toggleCheckin() {
    const today = Utils.today();
    if (this.isCheckedIn(today)) {
      Store.setDate(this.CHECKIN_KEY, today, false);
    } else {
      this.checkin(today);
    }
    App.refresh();
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

  showAddTask() {
    const container = document.getElementById('page-container');
    container.innerHTML = `
      <div class="card page-enter">
        <div class="card-title"><span>添加任务</span><button class="btn btn-sm btn-secondary" onclick="App.refresh()">← 返回</button></div>
        <div class="form-group">
          <label class="form-label">任务名称</label>
          <input class="input" id="task-title" placeholder="学习任务…">
        </div>
        <div class="form-group">
          <label class="form-label">备注</label>
          <textarea class="textarea" id="task-note" rows="3" placeholder="备注或原因…"></textarea>
        </div>
        <div class="form-group">
          <label class="form-label">日期</label>
          <input class="input" id="task-date" type="date" value="${Utils.today()}">
        </div>
        <button class="btn btn-primary" onclick="Study.saveTask()">保存</button>
      </div>
    `;
  },

  saveTask() {
    const title = document.getElementById('task-title')?.value;
    if (!title) { alert('请输入任务名称'); return; }
    const note = document.getElementById('task-note')?.value || '';
    const date = document.getElementById('task-date')?.value || Utils.today();
    this.addTask({ title, note, date });
    App.refresh();
  },

  switchStudyTab(tab, btn) {
    Utils.$$('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    const el = document.getElementById('study-sub-content');
    if (tab === 'books') el.innerHTML = this.renderBooks();
    else if (tab === 'skills') el.innerHTML = this.renderSkills();
    else if (tab === 'timer') el.innerHTML = this.renderTimer();
  },

  renderBooks() {
    const books = this.getBooks();
    let html = `<div class="flex justify-between items-center mb-16"><span></span>
      <button class="btn btn-sm btn-primary" onclick="Study.showAddBook()">+ 添加书籍</button></div>`;
    if (books.length === 0) return html + '<div class="empty-state-text">暂无书籍记录</div>';
    html += books.map(b => `
      <div class="list-item">
        <div class="list-item-main">
          <div class="list-item-title">${b.title || '未命名'}</div>
          <div class="list-item-sub">${b.author || ''} ${b.status === 'done' ? '已读完' : `· ${b.progress || 0}%`}</div>
          <div class="progress-bar mt-8"><div class="progress-fill" style="width:${b.progress || 0}%"></div></div>
          ${b.notes ? `<div class="text-sm text-muted mt-8">${b.notes}</div>` : ''}
        </div>
        <button class="btn btn-sm btn-danger" onclick="Study.deleteBook('${b.id}');App.refresh()">×</button>
      </div>
    `).join('');
    return html;
  },

  showAddBook() {
    const container = document.getElementById('page-container');
    container.innerHTML = `
      <div class="card page-enter">
        <div class="card-title"><span>添加书籍</span><button class="btn btn-sm btn-secondary" onclick="App.refresh()">← 返回</button></div>
        <div class="form-group"><label class="form-label">书名</label><input class="input" id="book-title"></div>
        <div class="form-group"><label class="form-label">作者</label><input class="input" id="book-author"></div>
        <div class="form-group"><label class="form-label">阅读进度 (%)</label><input class="input" id="book-progress" type="number" min="0" max="100" value="0"></div>
        <div class="form-group"><label class="form-label">笔记/摘抄</label><textarea class="textarea" id="book-notes" rows="4"></textarea></div>
        <button class="btn btn-primary" onclick="Study.saveBook()">保存</button>
      </div>
    `;
  },

  saveBook() {
    const title = document.getElementById('book-title')?.value || '未命名';
    const author = document.getElementById('book-author')?.value || '';
    const progress = parseInt(document.getElementById('book-progress')?.value) || 0;
    const notes = document.getElementById('book-notes')?.value || '';
    this.addBook({ title, author, progress, notes });
    App.refresh();
  },

  renderSkills() {
    const skills = this.getSkills();
    let html = `<div class="flex justify-between items-center mb-16"><span></span>
      <button class="btn btn-sm btn-primary" onclick="Study.showAddSkill()">+ 添加技能</button></div>`;
    if (skills.length === 0) return html + '<div class="empty-state-text">暂无技能清单</div>';
    html += skills.map(s => `
      <div class="list-item">
        <div class="list-item-main">
          <div class="list-item-title">${s.name}</div>
          <div class="list-item-sub">${s.notes || ''}</div>
          <div class="progress-bar mt-8"><div class="progress-fill" style="width:${s.progress || 0}%"></div></div>
        </div>
        <div class="flex gap-8">
          <button class="btn btn-sm btn-secondary" onclick="Study.showEditSkill('${s.id}')">编辑</button>
          <button class="btn btn-sm btn-danger" onclick="Study.deleteSkill('${s.id}');App.refresh()">×</button>
        </div>
      </div>
    `).join('');
    return html;
  },

  showAddSkill() {
    const container = document.getElementById('page-container');
    container.innerHTML = `
      <div class="card page-enter">
        <div class="card-title"><span>添加技能</span><button class="btn btn-sm btn-secondary" onclick="App.refresh()">← 返回</button></div>
        <div class="form-group"><label class="form-label">技能名称</label><input class="input" id="skill-name" placeholder="如：Python、吉他…"></div>
        <div class="form-group"><label class="form-label">掌握程度 (%)</label><input class="input" id="skill-progress" type="number" min="0" max="100" value="0"></div>
        <div class="form-group"><label class="form-label">学习感悟</label><textarea class="textarea" id="skill-notes" rows="4"></textarea></div>
        <button class="btn btn-primary" onclick="Study.saveSkill()">保存</button>
      </div>
    `;
  },

  saveSkill() {
    const name = document.getElementById('skill-name')?.value || '未命名';
    const progress = parseInt(document.getElementById('skill-progress')?.value) || 0;
    const notes = document.getElementById('skill-notes')?.value || '';
    this.addSkill({ name, progress, notes });
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
        <div class="form-group"><label class="form-label">掌握程度 (%)</label><input class="input" id="skill-progress" type="number" min="0" max="100" value="${skill.progress}"></div>
        <div class="form-group"><label class="form-label">学习感悟</label><textarea class="textarea" id="skill-notes" rows="4">${skill.notes || ''}</textarea></div>
        <button class="btn btn-primary" onclick="Study.saveEditSkill('${id}')">保存</button>
      </div>
    `;
  },

  saveEditSkill(id) {
    const name = document.getElementById('skill-name')?.value;
    const progress = parseInt(document.getElementById('skill-progress')?.value) || 0;
    const notes = document.getElementById('skill-notes')?.value || '';
    this.updateSkill(id, { name, progress, notes });
    App.refresh();
  },

  renderTimer() {
    return `
      <div class="text-center">
        <div class="timer-display" id="timer-display">00:00</div>
        <div class="timer-controls">
          <button class="btn btn-primary" id="timer-start-btn" onclick="Study.startTimer('countup', 0)">开始</button>
          <button class="btn btn-danger" id="timer-stop-btn" onclick="Study.stopTimer(true)">停止并记录</button>
          <button class="btn btn-secondary" onclick="Study.resetTimer()">重置</button>
        </div>
        <div class="flex gap-8 justify-center mt-16">
          <button class="btn btn-sm btn-secondary" onclick="Study.startTimer('countdown', 25)">25分钟</button>
          <button class="btn btn-sm btn-secondary" onclick="Study.startTimer('countdown', 45)">45分钟</button>
          <button class="btn btn-sm btn-secondary" onclick="Study.startTimer('countdown', 60)">60分钟</button>
        </div>
      </div>
    `;
  },

  /* 获取学习时长图表数据 */
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