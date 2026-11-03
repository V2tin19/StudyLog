/* ============================================
   Agent - 助手页
   对话框 + 气泡仪表盘：日期/今日安排/今日已学 一眼可读，
   下面聊天，AI 返回可交互卡片（确认/算了），撤销栈在服务端。

   数据分工：
   · 对话/卡片走 /api/admin/agent/chat（服务端大脑 _agent.js），
     历史存在云端 doc 的 agent_chat key —— 多端看到同一条对话流。
   · 仪表盘读本地缓存（Study 会话 + Kaoyan 计划），确认录入后
     拉一次 Sync.pull() 让台账缓存跟上，再重画。
   ============================================ */

const Agent = {
  _loading: false,

  get hasToken() { return !!Cloud.getToken(); },

  /* ============ 页面骨架 ============ */
  render(container) {
    container.innerHTML = `
      <div id="agent-dash">${this._dashHtml()}</div>

      <div class="card mb-16">
        <div class="card-title"><span>对话</span>
          <button class="btn btn-sm btn-secondary" onclick="Agent.loadHistory()">↻ 刷新</button>
        </div>
        <div id="agent-chat" class="agent-chat"><div class="empty-state-text">正在读取…</div></div>
        <div class="agent-chips">
          <span class="chip" onclick="Agent.useChip('今天下午学了2小时数据结构')">记一笔</span>
          <span class="chip" onclick="Agent.useChip('今天学数学两小时')">排个期</span>
          <span class="chip" onclick="Agent.useChip('本周学了多少')">看统计</span>
          <span class="chip" onclick="Agent.useChip('帮助')">帮助</span>
        </div>
        <div class="agent-input-row">
          <input class="input" id="agent-input" placeholder="说人话就行：「刚学了1小时高数」"
                 ${this.hasToken ? '' : 'disabled'}>
          <button class="btn btn-primary" id="agent-send" onclick="Agent.send()"
                  ${this.hasToken ? '' : 'disabled'}>发送</button>
        </div>
        ${this.hasToken ? '' : '<div class="empty-state-text" style="margin-top:8px;">先去「设置」页填管理令牌，助手才能帮你记。</div>'}
      </div>
    `;

    const input = document.getElementById('agent-input');
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        Agent.send();
      }
    });

    this.loadHistory();
    /* 计划后台拉新，拉到就重画仪表盘（不重画对话，避免打断） */
    if (this.hasToken && typeof Kaoyan !== 'undefined') {
      Kaoyan.pullPlan().then(() => this._refreshDash()).catch(() => {});
    }
  },

  useChip(text) {
    const input = document.getElementById('agent-input');
    if (!input) return;
    input.value = text;
    input.focus();
    if (text === '本周学了多少' || text === '帮助') this.send();
  },

  /* ============ 气泡仪表盘 ============ */
  _dashHtml() {
    const today = Utils.today();
    const plan = (typeof Kaoyan !== 'undefined') ? Kaoyan.getPlan() : null;
    const cd = (typeof Kaoyan !== 'undefined') ? Kaoyan.countdown(plan) : null;

    const sessions = (typeof Study !== 'undefined') ? Study.getTodaySessions() : [];
    const totalMin = sessions.reduce((a, s) => a + (s.duration || 0), 0);
    const bySubject = {};
    for (const s of sessions) {
      bySubject[s.subject] = (bySubject[s.subject] || 0) + (s.duration || 0);
    }
    const subjectHtml = Object.entries(bySubject).map(([k, v]) =>
      `<span class="badge badge-blue">${Utils.esc(k)} ${Study.formatDuration(v)}</span>`).join(' ');

    /* 今日安排（与 Kaoyan.renderToday 同规则：现在高亮、已过淡出） */
    const slots = (typeof Kaoyan !== 'undefined') ? Kaoyan.dayPlan(plan, today) : [];
    const now = Utils.formatTime(new Date());
    const slotHtml = slots.length ? slots.map(s => {
      const st = String(s.start || ''), en = String(s.end || '');
      const isNow = st <= now && now < en;
      const past = en && en <= now;
      const style = past ? 'opacity:0.45;' : (isNow ? 'background:var(--bg-hover);border-radius:8px;padding:8px 10px;' : '');
      const badge = isNow ? '<span class="badge badge-blue">现在</span>' : '';
      const topic = s.topic ? `<div class="text-sm" style="color:var(--text-muted);">${Utils.esc(s.topic)}</div>` : '';
      return `<div class="list-item" style="${style}">
          <span style="font-weight:500;min-width:88px;font-size:0.82rem;">${Utils.esc(st)}-${Utils.esc(en)}</span>
          <div style="flex:1;"><span class="text-sm" style="font-weight:500;">${Utils.esc(s.subject || '')}</span>${topic}</div>
          ${badge}
        </div>`;
    }).join('') : '<div class="empty-state-text">今天还没有安排 —— 对助手说「今天学数学两小时」就能排上</div>';

    return `
      <div class="card-row mb-16">
        <div class="card" style="flex:1;min-width:200px;">
          <div class="text-sm" style="color:var(--text-muted);">${today} ${Agent._weekday(today)}</div>
          <div style="font-size:1.3rem;font-weight:600;margin-top:2px;">${cd ? cd.text : '还没设考试日期'}</div>
          <div class="text-sm" style="color:var(--text-muted);margin-top:4px;">
            今日已学 <b>${Study.formatDuration(totalMin)}</b>
          </div>
          ${subjectHtml ? `<div style="margin-top:6px;">${subjectHtml}</div>` : ''}
        </div>
        <div class="card" style="flex:1.4;min-width:260px;">
          <div class="card-title"><span>今日安排</span>
            <button class="btn btn-sm btn-secondary" onclick="App.navigate('kaoyan')">详情</button>
          </div>
          ${slotHtml}
        </div>
      </div>`;
  },

  _weekday(dateStr) {
    return '周' + '日一二三四五六'[new Date(Utils.parseDate(dateStr)).getDay()];
  },

  _refreshDash() {
    const el = document.getElementById('agent-dash');
    if (el && App.currentPage === 'agent') el.innerHTML = this._dashHtml();
  },

  /* ============ 对话 ============ */
  async loadHistory() {
    if (!this.hasToken) {
      this._setChatHtml('<div class="empty-state-text">填好令牌后，这里就是你和助手的对话。</div>');
      return;
    }
    if (this._loading) return;
    this._loading = true;
    try {
      const res = await fetch('/api/admin/agent/chat', {
        headers: { authorization: 'Bearer ' + Cloud.getToken() }
      });
      const data = await Cloud._readJson(res, '读取对话');
      this._renderChat(data.messages || [], data.pending || []);
    } catch (err) {
      this._setChatHtml(`<div class="empty-state-text">读取对话失败：${Utils.esc(err.message)}</div>`);
    } finally {
      this._loading = false;
    }
  },

  _renderChat(messages, pending) {
    const wrap = document.getElementById('agent-chat');
    if (!wrap) return;

    let html = '';
    if (!messages.length && !(pending && pending.length)) {
      html = `<div class="empty-state-text" style="padding:12px 0;">
        试试说：「今天下午学了2小时数据结构」→ 助手出卡片，你确认才记。</div>`;
    }
    for (const m of messages) {
      const isUser = m.role === 'user';
      html += `<div class="chat-msg ${isUser ? 'chat-user' : 'chat-agent'}">
          <div class="bubble">${Utils.esc(m.text || '').replace(/\n/g, '<br>')}</div>
        </div>`;
    }
    for (const p of (pending || [])) {
      html += this._cardHtml(p);
    }
    wrap.innerHTML = html;
    wrap.scrollTop = wrap.scrollHeight;
  },

  _cardHtml(card) {
    if (card.type === 'log_confirm') {
      const rows = (card.payload?.sessions || []).map((s, i) => `
        <div class="list-item" style="padding:6px 0;">
          <div class="list-item-main">
            <div class="list-item-title">${Utils.esc(s.subject)} · ${Study.formatDuration(s.minutes)}</div>
            <div class="list-item-sub">${Utils.esc(s.dateLabel || s.date || '')}${s.content ? ' · ' + Utils.esc(s.content) : ''}</div>
          </div>
        </div>`).join('');
      return `<div class="chat-msg chat-agent"><div class="chat-card" data-card="${Utils.esc(card.id)}">
          <div class="chat-card-title">📋 记下这些学习？</div>
          ${rows}
          <div class="chat-card-actions">
            <button class="btn btn-sm btn-primary" onclick="Agent.confirmCard('${Utils.esc(card.id)}')">确认记录</button>
            <button class="btn btn-sm btn-secondary" onclick="Agent.cancelCard('${Utils.esc(card.id)}')">算了</button>
          </div>
        </div></div>`;
    }
    return '';
  },

  _setChatHtml(html) {
    const wrap = document.getElementById('agent-chat');
    if (wrap) wrap.innerHTML = html;
  },

  async _post(body) {
    const res = await fetch('/api/admin/agent/chat', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + Cloud.getToken(), 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    return Cloud._readJson(res, '助手处理');
  },

  async send() {
    const input = document.getElementById('agent-input');
    const text = (input?.value || '').trim();
    if (!text) return;
    if (!this.hasToken) { alert('先去「设置」页填管理令牌'); return; }
    input.value = '';
    try {
      const r = await this._post({ text, source: 'web' });
      /* 服务端已把对话存好，重拉一遍保持多端一致 */
      await this.loadHistory();
      if (r.reply && !r.cards.length) { /* 纯文本回复已包含在历史里 */ }
    } catch (err) {
      alert('发送失败：' + err.message);
      if (input) input.value = text;   /* 还给用户，别丢字 */
    }
  },

  async confirmCard(id) {
    try {
      this._lockCard(id, true);
      const r = await this._post({ confirm: id });
      await this.loadHistory();
      if (typeof Sync !== 'undefined' && Sync.pull) {
        Sync.pull().then(() => this._refreshDash()).catch(() => {});
      }
      this._refreshDash();
      if (r.reply) console.log('[agent]', r.reply);
    } catch (err) {
      alert('确认失败：' + err.message);
      this._lockCard(id, false);
    }
  },

  async cancelCard(id) {
    try {
      this._lockCard(id, true);
      await this._post({ cancel: id });
      await this.loadHistory();
    } catch (err) {
      alert('取消失败：' + err.message);
      this._lockCard(id, false);
    }
  },

  _lockCard(id, lock) {
    const el = document.querySelector(`.chat-card[data-card="${id}"]`);
    if (!el) return;
    el.querySelectorAll('button').forEach(b => { b.disabled = lock; });
  }
};
