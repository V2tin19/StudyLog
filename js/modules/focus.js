/* ============================================
   Focus - 在线自习室 / 专注时钟与收获留档
   - 正向心流计时 / 反向番茄钟
   - 绝不断流：基于绝对时间戳（Date.now），锁屏/切后台/关网页重开毫秒不差
   - 伴读墙：轻量在线协同，展示当前自习书友与专注状态
   - 收获归档：每次专注结束像写日记一样记录心得，支持时间线回顾与云端同步
   - Web Audio 禅意提示音，离线可用
   ============================================ */

const Focus = {
  STORAGE_KEY: 'focus_sessions',
  ACTIVE_KEY: 'focus_active',
  NICKNAME_KEY: 'focus_nickname',
  PRESENCE_API: '/api/focus-presence',

  _timer: null,
  _presenceTimer: null,
  _activeBuddies: [],
  _buddiesLoaded: false,
  _lastChimedSessionId: null,

  /* 常用专注主题预设 */
  PRESET_TAGS: ['阅读', '写作', '编程', '复习', '英语', '思考', '自由探索'],

  /* 禅语格言库 */
  QUOTES: [
    '静坐常思己过，闲谈莫论人非。',
    '流水不争先，争的是滔滔不绝。',
    '博学之，审问之，慎思之，明辨之，笃行之。',
    '知不足而奋进，望远山而前行。',
    '心心在一艺，其艺必工；心心在一职，其职必举。',
    'Stay hungry, stay foolish.',
    'Focus on being productive instead of busy.'
  ],

  getSessions() {
    return Store.getList(this.STORAGE_KEY) || [];
  },

  getActive() {
    return Store.get(this.ACTIVE_KEY, null);
  },

  setActive(data) {
    Store.set(this.ACTIVE_KEY, data);
  },

  clearActive() {
    Store.remove(this.ACTIVE_KEY);
  },

  getNickname() {
    return Store.get(this.NICKNAME_KEY) || localStorage.getItem('studylog_comment_name') || '馆主';
  },

  setNickname(name) {
    const n = (name || '').trim().slice(0, 20) || '馆主';
    Store.set(this.NICKNAME_KEY, n);
    return n;
  },

  /* ---------------- Web Audio 提示音（纯原生合成，零音频外链） ---------------- */
  playChime() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const ctx = new AudioContext();

      // 双音和弦钟声：D5 (587.33Hz) + A5 (880Hz)
      const freqs = [587.33, 880];
      const now = ctx.currentTime;

      freqs.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + idx * 0.15);

        gain.gain.setValueAtTime(0, now + idx * 0.15);
        gain.gain.linearRampToValueAtTime(0.2, now + idx * 0.15 + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.15 + 1.8);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now + idx * 0.15);
        osc.stop(now + idx * 0.15 + 1.8);
      });
    } catch (e) {
      console.warn('播放提示音失败:', e);
    }
  },

  /* ---------------- 计时引擎 ---------------- */

  start(mode, targetMinutes, subject) {
    const now = Date.now();
    const id = Utils.uid();
    const active = {
      id: id,
      mode: mode === 'countup' ? 'countup' : 'countdown',
      targetMinutes: parseInt(targetMinutes, 10) || 25,
      startTime: now,
      subject: (subject || '自习专注').trim().slice(0, 30),
      createdAt: new Date().toISOString()
    };

    this.setActive(active);
    this._sendHeartbeat(active);
    this.render(document.getElementById('page-container'));
  },

  cancel() {
    Utils.confirm('确定要放弃本次专注吗？当前进度不会保存。').then(ok => {
      if (!ok) return;
      this._sendLeave();
      this.clearActive();
      this.render(document.getElementById('page-container'));
    });
  },

  finish() {
    const active = this.getActive();
    if (!active) return;

    const now = Date.now();
    const elapsedSec = Math.max(1, Math.floor((now - active.startTime) / 1000));
    this.openReflectionModal(active, elapsedSec);
  },

  /* ---------------- 收获反思留档弹窗 ---------------- */

  openReflectionModal(active, elapsedSec) {
    const modal = document.getElementById('focus-reflection-modal');
    if (!modal) return;

    const durMin = Math.max(1, Math.round(elapsedSec / 60));
    const startStr = Utils.formatTime(new Date(active.startTime));
    const endStr = Utils.formatTime(new Date());

    document.getElementById('focus-modal-dur').textContent = `${durMin} 分钟 (${this._formatHMS(elapsedSec)})`;
    document.getElementById('focus-modal-span').textContent = `${startStr} ~ ${endStr}`;
    
    const subInput = document.getElementById('focus-modal-subject');
    if (subInput) subInput.value = active.subject || '自习专注';

    const noteInput = document.getElementById('focus-modal-notes');
    if (noteInput) {
      noteInput.value = '';
      setTimeout(() => noteInput.focus(), 80);
    }

    modal.dataset.activeId = active.id;
    modal.dataset.elapsedSec = elapsedSec;
    modal.classList.remove('hidden');
  },

  closeReflectionModal() {
    const modal = document.getElementById('focus-reflection-modal');
    if (modal) modal.classList.add('hidden');
  },

  saveReflection() {
    const modal = document.getElementById('focus-reflection-modal');
    if (!modal) return;

    const active = this.getActive();
    const elapsedSec = parseInt(modal.dataset.elapsedSec, 10) || 60;
    const durMin = Math.max(1, Math.round(elapsedSec / 60));

    const subject = (document.getElementById('focus-modal-subject')?.value || '自习专注').trim();
    const notes = (document.getElementById('focus-modal-notes')?.value || '').trim();

    const record = {
      id: Utils.uid(),
      startTime: active ? active.startTime : (Date.now() - elapsedSec * 1000),
      endTime: Date.now(),
      durationMinutes: durMin,
      durationSeconds: elapsedSec,
      mode: active ? active.mode : 'countdown',
      subject: subject || '自习专注',
      notes: notes,
      createdAt: new Date().toISOString()
    };

    Store.addItem(this.STORAGE_KEY, record);
    this.closeReflectionModal();
    this._sendLeave();
    this.clearActive();

    this.render(document.getElementById('page-container'));
  },

  deleteSession(id) {
    Utils.confirm('确定删除这条专注留档记录吗？').then(ok => {
      if (!ok) return;
      Store.removeItem(this.STORAGE_KEY, id);
      this.render(document.getElementById('page-container'));
    });
  },

  /* ---------------- 在线伴读墙 API ---------------- */

  async fetchBuddies() {
    try {
      const res = await fetch(this.PRESENCE_API);
      if (!res.ok) return;
      const data = await res.json();
      if (data && Array.isArray(data.active)) {
        this._activeBuddies = data.active;
        this._buddiesLoaded = true;
        this._updateBuddiesUI();
      }
    } catch (e) {
      // 伴读接口异常不打断本地自习
    }
  },

  async _sendHeartbeat(active) {
    if (!active) active = this.getActive();
    if (!active) return;

    try {
      await fetch(this.PRESENCE_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: active.id,
          name: this.getNickname(),
          subject: active.subject,
          mode: active.mode,
          targetMinutes: active.targetMinutes,
          startTime: active.startTime,
          action: 'heartbeat'
        })
      });
      this.fetchBuddies();
    } catch (e) {
      // 离线容错
    }
  },

  async _sendLeave() {
    const active = this.getActive();
    if (!active) return;
    try {
      await fetch(this.PRESENCE_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: active.id,
          action: 'leave'
        })
      });
    } catch (e) {}
  },

  _updateBuddiesUI() {
    const listEl = document.getElementById('focus-buddies-list');
    const countEl = document.getElementById('focus-buddies-count');
    if (!listEl) return;

    const list = this._activeBuddies || [];
    if (countEl) countEl.textContent = list.length;

    if (list.length === 0) {
      listEl.innerHTML = `
        <div class="focus-buddy-empty">
          <span class="focus-buddy-empty-icon">🌱</span>
          <span>当前自习室只有你一人，开启一段安静的心流时光吧</span>
        </div>
      `;
      return;
    }

    const now = Date.now();
    listEl.innerHTML = list.map(b => {
      const mins = Math.max(1, Math.floor((now - (b.startTime || now)) / 60000));
      const initial = (b.name || '书').charAt(0).toUpperCase();
      const isMe = this.getActive() && this.getActive().id === b.id;
      return `
        <div class="focus-buddy-card ${isMe ? 'is-me' : ''}">
          <div class="focus-buddy-av">${Utils.esc(initial)}</div>
          <div class="focus-buddy-info">
            <div class="focus-buddy-top">
              <span class="focus-buddy-name">${Utils.esc(b.name || '书友')}</span>
              ${isMe ? '<span class="focus-badge-me">我</span>' : ''}
              <span class="focus-buddy-time">已专注 ${mins}m</span>
            </div>
            <div class="focus-buddy-sub">
              <span class="focus-buddy-tag">${b.mode === 'countup' ? '心流' : '番茄'}</span>
              <span class="focus-buddy-subj">${Utils.esc(b.subject || '自习专注')}</span>
            </div>
          </div>
          <span class="focus-buddy-pulse" title="专注进行中"></span>
        </div>
      `;
    }).join('');
  },

  /* ---------------- 工具计算 ---------------- */

  _formatHMS(totalSec) {
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) {
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  },

  _computeStats(sessions) {
    const today = Utils.today();
    let todayMinutes = 0;
    let todayCount = 0;
    let totalMinutes = 0;

    sessions.forEach(s => {
      const m = s.durationMinutes || Math.round((s.durationSeconds || 0) / 60) || 0;
      totalMinutes += m;
      const d = s.createdAt ? s.createdAt.slice(0, 10) : '';
      if (d === today) {
        todayMinutes += m;
        todayCount++;
      }
    });

    const formatM = (min) => {
      const h = (min / 60).toFixed(1);
      return h.endsWith('.0') ? parseInt(h, 10) + ' 小时' : h + ' 小时';
    };

    return {
      todayHours: formatM(todayMinutes),
      todayCount: todayCount,
      totalHours: formatM(totalMinutes),
      totalCount: sessions.length
    };
  },

  /* ---------------- 页面主渲染 ---------------- */

  render(container) {
    clearInterval(this._timer);
    clearInterval(this._presenceTimer);

    const active = this.getActive();
    const sessions = this.getSessions();
    const stats = this._computeStats(sessions);
    const nickname = this.getNickname();
    const randomQuote = this.QUOTES[Math.floor(Math.random() * this.QUOTES.length)];

    let clockSectionHtml = '';
    if (active) {
      clockSectionHtml = this._renderRunningClock(active);
    } else {
      clockSectionHtml = this._renderIdleClock();
    }

    container.innerHTML = `
      <div class="focus-page">
        <!-- 顶部意境诗意横幅 -->
        <header class="focus-banner">
          <div class="focus-banner-left">
            <h2 class="focus-title">自习室</h2>
            <p class="focus-quote" id="focus-quote">“${Utils.esc(randomQuote)}”</p>
          </div>
          <div class="focus-banner-right">
            <div class="focus-nick-bar" title="点击修改你在自习室的昵称">
              <span class="focus-nick-label">座席：</span>
              <span class="focus-nick-val" id="focus-nick-display">${Utils.esc(nickname)}</span>
              <button class="focus-nick-btn" id="focus-nick-edit" title="修改昵称">✎</button>
            </div>
          </div>
        </header>

        <!-- 核心时钟交互卡片 -->
        <section class="focus-clock-card" id="focus-clock-card">
          ${clockSectionHtml}
        </section>

        <!-- 在线伴读墙（书友在线） -->
        <section class="focus-buddies-section">
          <div class="focus-sec-head">
            <div class="focus-sec-title">
              <span>伴读墙 · 正在自习的书友</span>
              <span class="focus-badge-count"><span id="focus-buddies-count">${this._activeBuddies.length}</span> 人在线</span>
            </div>
            <button class="focus-refresh-btn" id="focus-buddies-refresh" title="刷新在线书友">⟳ 刷新</button>
          </div>
          <div class="focus-buddies-list" id="focus-buddies-list">
            <div class="focus-buddy-loading">正在载入伴读状态…</div>
          </div>
        </section>

        <!-- 历史留档与收获回顾 -->
        <section class="focus-timeline-section">
          <div class="focus-sec-head">
            <div class="focus-sec-title">专注留档 · 历史收获</div>
          </div>

          <!-- 统计指标 -->
          <div class="focus-stats-grid">
            <div class="focus-stat-card">
              <div class="focus-stat-val">${stats.todayHours}</div>
              <div class="focus-stat-lbl">今日专注</div>
            </div>
            <div class="focus-stat-card">
              <div class="focus-stat-val">${stats.todayCount} 次</div>
              <div class="focus-stat-lbl">今日频次</div>
            </div>
            <div class="focus-stat-card">
              <div class="focus-stat-val">${stats.totalHours}</div>
              <div class="focus-stat-lbl">累计专注</div>
            </div>
            <div class="focus-stat-card">
              <div class="focus-stat-val">${stats.totalCount} 篇</div>
              <div class="focus-stat-lbl">收获留档</div>
            </div>
          </div>

          <!-- 留档时间线 -->
          <div class="focus-timeline" id="focus-timeline">
            ${this._renderTimelineList(sessions)}
          </div>
        </section>
      </div>

      <!-- 反思收获留档弹窗 -->
      <div id="focus-reflection-modal" class="dialog-overlay hidden">
        <div class="focus-modal-box">
          <div class="focus-modal-header">
            <h3 class="focus-modal-title">✨ 专注完成 · 记录这次的收获</h3>
            <button class="focus-modal-close" id="focus-modal-close">×</button>
          </div>
          <div class="focus-modal-meta">
            <div class="focus-meta-item">
              <span class="focus-meta-label">专注时长：</span>
              <span class="focus-meta-val" id="focus-modal-dur">--</span>
            </div>
            <div class="focus-meta-item">
              <span class="focus-meta-label">时间区间：</span>
              <span class="focus-meta-val" id="focus-modal-span">--</span>
            </div>
          </div>

          <div class="focus-modal-field">
            <label class="focus-field-label">专注主题 / 事项</label>
            <input type="text" class="input focus-modal-input" id="focus-modal-subject" placeholder="比如：数学、编程、英语精读..." maxlength="30" />
            <div class="focus-modal-tags">
              ${this.PRESET_TAGS.map(t => `<button type="button" class="focus-tag-chip" data-tag="${t}">${t}</button>`).join('')}
            </div>
          </div>

          <div class="focus-modal-field">
            <label class="focus-field-label">收获与心得（像写日记一样记下来）</label>
            <textarea class="textarea focus-modal-textarea" id="focus-modal-notes" rows="4" placeholder="写下这次专注的收获、弄懂的难点、做完的事情，或者此刻的心流感悟…"></textarea>
          </div>

          <div class="focus-modal-actions">
            <button type="button" class="btn btn-secondary" id="focus-modal-discard">不留心得，直接保存</button>
            <button type="button" class="btn btn-primary" id="focus-modal-save">保存留档</button>
          </div>
        </div>
      </div>
    `;

    this._bindEvents(container);

    // 启动计时器更新循环
    if (active) {
      this._startTickLoop();
    }

    // 载入在线伴读墙数据
    this.fetchBuddies();

    // 伴读心跳循环
    this._presenceTimer = setInterval(() => {
      if (this.getActive()) {
        this._sendHeartbeat();
      } else {
        this.fetchBuddies();
      }
    }, 25000);
  },

  /* ---------------- 运行中与空闲中时钟渲染 ---------------- */

  _renderIdleClock() {
    return `
      <div class="focus-setup-view">
        <div class="focus-tabs">
          <button class="focus-tab active" data-mode="countdown">番茄倒计时</button>
          <button class="focus-tab" data-mode="countup">心流正向计时</button>
        </div>

        <!-- 倒计时模式选项 -->
        <div class="focus-options" id="focus-countdown-options">
          <div class="focus-preset-chips">
            <button class="focus-chip" data-min="15">15 分钟</button>
            <button class="focus-chip active" data-min="25">25 分钟</button>
            <button class="focus-chip" data-min="45">45 分钟</button>
            <button class="focus-chip" data-min="60">60 分钟</button>
            <button class="focus-chip" data-min="custom">自定义</button>
          </div>
          <div class="focus-custom-min-row hidden" id="focus-custom-min-row">
            <input type="number" class="input focus-custom-input" id="focus-custom-min" min="1" max="360" value="30" placeholder="分钟" />
            <span class="focus-unit">分钟</span>
          </div>
        </div>

        <!-- 正向计时说明 -->
        <div class="focus-options hidden" id="focus-countup-options">
          <p class="focus-countup-hint">心流正向计时：不设上限，专心沉浸，想停就停。</p>
        </div>

        <!-- 专注事项输入与快捷标签 -->
        <div class="focus-subject-row">
          <input type="text" class="input focus-subject-input" id="focus-start-subject" placeholder="正在专注的主题（例如：阅读《三体》、力扣刷题、英语听力）" maxlength="30" />
          <div class="focus-quick-tags">
            ${this.PRESET_TAGS.map(t => `<button type="button" class="focus-sub-chip" data-tag="${t}">${t}</button>`).join('')}
          </div>
        </div>

        <!-- 大按钮开启 -->
        <div class="focus-start-action">
          <button class="btn btn-primary focus-btn-start" id="focus-btn-start">
            <span class="focus-btn-icon">▶</span>
            <span>开启专注时光</span>
          </button>
        </div>
      </div>
    `;
  },

  _renderRunningClock(active) {
    const modeName = active.mode === 'countup' ? '心流正向计时' : `番茄倒计时 (${active.targetMinutes}m)`;
    const startStr = Utils.formatTime(new Date(active.startTime));

    return `
      <div class="focus-running-view">
        <div class="focus-running-meta">
          <span class="focus-running-badge">${modeName}</span>
          <span class="focus-running-subj">${Utils.esc(active.subject || '自习专注')}</span>
          <span class="focus-running-start">始于 ${startStr}</span>
        </div>

        <!-- 环形进度与数字时钟 -->
        <div class="focus-dial-container">
          <div class="focus-dial-display" id="focus-digits">--:--</div>
          <div class="focus-dial-sub" id="focus-dial-sub">沉浸在当下的专注中…</div>
          <div class="focus-progress-bar-wrap ${active.mode === 'countup' ? 'hidden' : ''}">
            <div class="focus-progress-bar" id="focus-progress-bar" style="width: 0%"></div>
          </div>
        </div>

        <!-- 按钮区 -->
        <div class="focus-running-actions">
          <button class="btn btn-primary focus-btn-finish" id="focus-btn-finish">✓ 结束并记录收获</button>
          <button class="btn btn-secondary focus-btn-cancel" id="focus-btn-cancel">✕ 放弃本次</button>
          <button class="focus-zen-toggle" id="focus-zen-toggle" title="全屏沉浸模式">⛶ 全屏</button>
        </div>
      </div>
    `;
  },

  /* ---------------- 计时循环 ---------------- */

  _startTickLoop() {
    clearInterval(this._timer);

    const tick = () => {
      const active = this.getActive();
      if (!active) {
        clearInterval(this._timer);
        return;
      }

      const digitsEl = document.getElementById('focus-digits');
      const barEl = document.getElementById('focus-progress-bar');
      const subEl = document.getElementById('focus-dial-sub');
      if (!digitsEl) return;

      const now = Date.now();
      const elapsedSec = Math.max(0, Math.floor((now - active.startTime) / 1000));

      if (active.mode === 'countup') {
        digitsEl.textContent = this._formatHMS(elapsedSec);
        if (subEl) subEl.textContent = `心流已持续 ${Math.floor(elapsedSec / 60)} 分钟`;
      } else {
        const totalSec = active.targetMinutes * 60;
        const remainSec = Math.max(0, totalSec - elapsedSec);
        digitsEl.textContent = this._formatHMS(remainSec);

        const pct = Math.min(100, Math.floor((elapsedSec / totalSec) * 100));
        if (barEl) barEl.style.width = `${pct}%`;

        if (remainSec <= 0) {
          if (this._lastChimedSessionId !== active.id) {
            this._lastChimedSessionId = active.id;
            this.playChime();
          }
          if (subEl) subEl.textContent = '🎉 番茄钟已敲响！请放松身心，记录这次的收获吧';
        } else {
          if (subEl) subEl.textContent = `剩余 ${Math.ceil(remainSec / 60)} 分钟`;
        }
      }
    };

    tick();
    this._timer = setInterval(tick, 500);
  },

  /* ---------------- 时间线渲染 ---------------- */

  _renderTimelineList(sessions) {
    if (!sessions || sessions.length === 0) {
      return `
        <div class="focus-empty-timeline">
          <span class="focus-empty-icon">📖</span>
          <p>还没有专注留档。完成一次专注后，这里会像时光日记一样沉淀下你的每一次努力。</p>
        </div>
      `;
    }

    // 按创建日期倒序分组
    const groups = {};
    sessions.forEach(s => {
      const d = s.createdAt ? s.createdAt.slice(0, 10) : Utils.today();
      if (!groups[d]) groups[d] = [];
      groups[d].push(s);
    });

    const dates = Object.keys(groups).sort((a, b) => b.localeCompare(a));

    return dates.map(dateStr => {
      const isToday = Utils.isToday(dateStr);
      const dayLabel = isToday ? `今天 · ${dateStr}` : dateStr;
      const daySessions = groups[dateStr];

      return `
        <div class="focus-date-group">
          <div class="focus-date-header">${dayLabel}</div>
          <div class="focus-date-cards">
            ${daySessions.map(s => {
              const startT = s.startTime ? Utils.formatTime(new Date(s.startTime)) : '--:--';
              const endT = s.endTime ? Utils.formatTime(new Date(s.endTime)) : '--:--';
              const durM = s.durationMinutes || Math.round((s.durationSeconds || 0) / 60) || 1;
              const hasNotes = s.notes && s.notes.trim();

              return `
                <div class="focus-session-card">
                  <div class="focus-card-left">
                    <div class="focus-card-time">${startT} ~ ${endT}</div>
                    <div class="focus-card-badge-row">
                      <span class="focus-dur-pill">⏱ ${durM} 分钟</span>
                      <span class="focus-mode-pill">${s.mode === 'countup' ? '心流' : '番茄'}</span>
                      <span class="focus-subj-pill">${Utils.esc(s.subject || '自习')}</span>
                    </div>
                  </div>
                  <div class="focus-card-right">
                    <button class="focus-del-btn" data-id="${s.id}" title="删除此条记录">✕</button>
                  </div>
                  ${hasNotes ? `
                    <div class="focus-card-notes">
                      <div class="focus-notes-quote">“</div>
                      <div class="focus-notes-text">${Utils.esc(s.notes)}</div>
                    </div>
                  ` : ''}
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    }).join('');
  },

  /* ---------------- 事件绑定 ---------------- */

  _bindEvents(container) {
    // 1. 模式切换
    container.querySelectorAll('.focus-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        container.querySelectorAll('.focus-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const mode = tab.dataset.mode;
        const cdOpt = document.getElementById('focus-countdown-options');
        const cuOpt = document.getElementById('focus-countup-options');
        if (mode === 'countdown') {
          cdOpt?.classList.remove('hidden');
          cuOpt?.classList.add('hidden');
        } else {
          cdOpt?.classList.add('hidden');
          cuOpt?.classList.remove('hidden');
        }
      });
    });

    // 2. 预设时长筹码点击
    container.querySelectorAll('.focus-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        container.querySelectorAll('.focus-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        const customRow = document.getElementById('focus-custom-min-row');
        if (chip.dataset.min === 'custom') {
          customRow?.classList.remove('hidden');
          document.getElementById('focus-custom-min')?.focus();
        } else {
          customRow?.classList.add('hidden');
        }
      });
    });

    // 3. 事项预设标签点击（开启界面）
    container.querySelectorAll('.focus-sub-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const inp = document.getElementById('focus-start-subject');
        if (inp) inp.value = btn.dataset.tag;
      });
    });

    // 4. 开启按钮
    document.getElementById('focus-btn-start')?.addEventListener('click', () => {
      const activeTab = container.querySelector('.focus-tab.active');
      const mode = activeTab?.dataset.mode || 'countdown';
      let targetM = 25;

      if (mode === 'countdown') {
        const activeChip = container.querySelector('.focus-chip.active');
        const minVal = activeChip?.dataset.min || '25';
        if (minVal === 'custom') {
          targetM = parseInt(document.getElementById('focus-custom-min')?.value, 10) || 25;
          if (targetM <= 0) targetM = 25;
        } else {
          targetM = parseInt(minVal, 10) || 25;
        }
      }

      const subject = (document.getElementById('focus-start-subject')?.value || '自习专注').trim();
      this.start(mode, targetM, subject);
    });

    // 5. 运行中：结束与放弃按钮
    document.getElementById('focus-btn-finish')?.addEventListener('click', () => this.finish());
    document.getElementById('focus-btn-cancel')?.addEventListener('click', () => this.cancel());

    // 6. 禅意全屏切换
    document.getElementById('focus-zen-toggle')?.addEventListener('click', () => {
      const card = document.getElementById('focus-clock-card');
      if (card) {
        card.classList.toggle('zen-fullscreen');
        const btn = document.getElementById('focus-zen-toggle');
        if (btn) btn.textContent = card.classList.contains('zen-fullscreen') ? '✕ 退出全屏' : '⛶ 全屏';
      }
    });

    // 7. 修改昵称
    document.getElementById('focus-nick-edit')?.addEventListener('click', () => {
      const cur = this.getNickname();
      const n = window.prompt('请输入你在自习室的座席昵称：', cur);
      if (n !== null) {
        const saved = this.setNickname(n);
        const disp = document.getElementById('focus-nick-display');
        if (disp) disp.textContent = saved;
        if (this.getActive()) this._sendHeartbeat();
      }
    });

    // 8. 刷新在线书友
    document.getElementById('focus-buddies-refresh')?.addEventListener('click', () => {
      this.fetchBuddies();
    });

    // 9. 反思弹窗标签点击
    document.querySelectorAll('.focus-tag-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const inp = document.getElementById('focus-modal-subject');
        if (inp) inp.value = btn.dataset.tag;
      });
    });

    // 10. 反思弹窗关闭与保存
    document.getElementById('focus-modal-close')?.addEventListener('click', () => this.closeReflectionModal());
    document.getElementById('focus-modal-discard')?.addEventListener('click', () => {
      // 不写心得直接存
      const notes = document.getElementById('focus-modal-notes');
      if (notes) notes.value = '';
      this.saveReflection();
    });
    document.getElementById('focus-modal-save')?.addEventListener('click', () => this.saveReflection());

    // 11. 删除时间线记录
    container.querySelectorAll('.focus-del-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.deleteSession(btn.dataset.id);
      });
    });
  }
};

/* 手机切后台/锁屏唤醒时立刻校准时钟 */
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Focus.getActive()) {
    Focus._startTickLoop();
    Focus._sendHeartbeat();
  }
});
