/* ============================================
   Sync - 云端自动同步

   目标：让写作台「以云端为主存」。
   打开即从云端拉取，写完保存即上传，不用再手动点「发布」。

   设计原则（改动前先读这段，别把它改回两层）：
   1. 读写仍然保持同步。全站各模块（diary/timeline/dashboard/study…）
      都用同步的 Store 读数据，把它们全改成 async 成本极高、风险很大。
      所以这里走「本地缓存 + 写穿云端」：
        · 读 → 永远读本地缓存（快，断网也能打开）
        · 写 → 先写本地缓存，再异步推云端
   2. 本地不再是「原件」，只是缓存 + 离线兜底，真相在云端。
   3. 合并冲突以 updatedAt 较新的为准；
      但本地的 base64 图片必须保住 —— 云端现在存不了图片，别在合并时把它抹掉。
   4. 任何请求失败都要有明确状态，绝不静默 —— 静默失败比报错更难查。
   ============================================ */

const Sync = {
  ENABLED_KEY: 'studylog_autosync',
  API: '/api/admin/diary',
  DOC_API: '/api/admin/doc',
  DOC_TIME_KEY: 'studylog_doc_time',   /* 记录每类展示数据「本机最后改于何时」 */
  CHUNK: 50,          /* 一批最多推几条，跟服务端 MAX_BATCH 对齐 */
  DEBOUNCE: 600,      /* 连续改动合并到一个请求里 */

  /* 本地存储 key → 云端 doc key。
     学习 / 日程 / 目标是「整块读写」的展示数据，每类打包成一坨 JSON 存一行，
     所以不用像日记那样按天拆。 */
  DOC_MAP: {
    study_sessions: 'study',
    study_tasks: 'study',
    study_books: 'study',
    study_skills: 'study',
    study_checkin: 'study',
    weekly_schedule: 'schedule',
    goal_list: 'goals'
  },
  DOC_KEYS: ['study', 'schedule', 'goals'],

  _enabled: null,
  _state: 'idle',     /* idle | syncing | ok | partial | error | off */
  _message: '',
  _lastSyncAt: 0,
  _queue: new Map(),  /* date -> 'save' | 'delete' */
  _timer: null,
  _flushing: false,
  _docQueue: new Set(),
  _docTimer: null,
  /* 同步自己往 Store 里写数据时置位，避免「拉下来的数据又被当成改动传回去」的死循环 */
  _internal: false,

  /* ---------------- 开关 ---------------- */

  isEnabled() {
    if (this._enabled === null) {
      let raw = null;
      try { raw = localStorage.getItem(this.ENABLED_KEY); } catch (e) { raw = null; }
      /* 默认开启：站点已经部署到云上，默认就该是云端模式 */
      this._enabled = (raw === null) ? true : raw === '1';
    }
    return this._enabled;
  },

  setEnabled(on) {
    this._enabled = !!on;
    try { localStorage.setItem(this.ENABLED_KEY, on ? '1' : '0'); } catch (e) { /* 忽略 */ }
    if (!on) {
      this._queue.clear();
      this._docQueue.clear();
      clearTimeout(this._timer);
      clearTimeout(this._docTimer);
      this._setState('off', '自动同步已关闭，改动只留在本机');
    } else {
      this.boot();
    }
    return this._enabled;
  },

  toggle() {
    this.setEnabled(!this.isEnabled());
    if (typeof App !== 'undefined' && App.refresh) App.refresh();
  },

  /* 有令牌 + 开关打开，才谈得上同步 */
  canSync() {
    return this.isEnabled() && !!Cloud.getToken();
  },

  /* ---------------- 状态 ---------------- */

  _setState(state, message) {
    this._state = state;
    this._message = message || '';
    if (state === 'ok' || state === 'partial') this._lastSyncAt = Date.now();
    document.dispatchEvent(new CustomEvent('sync:change', { detail: this.info() }));
  },

  info() {
    return {
      state: this._state,
      message: this._message,
      lastSyncAt: this._lastSyncAt,
      enabled: this.isEnabled(),
      online: (typeof navigator !== 'undefined') ? navigator.onLine : true
    };
  },

  /* ---------------- 启动：拉一次 ---------------- */

  async boot() {
    if (!this.isEnabled()) {
      this._setState('off', '自动同步已关闭，改动只留在本机');
      return;
    }
    if (!Cloud.getToken()) {
      this._setState('off', '没有管理令牌，改动只留在本机（去设置页填入令牌即可开启同步）');
      return;
    }

    /* 先让界面显示本地缓存，再后台拉云端 */
    try {
      var r = await this.pull();
      if (r.changed && typeof App !== 'undefined' && App.refresh) App.refresh();
    } catch (e) {
      /* 状态已经在 pull 里设好了，这里不再覆盖 */
    }
  },

  /* ---------------- 拉取 + 合并 ---------------- */

  async pull() {
    if (!Cloud.getToken()) throw new Error('还没有填管理令牌');

    this._setState('syncing', '正在从云端读取…');

    let data;
    try {
      const res = await fetch(this.API, {
        headers: { authorization: 'Bearer ' + Cloud.getToken() }
      });
      data = await Cloud._readJson(res, '读取云端');
    } catch (err) {
      this._setState('error', '读取云端失败：' + err.message);
      throw err;
    }

    const remote = Array.isArray(data.entries) ? data.entries : [];
    const all = Store.get(Diary.STORAGE_KEY, {}) || {};
    const remoteDates = new Set(remote.map(r => r.date));

    let added = 0;
    let updated = 0;

    /* 1) 云端有 —— 并进本地；同一天以 updatedAt 较新的为准 */
    remote.forEach(r => {
      if (!r || !r.date) return;
      const local = all[r.date];
      if (!local) {
        all[r.date] = this._fromRemote(r, null);
        added++;
        return;
      }
      const lt = Date.parse(local.updatedAt || local.createdAt || '') || 0;
      const rt = Date.parse(r.updatedAt || r.createdAt || '') || 0;
      if (rt > lt) {
        all[r.date] = this._fromRemote(r, local);
        updated++;
      }
    });

    this._internal = true;
    try { Store.set(Diary.STORAGE_KEY, all); } finally { this._internal = false; }

    /* 2) 本地有内容、云端没有 —— 是本地新写的（或者是离线期间写的），补传上去 */
    const localOnly = Object.keys(all).filter(d => {
      const e = all[d];
      return e && String(e.content || '').trim() && !remoteDates.has(d);
    });

    let pushed = 0;
    if (localOnly.length) {
      try {
        const r2 = await this._pushDates(localOnly);
        pushed = r2.saved;
      } catch (err) {
        this._setState('error', '上传本地新增失败：' + err.message);
        throw err;
      }
    }

    /* 3) 学习 / 日程 / 目标。
       单独 try —— 它们失败了不该把日记的同步结果一起判死
       （最常见的是 doc 表还没建，那时候日记其实一切正常）。 */
    let docPulled = 0;
    let docPushed = 0;
    let docError = '';
    try {
      const d = await this._pullDocs();
      docPulled = d.pulled;
      docPushed = d.pushed;
    } catch (err) {
      docError = err.message;
    }

    const parts = [`日记 ${remote.length} 篇`];
    if (added || updated) parts.push(`拉回 ${added} 新增 / ${updated} 更新`);
    if (pushed) parts.push(`上传 ${pushed} 篇`);
    if (docPulled || docPushed) parts.push(`其他数据 拉回 ${docPulled} / 上传 ${docPushed}`);

    let msg = '同步完成：' + parts.join('，');
    if (docError) {
      msg += '。学习/日程/目标没同步上：' + docError;
      this._setState('partial', msg);
    } else {
      this._setState('ok', msg);
    }

    return {
      remote: remote.length, added, updated, pushed,
      docPulled, docPushed, docError,
      changed: !!(added || updated || docPulled)
    };
  },

  /* 云端记录 → 本地条目。local 传入时，保住本地那些云端存不了的 base64 图片 */
  _fromRemote(r, local) {
    const remoteImgs = Array.isArray(r.images)
      ? r.images.filter(u => typeof u === 'string')
      : [];
    const localImgs = (local && Array.isArray(local.images))
      ? local.images.filter(u =>
          typeof u === 'string' &&
          !/^https?:\/\//i.test(u) &&
          remoteImgs.indexOf(u) === -1)
      : [];

    return {
      id: (local && local.id) || (r.date + '_remote'),
      date: r.date,
      content: r.content || '',
      mood: r.mood || (local && local.mood) || '',
      review: r.review || '',
      images: remoteImgs.concat(localImgs),
      pinned: !!r.pinned,
      createdAt: r.createdAt || r.date,
      updatedAt: r.updatedAt || ''
    };
  },

  /* ---------------- 学习 / 日程 / 目标（doc 类数据） ----------------
     和日记不同：这几类是整体读写的展示数据，云端一类存一行 JSON。
     谁新用「本机最后改于」和云端 updated_at 比，本地新就传上去，云端新就拉下来。
     ------------------------------------------------------------------ */

  /* Store 每次写入都会喊一声，这里判断该不该管 */
  onStoreChange(key) {
    if (this._internal) return;
    const docKey = this.DOC_MAP[key];
    if (!docKey) return;              /* 日记有自己的路径，其余 key 不参与同步 */
    if (!this.canSync()) return;
    this._enqueueDoc(docKey);
  },

  async _pullDocs() {
    if (!Cloud.getToken()) return { pulled: 0, pushed: 0 };

    const res = await fetch(this.DOC_API, {
      headers: { authorization: 'Bearer ' + Cloud.getToken() }
    });
    const data = await Cloud._readJson(res, '读取云端');
    const docs = data.docs || {};

    const times = Store.get(this.DOC_TIME_KEY, {}) || {};
    const toPush = [];
    let pulled = 0;

    this.DOC_KEYS.forEach(k => {
      const remote = docs[k];
      const localT = times[k] || 0;
      const remoteT = remote ? (Date.parse(remote.updatedAt || '') || 0) : 0;

      if (remote && remoteT > localT) {
        /* 云端更新（多半是在另一台设备上改的）→ 拉下来覆盖本机 */
        this._applyDoc(k, remote.data);
        this._setDocTime(k, remoteT);
        pulled++;
      } else if (localT > remoteT) {
        /* 本机改过、还没传上去（例如上次断网）→ 补传 */
        toPush.push(k);
      } else if (!remote && this._hasLocalDoc(k)) {
        /* 云端还没有这一类，而本机有内容 → 首次上传 */
        toPush.push(k);
      }
    });

    let pushed = 0;
    for (const k of toPush) {
      await this._pushDoc(k);
      pushed++;
    }
    return { pulled, pushed };
  },

  /* 把本机这几类数据打包，准备上传 */
  _collectDoc(key) {
    if (key === 'study') {
      return {
        sessions: Store.get(Study.SESSIONS_KEY, []),
        tasks: Store.get(Study.TASKS_KEY, []),
        books: Store.get(Study.BOOKS_KEY, []),
        skills: Store.get(Study.SKILLS_KEY, []),
        checkin: Store.get(Study.CHECKIN_KEY, {})
      };
    }
    if (key === 'schedule') return Store.get(Extras.SCHEDULE_KEY, {});
    if (key === 'goals') return Store.get(Extras.GOALS_KEY, []);
    return null;
  },

  _hasLocalDoc(key) {
    const d = this._collectDoc(key);
    if (d === null || d === undefined) return false;
    if (Array.isArray(d)) return d.length > 0;
    return Object.keys(d).length > 0;
  },

  /* 用云端数据覆盖本机（过程中屏蔽 Store 的变更通知，否则会回环上传） */
  _applyDoc(key, data) {
    if (!data) return;
    this._internal = true;
    try {
      if (key === 'study') {
        [['sessions', 'SESSIONS_KEY'], ['tasks', 'TASKS_KEY'], ['books', 'BOOKS_KEY'],
         ['skills', 'SKILLS_KEY'], ['checkin', 'CHECKIN_KEY']].forEach(pair => {
          if (data[pair[0]] !== undefined) Store.set(Study[pair[1]], data[pair[0]]);
        });
      } else if (key === 'schedule') {
        Store.set(Extras.SCHEDULE_KEY, data);
      } else if (key === 'goals') {
        Store.set(Extras.GOALS_KEY, data);
      }
    } finally {
      this._internal = false;
    }
  },

  _setDocTime(key, t) {
    const times = Store.get(this.DOC_TIME_KEY, {}) || {};
    times[key] = t;
    this._internal = true;
    try { Store.set(this.DOC_TIME_KEY, times); } finally { this._internal = false; }
  },

  async _pushDoc(key) {
    const data = this._collectDoc(key);
    if (data === null) return;

    const res = await fetch(this.DOC_API, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + Cloud.getToken()
      },
      body: JSON.stringify({ key: key, data: data })
    });
    const r = await Cloud._readJson(res, '上传');
    this._setDocTime(key, Date.parse(r.updatedAt || '') || Date.now());
  },

  _enqueueDoc(key) {
    this._docQueue.add(key);
    clearTimeout(this._docTimer);
    this._docTimer = setTimeout(() => this._flushDocs(), this.DEBOUNCE);
  },

  async _flushDocs() {
    if (this._docQueue.size === 0) return;
    const keys = Array.from(this._docQueue);
    this._docQueue.clear();

    this._setState('syncing', '正在上传其他数据…');
    try {
      for (const k of keys) await this._pushDoc(k);
      this._setState('ok', '已同步 · ' + this._timeLabel());
    } catch (err) {
      this._setState('error', '上传失败：' + err.message + '（点这里重试）');
      keys.forEach(k => this._docQueue.add(k));
    }
  },

  /* ---------------- 本地改动 → 上传 ---------------- */

  onSaved(date) {
    if (!this.canSync()) return;
    this._enqueue(date, 'save');
  },

  onDeleted(date) {
    if (!this.canSync()) return;
    this._enqueue(date, 'delete');
  },

  _enqueue(date, action) {
    /* 同一天只保留最后一次动作：先存后删 = 删，先删后存 = 存 */
    this._queue.set(date, action);
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._flush(), this.DEBOUNCE);
  },

  async _flush() {
    if (this._flushing) return;
    if (this._queue.size === 0) return;

    const jobs = Array.from(this._queue.entries());
    this._queue.clear();
    this._flushing = true;

    this._setState('syncing', '正在上传 ' + jobs.length + ' 项改动…');

    try {
      const saves = [];
      const deletes = [];

      jobs.forEach(([date, action]) => {
        if (action === 'delete') { deletes.push(date); return; }
        const p = this._payload(date);
        if (!p) return;
        /* 内容被清空 = 相当于删掉这一天 */
        if (!p.content.trim()) deletes.push(date);
        else saves.push(p);
      });

      if (saves.length) await this._pushList(saves);
      for (const d of deletes) await this._deleteRemote(d);

      this._setState('ok', '已同步 · ' + this._timeLabel());
    } catch (err) {
      this._setState('error', '同步失败：' + err.message + '（点这里重试）');
      /* 失败的塞回队列，等下次或手工重试 */
      jobs.forEach(([d, a]) => this._queue.set(d, a));
    } finally {
      this._flushing = false;
      if (this._queue.size) {
        clearTimeout(this._timer);
        this._timer = setTimeout(() => this._flush(), 300);
      }
    }
  },

  retry() {
    if (this._queue.size) { this._flush(); return; }
    if (this._docQueue.size) { this._flushDocs(); return; }
    /* 没有待办也允许重试：重新拉一次 */
    this.boot();
  },

  _payload(date) {
    const e = Store.getDate(Diary.STORAGE_KEY, date);
    if (!e) return null;
    return {
      date: date,
      content: String(e.content || ''),
      mood: String(e.mood || ''),
      review: String(e.review || ''),
      /* base64 图片不往上发：云端现在存不了，发了也会被丢掉，白费流量。
         等接上 R2、图片变成真实网址后，这里的过滤会自动放行。 */
      images: (Array.isArray(e.images) ? e.images : [])
        .filter(u => typeof u === 'string' && /^https?:\/\//i.test(u)),
      pinned: !!e.pinned,
      createdAt: e.createdAt || date
    };
  },

  async _pushDates(dates) {
    const list = dates.map(d => this._payload(d)).filter(p => p && p.content.trim());
    if (list.length === 0) return { saved: 0 };
    return this._pushList(list);
  },

  async _pushList(list) {
    let saved = 0;
    for (let i = 0; i < list.length; i += this.CHUNK) {
      const res = await fetch(this.API, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + Cloud.getToken()
        },
        body: JSON.stringify({ entries: list.slice(i, i + this.CHUNK) })
      });
      const data = await Cloud._readJson(res, '上传');
      if (typeof data.saved !== 'number') {
        throw new Error('服务端返回的结果不完整，可能被中间层拦截了');
      }
      saved += data.saved;
    }
    return { saved };
  },

  async _deleteRemote(date) {
    const res = await fetch(this.API + '?date=' + encodeURIComponent(date), {
      method: 'DELETE',
      headers: { authorization: 'Bearer ' + Cloud.getToken() }
    });
    await Cloud._readJson(res, '删除云端记录');
  },

  /* 设置页里的「立即同步」 */
  async handleManualPull() {
    const box = document.getElementById('cloud-status');
    const say = (text, type) => {
      if (!box) return;
      box.style.color = type === 'ok' ? 'var(--accent-green)'
                      : type === 'err' ? 'var(--accent-red)'
                      : 'var(--text-muted)';
      box.textContent = text;
    };

    const btns = ['cloud-btn-sync', 'cloud-btn-verify', 'cloud-btn-publish'];
    btns.forEach(id => { const el = document.getElementById(id); if (el) el.disabled = true; });

    say('正在与云端同步…');
    try {
      const r = await this.pull();
      let msg = `同步完成：云端 ${r.remote} 篇`;
      if (r.added || r.updated) msg += `，拉回 ${r.added} 新增 / ${r.updated} 更新`;
      if (r.pushed) msg += `，上传 ${r.pushed} 篇`;
      say(msg, 'ok');
      if (typeof App !== 'undefined' && App.refresh) App.refresh();
    } catch (err) {
      say(err.message, 'err');
    } finally {
      btns.forEach(id => { const el = document.getElementById(id); if (el) el.disabled = false; });
    }
  },

  /* ---------------- 顶部状态徽标 ---------------- */

  _timeLabel() {
    if (!this._lastSyncAt) return '';
    return new Date(this._lastSyncAt)
      .toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  },

  _renderBadge() {
    const el = document.getElementById('sync-badge');
    if (!el) return;

    const map = {
      syncing: ['同步中…', 'var(--text-muted)'],
      ok: ['已同步 ' + this._timeLabel(), 'var(--accent-green)'],
      partial: ['部分同步', 'var(--accent-orange)'],
      error: ['同步失败', 'var(--accent-red)'],
      off: ['仅本地', 'var(--text-muted)'],
      idle: ['', '']
    };
    const pair = map[this._state] || ['', ''];
    const text = pair[0];
    const color = pair[1];
    const clickable = this._state === 'error' || this._state === 'partial';

    el.textContent = text;
    el.style.color = color;
    el.style.display = text ? 'inline-block' : 'none';
    el.style.cursor = clickable ? 'pointer' : 'default';
    el.title = this._message || '云端同步状态';
    el.onclick = clickable ? () => this.retry() : null;
  }
};

/* ---- 自动接线 ---- */
document.addEventListener('sync:change', function () { Sync._renderBadge(); });

document.addEventListener('DOMContentLoaded', function () {
  Sync._renderBadge();
  /* 断网时改动会留在队列里，网络回来自动补传 */
  window.addEventListener('online', function () {
    if (Sync.canSync()) Sync.retry();
  });
});
