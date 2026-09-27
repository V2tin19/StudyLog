/* ============================================
   Suggestions - 「访客推荐 → 站主审核」管理卡的公用实现

   两个实例：
     Suggestions      书目荐读（公开页「阅读」里荐书 → 进书单）
     GoalSuggestions  目标推荐（公开页「目标」里荐目标 → 进目标清单）

   两者结构一模一样，差别只有表名、几句文案、以及「搬进清单」那一步
   调的模块不同 —— 全塞进下面 makeSuggestions 的 cfg 里。
   手抄两份的话，日后改一处必漏另一处。

   ────────────────────────────────────────────
   点「通过」实际做两件事：
     ① 服务端记下 approved          （/api/admin/*）
     ② 写作台把它加进自己的清单并同步（走 Store → Sync，自动推 doc）

   为什么第 ② 步由前端做、不交给服务端 —— 这是整个功能最容易埋雷的地方：
   清单存在 doc 表那一行 JSON 里，同步策略是「谁 updatedAt 新谁赢」。
   服务端要是直接改那份 JSON，而写作台手上刚好有一份「改过但还没推上去」的
   旧版本（时间戳更新），下次同步它就会把服务端刚加进去的那条覆盖掉，
   而且悄无声息。所以搬运这件事必须交给本来就持有这份数据的写作台做。
   ──────────────────────────────────────────── */

