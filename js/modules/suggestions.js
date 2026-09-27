/* ============================================
   Suggestions - 书目荐读（写作台侧）

   访客在公开页「学习」里推荐书 → 落到 book_suggestions 表 → 在这里审。

   点「通过」实际做两件事：
     ① 服务端记下 approved          （/api/admin/suggestions）
     ② 写作台把这本加进自己的书单并同步（Study.addBook → Sync 自动推 doc）

   为什么第 ② 步由前端做、不交给服务端 —— 这是整个功能最容易埋雷的地方：
   书单存在 doc 表 study 那一行 JSON 里，同步策略是「谁 updatedAt 新谁赢」。
   服务端要是直接改那份 JSON，而写作台手上刚好有一份「改过但还没推上去」的
   旧版本（时间戳更新），下次同步它就会把服务端刚加进去的那本书覆盖掉，
   而且悄无声息。所以搬书这件事必须交给本来就持有这份数据的写作台做。
   ============================================ */

const Suggestions = {
  API: '/api/admin/suggestions',

  items: [],
  counts: { pending: 0, approved: 0, rejected: 0 },
  needTable: false,
  loading: false,
  error: '',
  busy: false,

  /* 两个折叠区的开合状态。要自己记 —— 重渲染会重建 DOM，
     <details> 的 open 属性会跟着丢。 */
  open: { approved: false, rejected: false },

  SETUP_SQL: `CREATE TABLE IF NOT EXISTS book_suggestions (
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

  /* ---- 加载（renderStudyPage 渲染完调用） ---- */
  async load() {
    const box = document.getElementById('suggest-body');
    if (!box) return;                       /* 已经离开学习页了 */
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
    const box = document.getElementById('suggest-body');
    if (!box) return;

    const stat = document.getElementById('suggest-stat');
    if (stat) {
      stat.textContent = this.counts.pending
        ? `${this.counts.pending} 条待审`
        : '没有待审的';
      stat.style.color = this.counts.pending ? 'var(--accent-orange)' : 'var(--text-muted)';
    }

    if (this.error) {
      box.innerHTML = `<div class="empty-state-text">读取失败：${Utils.esc(this.error)}</div>`;
      return;
    }
    if (this.needTable) { box.innerHTML = this.setupHtml(); return; }

    const pend = this.pending();
    const lost = this.notImported();      /* 通过了但还没搬进书单的（兜底） */

    let html = '';

    if (lost.length) {
      html += `<div class="suggest-alert">
        <span>有 ${lost.length} 本已通过但还没进书单</span>
        <button class="btn btn-sm btn-primary" onclick="Suggestions.importAll()">收入书单</button>
      </div>`;
    }

    if (pend.length === 0) {
      html += '<div class="empty-state-text">没有待审的推荐。访客在公开页「学习」里荐的书会出现在这儿。</div>';
    } else {
      html += pend.map(x => this.rowHtml(x, 'pending')).join('');
    }

    html += this.foldHtml('approved', '已通过', this.approved(), 'approved');
    html += this.foldHtml('rejected', '已拒绝', this.rejected(), 'rejected');

    html += '<div class="suggest-foot">「拉黑」对留言和荐读同时生效，解除拉黑在「留言」页。</div>';

    box.innerHTML = html;
  },

  foldHtml(key, label, list, mode) {
    if (!list.length) return '';
    const attr = this.open[key] ? ' open' : '';
    return `
      <details class="suggest-fold"${attr} ontoggle="Suggestions.markOpen('${key}', this.open)">
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

    let flag = '';
    if (item.status === 'approved') {
      flag = item.importedAt
        ? '<span class="suggest-flag is-ok">已进书单</span>'
        : '<span class="suggest-flag is-warn">还没进书单</span>';
    }

    const btns = [];
    if (mode === 'pending') {
      btns.push(`<button class="btn btn-sm btn-primary" onclick="Suggestions.approve(${item.id})">通过并进书单</button>`);
      btns.push(`<button class="btn btn-sm btn-secondary" onclick="Suggestions.reject(${item.id})">不要</button>`);
    } else if (mode === 'approved') {
      if (!item.importedAt) {
        btns.push(`<button class="btn btn-sm btn-primary" onclick="Suggestions.importOne(${item.id})">收入书单</button>`);
      }
      btns.push(`<button class="btn btn-sm btn-secondary" onclick="Suggestions.reject(${item.id})">撤回通过</button>`);
    } else {
      btns.push(`<button class="btn btn-sm btn-secondary" onclick="Suggestions.approve(${item.id})">改判通过</button>`);
    }
    btns.push(`<button class="btn btn-sm btn-secondary" onclick="Suggestions.block(${item.id})">拉黑</button>`);
    btns.push(`<button class="btn btn-sm btn-danger" onclick="Suggestions.remove(${item.id})">×</button>`);

    return `
      <div class="suggest-row${item.status === 'rejected' ? ' is-rejected' : ''}">
        <div class="suggest-main">
          <div class="suggest-book">
            <span class="suggest-title">《${Utils.esc(item.title)}》</span>
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
          荐读功能需要一张新表。去 Cloudflare 后台 → D1 → 你的数据库 → Console，
          把下面这段整个粘进去执行一次，然后回来点「刷新」。
        </div>
        <div class="setup-sql" id="setup-sql">${Utils.esc(this.SETUP_SQL)}</div>
        <div class="flex gap-8 mt-16">
          <button class="btn btn-sm btn-primary" onclick="Suggestions.copySql()">复制 SQL</button>
          <button class="btn btn-sm btn-secondary" onclick="Suggestions.load()">建好了，刷新</button>
        </div>
        <div class="text-sm text-muted mt-8" id="setup-msg"></div>
      </div>`;
  },

  copySql() {
    const msg = (text) => {
      const el = document.getElementById('setup-msg');
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

  /* 通过 = 服务端放行 + 本地搬进书单 */
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

    /* 已经进过书单的，撤回之后书单里那本不会自动消失 —— 先说清楚 */
    if (item.importedAt) {
      const ok = await Utils.confirm('撤回通过？公开页的荐读墙会撤下来。书单里那本《' + item.title + '》不会自动删，要去书籍列表里自己删。');
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

  /* 把已通过但还没入库的补进书单（兜底：通过的时候写作台可能没开着） */
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

  /* 真正把一本书搬进书单。顺序有讲究：
     先加本地（这是用户看得见的结果），再回服务端记 imported_at。
     万一第二步失败，书已经进了书单，而它会停在「还没进书单」上 ——
     下次打开这里能看见并补收，不会丢。 */
  async importItem(item) {
    const title = String(item.title || '').trim();
    if (!title) return;

    /* 书名去重：同名的书不重复加。这也是「补收」能安全重跑的原因 ——
       就算 imported_at 没记上，再点一次也只是被这里挡住，不会出现两本一样的。 */
    const exists = Study.getBooks().some(b => String(b.title || '').trim() === title);
    if (!exists) {
      Study.addBook({
        title: title,
        notes: this.bookNotes(item),
        from: item.name || ''
      });
    }

    try {
      await this.request(this.API, { method: 'PATCH', body: JSON.stringify({ id: item.id, action: 'imported' }) });
      item.importedAt = new Date().toISOString();
    } catch (err) {
      this.error = '《' + title + '》已经加进书单，但入库状态没记上：' + (err.message || err);
    }
  },

  /* 书籍只有「书名 + 备注」两个字段。作者并进备注，不为了一本书去改书单结构
     （改了还要动公开页的渲染，收益太小）。 */
  bookNotes(item) {
    const parts = [];
    if (item.author) parts.push('作者：' + item.author);
    if (item.note) parts.push(item.note);
    return parts.join(' · ');
  },

  async block(id) {
    const item = this.items.find(x => x.id === id);
    if (!item || this.busy) return;

    const ok = await Utils.confirm('拉黑这个网络地址？之后 TA 留言和荐读都发不出来（已有的内容不会自动消失）。');
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

    const ok = await Utils.confirm('彻底删掉这条推荐《' + item.title + '》？删了就找不回来了（只是不想公开的话，用「不要」）。');
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

  /* 操作完只刷该刷的两块：书单列表和本卡片。
     不用 App.refresh() —— 那会把整页重渲染，荐读卡会闪一次「正在读取…」。 */
  afterChange() {
    const bookList = document.getElementById('study-book-list');
    if (bookList) bookList.innerHTML = Study.renderBooks();
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
