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
      status: data.status || 'reading',
      logs: []                    /* 跟进记录，结构见 Utils.getLogs */
    });
  },

  updateBook(id, data) { return Store.updateItem(this.BOOKS_KEY, id, data); },

  deleteBook(id) {
    Store.removeItem(this.BOOKS_KEY, id);
    this.renderStudyPage(document.getElementById('page-container'));
  },

  /* ---- 技能清单 ---- */
  getSkills() { return Store.getList(this.SKILLS_KEY); },

  addSkill(data) {
    return Store.addItem(this.SKILLS_KEY, {
      ...data,
      status: data.status || 'active',
      logs: []                    /* 跟进记录，结构见 Utils.getLogs */
    });
  },

  updateSkill(id, data) {
    return Store.updateItem(this.SKILLS_KEY, id, data);
  },

  deleteSkill(id) {
    Store.removeItem(this.SKILLS_KEY, id);
    this.renderStudyPage(document.getElementById('page-container'));
  },

  /* ---- 书 / 技能的跟进记录 ----
     跟目标是同一套：记录挂在对象内部的 logs 上，跟着父对象一起同步，
     所以要专门写的只有「读输入框 → 追加 → 重渲染 → 焦点放回去」这四步。 */
  addBookLog(id) { this._addLog(this.BOOKS_KEY, id); },
  addSkillLog(id) { this._addLog(this.SKILLS_KEY, id); },
  deleteBookLog(id, logId) { this._deleteLog(this.BOOKS_KEY, id, logId); },
  deleteSkillLog(id, logId) { this._deleteLog(this.SKILLS_KEY, id, logId); },

  _addLog(key, id) {
    const text = Utils.readLogInput(id);
    if (!text) return;

    const item = Store.getItem(key, id);
    if (!item) return;

    /* 必须传整个新数组 —— Store.updateItem 是浅合并，只传新那条会把旧记录覆盖掉 */
    Store.updateItem(key, id, { logs: Utils.appendLog(item, text) });

    this.renderStudyPage(document.getElementById('page-container'));
    Utils.focusLogInput(id);
  },

  _deleteLog(key, id, logId) {
    const item = Store.getItem(key, id);
    if (!item) return;
    Store.updateItem(key, id, { logs: Utils.removeLog(item, logId) });
    this.renderStudyPage(document.getElementById('page-container'));
  },

  /* ---- 勾选完成 / 取消归档（局部刷新 + 单条目滑动动画） ---- */
  toggleBookDone(id) { this._toggleDone(this.BOOKS_KEY, 'book', id); },

  toggleSkillDone(id) { this._toggleDone(this.SKILLS_KEY, 'skill', id); },

  _toggleDone(key, kind, id) {
    const el = document.getElementById(kind === 'book' ? 'study-book-list' : 'study-skill-list');
    if (!el) return;

    /* First：记录各条目当前位置（量的是整块 .track-item，
       因为它下面还挂着记录和输入框，只量标题行会跟记录脱节） */
    const firstPos = {};
    [...el.querySelectorAll('.track-item')].forEach(item => {
      firstPos[item.dataset.id] = item.getBoundingClientRect().top;
    });

    const item = Store.getItem(key, id);
    if (!item) return;

    /* 取消完成要退回「原本那个进行中状态」：书是 reading，技能是 active */
    item.status = item.status === 'done' ? (kind === 'book' ? 'reading' : 'active') : 'done';
    Store.updateItem(key, id, item);

    el.innerHTML = this._renderList(key, kind);
    this._animateReorder(el, firstPos);
  },

  /* FLIP 动画：条目从原位平滑滑到重排后的新位置 */
  _animateReorder(listEl, firstPos) {
    [...listEl.querySelectorAll('.track-item')].forEach(el => {
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

  /* ---- 渲染 ---- */
  renderStudyPage(container) {
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
      <div class="card mb-16">
        <div class="card-title">
          <span>书目荐读</span>
          <span class="text-sm" id="suggest-stat" style="margin-left:auto;margin-right:10px;"></span>
          <button class="btn btn-sm btn-secondary" onclick="Suggestions.load()">刷新</button>
        </div>
        <div id="suggest-body"><div class="empty-state-text">正在读取…</div></div>
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

    /* 荐读列表是异步来的（要带令牌查服务端），所以卡片先渲染出来再填。
       刷新整页时它会重新拉一次 —— 这也是「通过了但没入库」能被补收的时机。 */
    if (typeof Suggestions !== 'undefined') Suggestions.load();
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

  /* ---- 书籍 / 技能列表 ----
     两边的结构完全一样：勾选完成 + 标题 + 备注 + 跟进记录 + 随手记输入框，
     所以共用一个渲染器，只有字段名（title / name）和按钮回调不同。 */
  renderBooks() { return this._renderList(this.BOOKS_KEY, 'book'); },

  renderSkills() { return this._renderList(this.SKILLS_KEY, 'skill'); },

  _renderList(key, kind) {
    const isBook = kind === 'book';
    const items = Store.getList(key);

    /* 进行中在前，已完成的沉底 */
    const sorted = [
      ...items.filter(x => x.status !== 'done'),
      ...items.filter(x => x.status === 'done')
    ];
    if (sorted.length === 0) {
      return `<div class="empty-state-text">暂无${isBook ? '书籍' : '技能'}，点击上方添加</div>`;
    }

    return sorted.map(x => {
      const done = x.status === 'done';
      const title = isBook ? (x.title || '未命名') : (x.name || '未命名');
      const toggle = isBook ? 'toggleBookDone' : 'toggleSkillDone';
      const del = isBook ? 'deleteBook' : 'deleteSkill';
      const addLog = isBook ? 'addBookLog' : 'addSkillLog';
      const delLog = isBook ? 'deleteBookLog' : 'deleteSkillLog';
      /* 只有技能有「编辑」（书名 + 备注就两个字段，改不如删了重加） */
      const editBtn = isBook ? '' :
        `<button class="btn btn-sm btn-secondary" onclick="Study.showEditSkill('${x.id}')">编辑</button>`;

      return `
        <div class="track-item" data-id="${x.id}">
          <div class="list-item${done ? ' archived' : ''}">
            <div class="habit-check${done ? ' done' : ''}" onclick="Study.${toggle}('${x.id}')"></div>
            <div class="list-item-main">
              <div class="list-item-title">${Utils.esc(title)}${x.from ? `<span class="from-tag">${Utils.esc(x.from)}推荐</span>` : ''}</div>
              ${x.notes ? `<div class="list-item-sub">${Utils.esc(x.notes)}</div>` : ''}
            </div>
            ${editBtn}
            <button class="btn btn-sm btn-danger" onclick="Study.${del}('${x.id}')">×</button>
          </div>
          ${Utils.logsHtml(x, (itemId, logId) => `Study.${delLog}('${itemId}','${logId}')`)}
          ${Utils.logFormHtml(x.id, `Study.${addLog}('${x.id}')`, '记一笔…（回车提交）')}
        </div>
      `;
    }).join('');
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