function makeSuggestions(cfg) {
  return {
    API: cfg.api,
    BOX: cfg.boxId,
    STAT: cfg.statId,
    SETUP_SQL: cfg.setupSql,

    items: [],
    counts: { pending: 0, approved: 0, rejected: 0 },
    needTable: false,
    loading: false,
    error: '',
    busy: false,

    /* 两个折叠区的开合状态。要自己记 —— 重渲染会重建 DOM，
       <details> 的 open 属性会跟着丢。 */
    open: { approved: false, rejected: false },

    /* ---- 请求 ---- */
    async request(url, options) {
      const opts = options || {};
      const res = await fetch(url, {
        method: opts.method || 'GET',
        headers: {
          ...(opts.body ? { 'content-type': 'application/json' } : {}),
          authorization: 'Bearer ' + Cloud.getToken()
        },
        body: opts.body
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ('请求失败（' + res.status + '）'));
      return data;
    },

    /* ---- 加载（所在页面渲染完调用） ---- */
    async load() {
      const box = document.getElementById(this.BOX);
      if (!box) return;                       /* 已经离开这一页了 */
      if (this.loading) return;
      this.loading = true;

      try {
        /* 一次拉全部再在本地按状态分堆 —— 这站数据量小，
           比发三个请求（pending / approved / rejected）省事也省往返。 */
        const data = await this.request(this.API + '?filter=all&limit=200');
        this.needTable = !!data.needTable;
        this.items = data.items || [];
        this.counts = data.counts || { pending: 0, approved: 0, rejected: 0 };
        this.error = '';
      } catch (err) {
        this.error = err.message || String(err);
        this.items = [];
      } finally {
        this.loading = false;
      }

      this.render();
    },

    pending() { return this.items.filter(x => x.status === 'pending'); },
    approved() { return this.items.filter(x => x.status === 'approved'); },
    rejected() { return this.items.filter(x => x.status === 'rejected'); },
    notImported() { return this.approved().filter(x => !x.importedAt); },

    /* ---- 渲染 ---- */
    render() {
      const box = document.getElementById(this.BOX);
      if (!box) return;

      const stat = document.getElementById(this.STAT);
      if (stat) {
        stat.textContent = this.counts.pending ? this.counts.pending + ' 条待审' : '';
        stat.style.color = 'var(--accent-orange)';
      }

      if (this.error) {
        box.innerHTML = `<div class="empty-state-text">读取失败：${Utils.esc(this.error)}</div>`;
        return;
      }
      if (this.needTable) { box.innerHTML = this.setupHtml(); return; }

      const pend = this.pending();
      const lost = this.notImported();      /* 通过了但还没搬进清单的（兜底） */

      let html = '';

      if (lost.length) {
        html += `<div class="suggest-alert">
          <span>有 ${lost.length} 条已通过但还没进${cfg.listWord}</span>
          <button class="btn btn-sm btn-primary" onclick="${cfg.ns}.importAll()">收入${cfg.listWord}</button>
        </div>`;
      }

      if (pend.length === 0) {
        html += `<div class="empty-state-text">${Utils.esc(cfg.emptyHint)}</div>`;
      } else {
        html += pend.map(x => this.rowHtml(x, 'pending')).join('');
      }

      html += this.foldHtml('approved', '已通过', this.approved(), 'approved');
      html += this.foldHtml('rejected', '已拒绝', this.rejected(), 'rejected');

      html += '<div class="suggest-foot">「拉黑」对留言和所有提交同时生效，解除在「留言」页。</div>';

      box.innerHTML = html;
    },

    foldHtml(key, label, list, mode) {
      if (!list.length) return '';
      const attr = this.open[key] ? ' open' : '';
      return `
        <details class="suggest-fold"${attr} ontoggle="${cfg.ns}.markOpen('${key}', this.open)">
          <summary>${label} (${list.length})</summary>
          <div class="suggest-fold-body">${list.map(x => this.rowHtml(x, mode)).join('')}</div>
        </details>`;
    },

    markOpen(key, isOpen) {
      if (this.open[key] === isOpen) return;
      this.open[key] = isOpen;
    },

    rowHtml(item, mode) {
      const ipShort = (item.ipHash || '').slice(0, 8);
      const ns = cfg.ns;

      let flag = '';
      if (item.status === 'approved') {
        flag = item.importedAt
          ? `<span class="suggest-flag is-ok">已进${cfg.listWord}</span>`
          : `<span class="suggest-flag is-warn">还没进${cfg.listWord}</span>`;
      }

      const btns = [];
      if (mode === 'pending') {
        btns.push(`<button class="btn btn-sm btn-primary" onclick="${ns}.approve(${item.id})">通过并进${cfg.listWord}</button>`);
        btns.push(`<button class="btn btn-sm btn-secondary" onclick="${ns}.reject(${item.id})">不要</button>`);
      } else if (mode === 'approved') {
        if (!item.importedAt) {
          btns.push(`<button class="btn btn-sm btn-primary" onclick="${ns}.importOne(${item.id})">收入${cfg.listWord}</button>`);
        }
        btns.push(`<button class="btn btn-sm btn-secondary" onclick="${ns}.reject(${item.id})">撤回通过</button>`);
      } else {
        btns.push(`<button class="btn btn-sm btn-secondary" onclick="${ns}.approve(${item.id})">改判通过</button>`);
      }
      btns.push(`<button class="btn btn-sm btn-secondary" onclick="${ns}.block(${item.id})">拉黑</button>`);
      btns.push(`<button class="btn btn-sm btn-danger" onclick="${ns}.remove(${item.id})">×</button>`);

      return `
        <div class="suggest-row${item.status === 'rejected' ? ' is-rejected' : ''}">
          <div class="suggest-main">
            <div class="suggest-book">
              <span class="suggest-title">${Utils.esc(cfg.quote(item.title))}</span>
              ${item.author ? `<span class="suggest-author">${Utils.esc(item.author)}</span>` : ''}
              ${flag}
            </div>
            ${item.note ? `<div class="suggest-note">${Utils.esc(item.note)}</div>` : ''}
            <div class="suggest-meta">
              <span class="suggest-who">${Utils.esc(item.name || '访客')}</span>
              <span>${Utils.esc(this.timeLabel(item.createdAt))}</span>
              <span>地址 ${Utils.esc(ipShort)}…</span>
            </div>
          </div>
          <div class="suggest-actions">${btns.join('')}</div>
        </div>`;
    },

    setupHtml() {
      return `
        <div class="suggest-setup">
          <div class="text-sm text-muted" style="line-height:1.9;">
            ${Utils.esc(cfg.setupHint)}
          </div>
          <div class="setup-sql" id="setup-sql-${cfg.key}">${Utils.esc(this.SETUP_SQL)}</div>
          <div class="flex gap-8 mt-16">
            <button class="btn btn-sm btn-primary" onclick="${cfg.ns}.copySql()">复制 SQL</button>
            <button class="btn btn-sm btn-secondary" onclick="${cfg.ns}.load()">建好了，刷新</button>
          </div>
          <div class="text-sm text-muted mt-8" id="setup-msg-${cfg.key}"></div>
        </div>`;
    },

    copySql() {
      const msg = (text) => {
        const el = document.getElementById('setup-msg-' + cfg.key);
        if (el) el.textContent = text;
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(this.SETUP_SQL)
          .then(() => msg('已复制，去 D1 控制台粘贴执行'))
          .catch(() => msg('浏览器不让自动复制，手动选中上面那段吧'));
        return;
      }
      msg('浏览器不让自动复制，手动选中上面那段吧');
    },

    /* ---- 操作 ---- */

    /* 通过 = 服务端放行 + 本地搬进清单 */
    async approve(id) {
      const item = this.items.find(x => x.id === id);
      if (!item || this.busy) return;
      this.busy = true;

      try {
        await this.request(this.API, { method: 'PATCH', body: JSON.stringify({ id, action: 'approve' }) });
        item.status = 'approved';
        item.decidedAt = new Date().toISOString();
        await this.importItem(item);
      } catch (err) {
        alert('通过失败：' + (err.message || err));
      } finally {
        this.busy = false;
      }

      this.afterChange();
    },

    async reject(id) {
      const item = this.items.find(x => x.id === id);
      if (!item || this.busy) return;

      /* 已经进过清单的，撤回之后那条不会自动消失 —— 先说清楚 */
      if (item.importedAt) {
        const ok = await Utils.confirm(
          '撤回通过？公开页上会撤下来。' + cfg.listWord + '里' + cfg.quote(item.title) +
          '不会自动删，要自己删。');
        if (!ok) return;
      }

      this.busy = true;
      try {
        await this.request(this.API, { method: 'PATCH', body: JSON.stringify({ id, action: 'reject' }) });
        item.status = 'rejected';
        item.decidedAt = new Date().toISOString();
      } catch (err) {
        alert('操作失败：' + (err.message || err));
      } finally {
        this.busy = false;
      }

      this.afterChange();
    },

    /* 把已通过但还没入库的补进清单（兜底：通过的时候写作台可能没开着） */
    async importAll() {
      const list = this.notImported();
      if (!list.length || this.busy) return;
      this.busy = true;
      try {
        for (const item of list) await this.importItem(item);
      } finally {
        this.busy = false;
      }
      this.afterChange();
    },

    async importOne(id) {
      const item = this.items.find(x => x.id === id);
      if (!item || this.busy) return;
      this.busy = true;
      try {
        await this.importItem(item);
      } finally {
        this.busy = false;
      }
      this.afterChange();
    },

    /* 真正把一条搬进清单。顺序有讲究：
       先加本地（这是用户看得见的结果），再回服务端记 imported_at。
       万一第二步失败，条目已经进了清单，而它会停在「还没进清单」上 ——
       下次打开这里能看见并补收，不会丢。 */
    async importItem(item) {
      const title = String(item.title || '').trim();
      if (!title) return;

      /* 标题去重：同名的条目不重复加。这也是「补收」能安全重跑的原因 ——
         就算 imported_at 没记上，再点一次也只是被这里挡住，不会出现两条一样的。 */
      if (!cfg.exists(title)) {
        cfg.addToList(item);
      }

      try {
        await this.request(this.API, { method: 'PATCH', body: JSON.stringify({ id: item.id, action: 'imported' }) });
        item.importedAt = new Date().toISOString();
      } catch (err) {
        this.error = cfg.quote(title) + '已经加进' + cfg.listWord + '，但入库状态没记上：' + (err.message || err);
      }
    },

    async block(id) {
      const item = this.items.find(x => x.id === id);
      if (!item || this.busy) return;

      const ok = await Utils.confirm('拉黑这个网络地址？之后 TA 留言和提交都发不出来（已有的内容不会自动消失）。');
      if (!ok) return;

      this.busy = true;
      try {
        await this.request(this.API, { method: 'POST', body: JSON.stringify({ ipHash: item.ipHash }) });
        alert('已拉黑。解除在「留言」页。');
      } catch (err) {
        alert('拉黑失败：' + (err.message || err));
      } finally {
        this.busy = false;
      }
    },

    async remove(id) {
      const item = this.items.find(x => x.id === id);
      if (!item || this.busy) return;

      const ok = await Utils.confirm(
        '彻底删掉这条' + cfg.quote(item.title) + '？删了就找不回来了（只是不想公开的话，用「不要」）。');
      if (!ok) return;

      this.busy = true;
      try {
        await this.request(this.API + '?id=' + id, { method: 'DELETE' });
        this.items = this.items.filter(x => x.id !== id);
      } catch (err) {
        alert('删除失败：' + (err.message || err));
      } finally {
        this.busy = false;
      }

      this.afterChange();
    },

    /* 操作完只刷该刷的两块：清单列表和本卡片。
       不用 App.refresh() —— 那会把整页重渲染，这张卡会闪一次「正在读取…」。 */
    afterChange() {
      cfg.refreshList();
      this.counts = {
        pending: this.pending().length,
        approved: this.approved().length,
        rejected: this.rejected().length
      };
      this.render();
    },

    /* ISO → 9/27 21:10（今年的省年份） */
    timeLabel(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      const sameYear = d.getFullYear() === Utils.today().slice(0, 4);
      const pad = n => (n < 10 ? '0' + n : String(n));
      return (sameYear ? '' : String(d.getFullYear()).slice(2) + '/') +
        (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }
  };
}

/* ============================================================
   实例一：书目荐读（写作台「阅读」页）
   ============================================================ */

const Suggestions = makeSuggestions({
  ns: 'Suggestions',
  key: 'book',
  api: '/api/admin/suggestions',
  boxId: 'suggest-body',
  statId: 'suggest-stat',
  listWord: '书单',
  quote: (t) => '《' + t + '》',
  emptyHint: '没有待审的。访客在公开页「阅读」里荐的书会出现在这儿。',
  setupHint: '荐读功能需要一张新表。去 Cloudflare 后台 → D1 → 你的数据库 → Console，把下面这段整个粘进去执行一次，然后回来点「刷新」。',
  setupSql: `CREATE TABLE IF NOT EXISTS book_suggestions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL,
  author      TEXT    NOT NULL DEFAULT '',
  note        TEXT    NOT NULL DEFAULT '',
  name        TEXT    NOT NULL DEFAULT '',
  status      TEXT    NOT NULL DEFAULT 'pending',
  created_at  TEXT    NOT NULL,
  decided_at  TEXT    NOT NULL DEFAULT '',
  imported_at TEXT    NOT NULL DEFAULT '',
  ip_hash     TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_suggest_status ON book_suggestions(status, id);
CREATE INDEX IF NOT EXISTS idx_suggest_ip ON book_suggestions(ip_hash, created_at);`,

  exists: (title) => Study.getBooks().some(b => String(b.title || '').trim() === title),
  addToList: (item) => {
    /* 书籍只有「书名 + 备注」两个字段。作者并进备注，不为了一本书去改书单结构
       （改了还要动公开页的渲染，收益太小）。 */
    const parts = [];
    if (item.author) parts.push('作者：' + item.author);
    if (item.note) parts.push(item.note);
    Study.addBook({ title: String(item.title).trim(), notes: parts.join(' · '), from: item.name || '' });
  },
  refreshList: () => {
    const el = document.getElementById('study-book-list');
    if (el) el.innerHTML = Study.renderBooks();
  }
});

/* ============================================================
   实例二：目标推荐（写作台「目标」页）
   ============================================================ */

const GoalSuggestions = makeSuggestions({
  ns: 'GoalSuggestions',
  key: 'goal',
  api: '/api/admin/goal-suggestions',
  boxId: 'gsuggest-body',
  statId: 'gsuggest-stat',
  listWord: '目标清单',
  quote: (t) => '「' + t + '」',
  emptyHint: '没有待审的。访客在公开页「目标」里荐的目标会出现在这儿。',
  setupHint: '目标推荐需要一张新表。去 Cloudflare 后台 → D1 → 你的数据库 → Console，把下面这段整个粘进去执行一次，然后回来点「刷新」。',
  setupSql: `CREATE TABLE IF NOT EXISTS goal_suggestions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL,
  author      TEXT    NOT NULL DEFAULT '',
  note        TEXT    NOT NULL DEFAULT '',
  name        TEXT    NOT NULL DEFAULT '',
  status      TEXT    NOT NULL DEFAULT 'pending',
  created_at  TEXT    NOT NULL,
  decided_at  TEXT    NOT NULL DEFAULT '',
  imported_at TEXT    NOT NULL DEFAULT '',
  ip_hash     TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_gsuggest_status ON goal_suggestions(status, id);
CREATE INDEX IF NOT EXISTS idx_gsuggest_ip ON goal_suggestions(ip_hash, created_at);`,

  exists: (title) => Extras.getGoals().some(g => String(g.title || '').trim() === title),
  addToList: (item) => {
    Extras.addGoal({ title: String(item.title).trim(), note: item.note || '', from: item.name || '' });
  },
  refreshList: () => {
    const el = document.getElementById('goal-active-list');
    if (el) el.innerHTML = Extras.renderGoalList();
  }
});
