/* ============================================
   Extras - 扩展功能模块
   日程表、目标清单
   ============================================ */

const Extras = {
  /* ==========================================
     日程表
     ========================================== */
  SCHEDULE_KEY: 'weekly_schedule',
  defaultWeekdays: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],

  getSchedule() {
    return Store.get(this.SCHEDULE_KEY, {});
  },

  saveSchedule(schedule) {
    Store.set(this.SCHEDULE_KEY, schedule);
  },

  getTodaySchedule() {
    const day = new Date().getDay();
    const sched = this.getSchedule();
    return sched[day] || [];
  },

  /* ==========================================
     目标清单
     ========================================== */
  GOALS_KEY: 'goal_list',

  getGoals() { return Store.getList(this.GOALS_KEY); },

  addGoal(data) {
    return Store.addItem(this.GOALS_KEY, {
      ...data,
      done: false,
      progress: data.progress || 0,
      logs: [],                    /* 推进记录，见下面「目标的推进记录」一节 */
      createdAt: new Date().toISOString()
    });
  },

  updateGoal(id, data) { return Store.updateItem(this.GOALS_KEY, id, data); },

  deleteGoal(id) { return Store.removeItem(this.GOALS_KEY, id); },

  toggleGoal(id) {
    const g = Store.getItem(this.GOALS_KEY, id);
    if (g) {
      g.done = !g.done;
      if (g.done) g.progress = 100;
      Store.updateItem(this.GOALS_KEY, id, g);
    }
  },

  /* ==========================================
     目标的推进记录

     结构见 Utils.getLogs —— goal.logs / book.logs / skill.logs 是同一套，
     记录挂在对象内部，跟着父对象一起被 doc 同步带走，不用单写同步逻辑。
     这里只负责「目标」这一路。
     ========================================== */

  getGoalLogs(goal) { return Utils.getLogs(goal); },

  /* 在目标页直接记一笔，不用进编辑页 */
  addGoalLog(id) {
    const text = Utils.readLogInput(id);
    if (!text) return;

    const goal = Store.getItem(this.GOALS_KEY, id);
    if (!goal) return;

    this.updateGoal(id, { logs: Utils.appendLog(goal, text) });

    this.renderGoalsPage(document.getElementById('page-container'));
    Utils.focusLogInput(id);      /* 重渲染会丢焦点，放回去才能连着记好几条 */
  },

  deleteGoalLog(id, logId) {
    const goal = Store.getItem(this.GOALS_KEY, id);
    if (!goal) return;
    this.updateGoal(id, { logs: Utils.removeLog(goal, logId) });
    this.renderGoalsPage(document.getElementById('page-container'));
  },

  /* ==========================================
     日程表页面
     ========================================== */
  renderSchedulePage(container) {
    const todayIdx = new Date().getDay();

    container.innerHTML = `
      <div class="card page-enter">
        <div class="card-title">
          <span>日程表</span>
          <button class="btn btn-sm btn-secondary" onclick="App.navigate('dashboard')">← 返回</button>
          <button class="btn btn-sm btn-primary" onclick="Extras.showEditSchedule()">编辑</button>
        </div>
        <div class="tabs" id="schedule-tabs">
          ${this.defaultWeekdays.map((name, i) =>
            `<button class="tab ${i === todayIdx ? 'active' : ''}" onclick="Extras.switchScheduleDay(${i},this)">${name}</button>`
          ).join('')}
        </div>
        <div id="schedule-today">
          ${this.renderScheduleDay(todayIdx)}
        </div>
      </div>
    `;
  },

  switchScheduleDay(idx, btn) {
    Utils.$$('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('schedule-today').innerHTML = this.renderScheduleDay(idx);
  },

  renderScheduleDay(idx) {
    const schedule = this.getSchedule();
    const slots = schedule[idx] || [];
    const now = Utils.formatTime(new Date());

    if (slots.length === 0) {
      return '<div class="empty-state-text">该天暂无安排，点编辑添加</div>';
    }

    return slots.map(s => {
      return `
        <div class="list-item" style="${s.time === now ? 'background:var(--bg-hover);border-radius:8px;padding:10px 12px;' : ''}">
          <span style="font-weight:500;min-width:48px;font-size:0.88rem;">${s.time}</span>
          <span class="text-sm" style="flex:1;">${s.activity}</span>
          ${s.time === now ? '<span class="badge badge-blue">现在</span>' : ''}
        </div>
      `;
    }).join('');
  },

  showEditSchedule() {
    const container = document.getElementById('page-container');
    /* 初始化编辑缓冲：从已保存的日程复制 */
    this._editSlots = [];
    const schedule = this.getSchedule();
    this.defaultWeekdays.forEach((_, i) => {
      this._editSlots[i] = (schedule[i] || []).map(s => ({ ...s }));
    });
    container.innerHTML = `
      <div class="card page-enter">
        <div class="card-title">
          <span>编辑日程表</span>
          <button class="btn btn-sm btn-secondary" onclick="Extras.renderSchedulePage(document.getElementById('page-container'))">← 返回</button>
          <button class="btn btn-sm btn-success" onclick="Extras.saveEditedSchedule()">保存</button>
        </div>
        <div class="form-group">
          <label class="form-label">选择星期</label>
          <select class="select" id="edit-sched-day" onchange="Extras.loadScheduleDay(this.value)">
            ${this.defaultWeekdays.map((n,i) => `<option value="${i}">${n}</option>`).join('')}
          </select>
        </div>
        <div id="edit-schedule-slots">
          ${this.renderScheduleEditor(0)}
        </div>
        <button class="btn btn-sm btn-secondary mt-16" onclick="Extras.addScheduleSlot()">+ 添加时段</button>
      </div>
    `;
  },

  renderScheduleEditor(dayIdx) {
    const slots = this._editSlots[dayIdx] || [];
    return slots.map((s, i) => `
      <div class="flex gap-8 items-center mb-8" data-slot="${i}">
        <input type="time" class="input" style="width:90px;padding:4px 6px;font-size:0.82rem;" value="${s.time}" onchange="Extras._editSlots[${dayIdx}][${i}].time=this.value">
        <input class="input" style="flex:1;padding:4px 8px;font-size:0.82rem;" value="${s.activity}" placeholder="活动" onchange="Extras._editSlots[${dayIdx}][${i}].activity=this.value">
        <button class="btn btn-sm btn-danger" onclick="Extras.removeScheduleSlot(${dayIdx},${i})">×</button>
      </div>
    `).join('');
  },

  _editSlots: [],

  loadScheduleDay(dayIdx) {
    const idx = parseInt(dayIdx);
    const el = document.getElementById('edit-schedule-slots');
    el.innerHTML = this.renderScheduleEditor(idx);
  },

  addScheduleSlot() {
    const daySel = document.getElementById('edit-sched-day');
    const idx = parseInt(daySel.value);
    if (!this._editSlots[idx]) this._editSlots[idx] = [];
    this._editSlots[idx].push({ time: '12:00', activity: '' });
    this.loadScheduleDay(idx);
  },

  removeScheduleSlot(dayIdx, slotIdx) {
    if (!this._editSlots[dayIdx]) return;
    this._editSlots[dayIdx].splice(slotIdx, 1);
    this.loadScheduleDay(dayIdx);
  },

  saveEditedSchedule() {
    this._editSlots.forEach((slots, i) => {
      if (slots) {
        const schedule = this.getSchedule();
        schedule[i] = slots;
        this.saveSchedule(schedule);
      }
    });
    this._editSlots = [];
    Extras.renderSchedulePage(document.getElementById('page-container'));
  },

  /* ==========================================
     目标清单页面
     ========================================== */
  renderGoalsPage(container) {
    const goals = this.getGoals();
    const active = goals.filter(g => !g.done);
    const done = goals.filter(g => g.done);

    /* 一个目标的完整块：标题行 + 已有记录 + （进行中的才有）随手记输入框 */
    const itemHtml = (g, withForm) => {
      const sub = [g.note || '', g.deadline ? '截止 ' + g.deadline : ''].filter(Boolean).join(' · ');

      const logsHtml = Utils.logsHtml(g, (gid, lid) => `Extras.deleteGoalLog('${gid}','${lid}')`);

      const head = withForm
        ? `<div class="list-item">
             <div class="habit-check" onclick="Extras.toggleGoal('${g.id}');Extras.renderGoalsPage(document.getElementById('page-container'))"></div>
             <div class="list-item-main">
               <div class="list-item-title">${Utils.esc(g.title)}</div>
               ${sub ? `<div class="list-item-sub">${Utils.esc(sub)}</div>` : ''}
             </div>
             <button class="btn btn-sm btn-secondary" onclick="Extras.showEditGoal('${g.id}')">编辑</button>
             <button class="btn btn-sm btn-danger" onclick="Extras.deleteGoal('${g.id}');Extras.renderGoalsPage(document.getElementById('page-container'))">×</button>
           </div>`
        : `<div class="list-item">
             <div class="habit-check done" onclick="Extras.toggleGoal('${g.id}');Extras.renderGoalsPage(document.getElementById('page-container'))"></div>
             <div class="list-item-main">
               <div class="list-item-title" style="text-decoration:line-through;color:var(--text-muted)">${Utils.esc(g.title)}</div>
             </div>
             <button class="btn btn-sm btn-danger" onclick="Extras.deleteGoal('${g.id}');Extras.renderGoalsPage(document.getElementById('page-container'))">×</button>
           </div>`;

      /* 已完成的没人会去记推进，就不摆输入框了 —— 少一排噪音 */
      const formHtml = withForm
        ? Utils.logFormHtml(g.id, `Extras.addGoalLog('${g.id}')`, '记一笔推进…（回车提交）')
        : '';

      return `<div class="track-item">${head}${logsHtml}${formHtml}</div>`;
    };

    container.innerHTML = `
      <div class="card page-enter mb-16">
        <div class="card-title">
          <span>目标清单</span>
          <button class="btn btn-sm btn-secondary" onclick="App.navigate('dashboard')">← 返回</button>
          <button class="btn btn-sm btn-primary" onclick="Extras.showAddGoal()">+ 添加</button>
        </div>
      </div>
      <div class="card mb-16">
        <div class="card-title"><span>进行中 (${active.length})</span></div>
        ${active.length === 0 ? '<div class="empty-state-text">暂无目标</div>' : active.map(g => itemHtml(g, true)).join('')}
      </div>
      ${done.length > 0 ? `
      <div class="card">
        <div class="card-title"><span>已完成 (${done.length})</span></div>
        ${done.map(g => itemHtml(g, false)).join('')}
      </div>` : ''}
    `;
  },

  showAddGoal() {
    const container = document.getElementById('page-container');
    container.innerHTML = `
      <div class="card page-enter">
        <div class="card-title"><span>添加目标</span><button class="btn btn-sm btn-secondary" onclick="Extras.renderGoalsPage(document.getElementById('page-container'))">← 返回</button></div>
        <div class="form-group"><label class="form-label">目标名称</label><input class="input" id="goal-title" placeholder="如：学完 Spring Boot、跑通 WMS 项目…"></div>
        <div class="form-group"><label class="form-label">备注</label><textarea class="textarea" id="goal-note" rows="3" placeholder="可选"></textarea></div>
        <button class="btn btn-primary" onclick="Extras.saveGoal()">保存</button>
      </div>
    `;
  },

  saveGoal() {
    const title = document.getElementById('goal-title')?.value;
    if (!title) { alert('请输入目标名称'); return; }
    const note = document.getElementById('goal-note')?.value || '';
    this.addGoal({ title, note });
    this.renderGoalsPage(document.getElementById('page-container'));
  },

  showEditGoal(id) {
    const g = Store.getItem(this.GOALS_KEY, id);
    if (!g) return;
    const container = document.getElementById('page-container');
    container.innerHTML = `
      <div class="card page-enter">
        <div class="card-title"><span>编辑目标</span><button class="btn btn-sm btn-secondary" onclick="Extras.renderGoalsPage(document.getElementById('page-container'))">← 返回</button></div>
        <div class="form-group"><label class="form-label">目标名称</label><input class="input" id="goal-title" value="${g.title}"></div>
        <div class="form-group"><label class="form-label">备注</label><textarea class="textarea" id="goal-note" rows="3">${g.note || ''}</textarea></div>
        <button class="btn btn-primary" onclick="Extras.saveEditGoal('${id}')">保存</button>
      </div>
    `;
  },

  saveEditGoal(id) {
    const title = document.getElementById('goal-title')?.value;
    if (!title) { alert('请输入目标名称'); return; }
    const note = document.getElementById('goal-note')?.value || '';
    /* 表单里已经没有截止日期和进度了，所以只更新这两项。
       Store.updateItem 是浅合并，老数据里残留的 deadline / progress 会原样留着，
       不在这里抹掉 —— 万一以后还想要，数据还在。 */
    this.updateGoal(id, { title, note });
    this.renderGoalsPage(document.getElementById('page-container'));
  }
};
