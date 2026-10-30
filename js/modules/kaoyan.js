/* ============================================
   Kaoyan - 考研页
   今日时段计划 / 考试倒计时 / 最近七天学习量

   数据分工：
   · 计划存在云端 doc 的 kaoyan key 里，由 QQ bot（或任何拿令牌的
     AI agent）写入 —— 这个页面只读，编辑交给 bot 说人话完成。
   · 学习记录沿用 Study 的 study_sessions（bot 通过服务端合并接口
     写进去的记录和网页记的完全同构），所以「最近七天」直接读本地缓存。
   ============================================ */

const Kaoyan = {
  PLAN_CACHE_KEY: 'kaoyan_plan',

  /* 每周模板的星期名，与 Extras.defaultWeekdays 同序（'0' 是周日） */
  WEEKDAYS: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],

  getPlan() { return Store.get(this.PLAN_CACHE_KEY, null); },

  setPlan(plan) { Store.set(this.PLAN_CACHE_KEY, plan); },

  /* 某天的时段：days 具体日优先，落到每周模板（与 bot 端 planner.py 同规则） */
  dayPlan(plan, dateStr) {
    if (!plan) return [];
    const day = (plan.days || {})[dateStr];
    if (day && Array.isArray(day.slots)) return day.slots;
    const tplKey = String(Utils.parseDate(dateStr).getDay());   /* getDay(): 0=周日 */
    const tpl = (plan.template || {})[tplKey];
    return Array.isArray(tpl) ? tpl : [];
  },

  countdown(plan) {
    const exam = plan && plan.examDate;
    if (!exam || !/^\d{4}-\d{2}-\d{2}$/.test(exam)) return null;
    const diff = Math.round((Utils.parseDate(exam) - Utils.parseDate(Utils.today())) / 86400000);
    if (diff < 0) return { text: '初试已结束', days: null };
    if (diff === 0) return { text: '今天初试！稳住 🎯', days: 0 };
    return { text: `距离初试还有 <b>${diff}</b> 天`, days: diff };
  },

  /* ============ 页面 ============ */
  render(container) {
    const cached = this.getPlan();
    const cd = this.countdown(cached);

    container.innerHTML = `
      <div class="card page-enter mb-16">
        <div class="card-title">
          <span>考研 · 自习计划</span>
          <button class="btn btn-sm btn-secondary" onclick="Kaoyan.pullPlan(this)">↻ 从云端刷新</button>
        </div>
        <div id="kaoyan-countdown">${this._countdownHtml(cached)}</div>
        <div class="text-sm" style="color:var(--text-muted);margin-top:4px;">
          计划由 QQ bot 里的 AI 维护：对 bot 说「重排本周计划」生成，「今天状态不好」即可按状态调整，网页这里会自动跟上。
        </div>
      </div>

      <div class="card mb-16">
        <div class="card-title"><span>今日安排</span></div>
        <div id="kaoyan-today">${this.renderToday(cached)}</div>
      </div>

      <div class="card mb-16">
        <div class="card-title"><span>最近 7 天</span></div>
        ${this.renderWeek()}
      </div>

      <div class="card">
        <div class="card-title"><span>Bot 速查</span></div>
        <div class="list-item"><span class="text-sm">记学习</span><span class="text-sm" style="color:var(--text-muted)">「今天下午学了2小时数据结构」</span></div>
        <div class="list-item"><span class="text-sm">查安排</span><span class="text-sm" style="color:var(--text-muted)">「今天安排」「现在该学什么」</span></div>
        <div class="list-item"><span class="text-sm">调状态</span><span class="text-sm" style="color:var(--text-muted)">「今天状态不好」「明天有事」</span></div>
        <div class="list-item"><span class="text-sm">周总结</span><span class="text-sm" style="color:var(--text-muted)">「本周总结」</span></div>
      </div>
    `;

    /* 云端拉新计划（异步），拉到就整页重画 */
    if (Cloud.getToken()) this.pullPlan();
  },

  _countdownHtml(plan) {
    const cd = this.countdown(plan);
    if (!cd) {
      return '<div class="empty-state-text">还没设置考试日期 —— 跟 bot 说「考试日期 2026-12-26」</div>';
    }
    return `<div style="font-size:1.5rem;font-weight:600;">${cd.text}</div>
            <div class="text-sm" style="color:var(--text-muted);">初试：${plan.examDate}</div>`;
  },

  /* ============ 今日安排 ============ */
  renderToday(plan) {
    const today = Utils.today();
    const slots = this.dayPlan(plan, today);
    if (!slots.length) {
      return '<div class="empty-state-text">今天还没有安排。跟 bot 说「重排本周计划」生成一份</div>';
    }

    const now = Utils.formatTime(new Date());
    return slots.map(s => {
      const st = String(s.start || ''), en = String(s.end || '');
      const isNow = st <= now && now < en;
      const past = en && en <= now;
      const style = past ? 'opacity:0.5;' : (isNow ? 'background:var(--bg-hover);border-radius:8px;padding:10px 12px;' : '');
      const badge = isNow ? '<span class="badge badge-blue">现在</span>' : '';
      const topic = s.topic ? `<div class="text-sm" style="color:var(--text-muted);">${Utils.esc(s.topic)}</div>` : '';
      return `
        <div class="list-item" style="${style}">
          <span style="font-weight:500;min-width:90px;font-size:0.85rem;">${Utils.esc(st)}-${Utils.esc(en)}</span>
          <div style="flex:1;">
            <span class="text-sm" style="font-weight:500;">${Utils.esc(s.subject || '')}</span>
            ${topic}
          </div>
          ${badge}
        </div>`;
    }).join('');
  },

  /* ============ 最近 7 天 ============ */
  renderWeek() {
    const sessions = Store.get(Study.SESSIONS_KEY, []) || [];
    const rows = [];
    let maxMin = 0;

    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const ds = Utils.formatDate(d);
      const daySessions = sessions.filter(s => s.date === ds);
      const mins = daySessions.reduce((a, s) => a + (s.duration || 0), 0);
      maxMin = Math.max(maxMin, mins);
      rows.push({ ds, label: ds.slice(5), isToday: i === 0, mins,
                  subjects: [...new Set(daySessions.map(s => s.subject))] });
    }

    if (maxMin === 0 && rows.every(r => r.mins === 0)) {
      return '<div class="empty-state-text">还没有学习记录 —— 用 bot 说一句「今天学了2小时数学」试试</div>';
    }

    return rows.map(r => {
      const pct = maxMin > 0 ? Math.round((r.mins / maxMin) * 100) : 0;
      const sub = r.subjects.length ? ' · ' + Utils.esc(r.subjects.join('、')) : '';
      return `
        <div class="list-item" style="display:block;padding:8px 12px;">
          <div class="flex gap-8 items-center">
            <span class="text-sm" style="min-width:44px;">${r.label}${r.isToday ? '（今）' : ''}</span>
            <div style="flex:1;height:8px;background:var(--bg-hover);border-radius:4px;overflow:hidden;">
              <div style="height:100%;width:${pct}%;background:var(--accent-blue);border-radius:4px;"></div>
            </div>
            <span class="text-sm" style="min-width:76px;text-align:right;">${Study.formatDuration(r.mins)}</span>
          </div>
          ${sub ? `<div class="text-sm" style="color:var(--text-muted);font-size:0.72rem;margin-top:2px;">${sub}</div>` : ''}
        </div>`;
    }).join('');
  },

  /* ============ 云端拉取 ============ */
  async pullPlan(btn) {
    if (!Cloud.getToken()) {
      alert('还没填管理令牌：去「设置」页填入后才能从云端拿计划');
      return;
    }
    if (btn) btn.disabled = true;
    try {
      const res = await fetch('/api/admin/kaoyan-plan', {
        headers: { authorization: 'Bearer ' + Cloud.getToken() }
      });
      const data = await Cloud._readJson(res, '读取计划');
      if (data.plan) {
        this.setPlan(data.plan);
        const c = document.getElementById('page-container');
        if (c && App.currentPage === 'kaoyan') Kaoyan.render(c);
      }
    } catch (err) {
      alert('拉取计划失败：' + err.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  }
};
