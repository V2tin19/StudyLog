/* ============================================
   Comments - 留言管理（写作台）

   留言是全站唯一一个「访客能写」的东西，所以这里是唯一的出口：
   能隐藏（软删，可恢复）、能彻底删、能把一个网络地址拉黑。

   留言表没建的时候，这一页直接显示可以复制的建表 SQL ——
   比写一句「请执行 schema.sql」有用得多。
   ============================================ */

const Comments = {
  API: '/api/admin/comments',

  SETUP_SQL: `CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scope      TEXT    NOT NULL DEFAULT 'diary',
  target     TEXT    NOT NULL DEFAULT '',
  name       TEXT    NOT NULL DEFAULT '',
  content    TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  ip_hash    TEXT    NOT NULL DEFAULT '',
  hidden     INTEGER NOT NULL DEFAULT 0,
  reply      TEXT    NOT NULL DEFAULT '',
  reply_at   TEXT    NOT NULL DEFAULT '',
  location   TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_comments_target ON comments(scope, target, hidden, id);
CREATE INDEX IF NOT EXISTS idx_comments_ip ON comments(ip_hash, created_at);

CREATE TABLE IF NOT EXISTS comment_blocklist (
  ip_hash    TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);`,

  ALTER_SQL: `ALTER TABLE comments ADD COLUMN reply TEXT NOT NULL DEFAULT '';
ALTER TABLE comments ADD COLUMN reply_at TEXT NOT NULL DEFAULT '';
ALTER TABLE comments ADD COLUMN location TEXT NOT NULL DEFAULT '';`,

  filter: 'all',
  list: [],
  blocked: [],
  total: 0,
  hiddenCount: 0,
  needTable: false,
  loading: false,
  error: '',

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

  /* ---- 页面 ---- */
  render(container) {
    container.innerHTML = `
      <div class="card page-enter mb-16">
        <div class="card-title">
          <span>留言</span>
          <button class="btn btn-sm btn-secondary" onclick="App.navigate('dashboard')">← 返回</button>
          <button class="btn btn-sm btn-primary" onclick="Comments.refresh()">刷新</button>
        </div>
        <div class="flex gap-12 items-center" style="flex-wrap:wrap;">
          <div class="tabs" id="comment-tabs" style="margin-bottom:0;">${this.tabsHtml()}</div>
          <span class="text-sm text-muted" id="comment-stat" style="margin-left:auto;"></span>
        </div>
      </div>
      <div id="comment-body"><div class="empty-state-text">正在读取…</div></div>
    `;
    this.refresh();
  },

  tabsHtml() {
    const items = [['all', '全部'], ['diary', '日记下'], ['board', '留言簿'], ['hidden', '已隐藏']];
    return items.map(([key, label]) =>
      `<button class="tab${this.filter === key ? ' active' : ''}" onclick="Comments.setFilter('${key}')">${label}</button>`
    ).join('');
  },

  setFilter(key) {
    this.filter = key;
    const tabs = document.getElementById('comment-tabs');
    if (tabs) tabs.innerHTML = this.tabsHtml();
    this.refresh();
  },

  bodyEl() { return document.getElementById('comment-body'); },

  body(html) {
    const el = this.bodyEl();
    if (el) el.innerHTML = html;
  },

  async refresh() {
    if (this.loading) return;
    this.loading = true;
    this.body('<div class="empty-state-text">正在读取…</div>');

    try {
      const data = await this.request(this.API + '?limit=100&filter=' + encodeURIComponent(this.filter));
      this.needTable = !!data.needTable;
      this.list = data.comments || [];
      this.blocked = data.blocked || [];
      this.total = data.total || 0;
      this.hiddenCount = data.hiddenCount || 0;
      this.error = '';
    } catch (err) {
      this.error = err.message || String(err);
      this.list = [];
    } finally {
      this.loading = false;
    }

    this.renderBody();
    this.renderStat();
  },

  renderStat() {
    const el = document.getElementById('comment-stat');
    if (!el) return;
    if (this.error) { el.textContent = ''; return; }
    el.textContent = `共 ${this.total} 条 · 已隐藏 ${this.hiddenCount}${this.blocked.length ? ' · 已拉黑 ' + this.blocked.length + ' 个地址' : ''}`;
  },

  renderBody() {
    if (this.error) {
      this.body(`<div class="card"><div class="card-title"><span>读取失败</span></div>
        <div class="empty-state-text">${Utils.esc(this.error)}</div></div>`);
      return;
    }

    if (this.needTable) { this.body(this.setupHtml()); return; }

    if (this.list.length === 0) {
      const tips = {
        all: '还没有留言',
        diary: '日记下还没有留言',
        board: '留言簿还没有留言',
        hidden: '没有隐藏的留言'
      };
      this.body(`<div class="card"><div class="empty-state-text">${tips[this.filter] || '还没有留言'}</div></div>`);
      return;
    }

    this.body(`
      <div class="card mb-16">
        <div class="card-title"><span>${this.listTitle()}</span></div>
        ${this.list.map(c => this.rowHtml(c)).join('')}
      </div>
      ${this.blocked.length ? this.blockedHtml() : ''}
    `);
  },

  listTitle() {
    const n = this.list.length;
    const names = { all: '全部留言', diary: '日记下的留言', board: '留言簿', hidden: '已隐藏的留言' };
    return `${names[this.filter] || '留言'} (${n})`;
  },

  /* 一条留言 */
  rowHtml(c) {
    const isBoard = c.scope === 'board';
    /* 日记下的留言，target 就是那一天的日期 */
    const src = isBoard ? '留言簿' : ('日记 ' + (c.target || '').slice(5).replace('-', '/'));
    const ipShort = (c.ipHash || '').slice(0, 8);
    const blocked = this.blocked.some(b => b.ipHash === c.ipHash);
    const loc = c.location || '未知';

    return `
      <div class="comment-row${c.hidden ? ' is-hidden' : ''}" id="comment-row-${c.id}">
        <div class="comment-meta">
          <span class="comment-src${isBoard ? ' is-board' : ''}">${Utils.esc(src)}</span>
          <span class="comment-who">${Utils.esc(c.name || '访客')}</span>
          <span class="comment-loc" title="发送者属地">属地 ${Utils.esc(loc)}</span>
          <span>${Utils.esc(this.timeLabel(c.createdAt))}</span>
          <span>地址 ${Utils.esc(ipShort)}…</span>
          ${c.hidden ? '<span class="comment-flag">已隐藏</span>' : ''}
          ${blocked ? '<span class="comment-flag">已拉黑</span>' : ''}
        </div>
        <div class="comment-text">${Utils.esc(c.content)}</div>
        ${c.reply ? `
          <div class="admin-comment-reply">
            <div class="admin-reply-head">
              <span class="admin-reply-badge">站主回复</span>
              <span class="text-xs text-muted">${Utils.esc(this.timeLabel(c.replyAt))}</span>
            </div>
            <div class="admin-reply-text">${Utils.esc(c.reply)}</div>
          </div>
        ` : ''}
        <div class="comment-actions">
          <button class="btn btn-sm btn-primary" onclick="Comments.openReply(${c.id})">
            ${c.reply ? '编辑回复' : '回复'}
          </button>
          ${c.reply ? `
            <button class="btn btn-sm btn-secondary" onclick="Comments.removeReply(${c.id})">
              删除回复
            </button>
          ` : ''}
          <button class="btn btn-sm btn-secondary"
                  onclick="Comments.toggleHidden(${c.id}, ${c.hidden ? 'false' : 'true'})">
            ${c.hidden ? '恢复显示' : '隐藏'}
          </button>
          ${blocked ? '' :
            `<button class="btn btn-sm btn-secondary" onclick="Comments.blockIp('${ipShort}')">拉黑这个地址</button>`}
          <button class="btn btn-sm btn-danger" onclick="Comments.removeComment(${c.id})">彻底删除</button>
        </div>
        <div id="reply-box-${c.id}" class="comment-reply-box hidden"></div>
      </div>
    `;
  },

  /* 黑名单 */
  blockedHtml() {
    return `
      <div class="card">
        <div class="card-title"><span>已拉黑的地址 (${this.blocked.length})</span></div>
        <div class="text-sm text-muted mb-8">这些地址发不出留言。解除之后立刻能再发。</div>
        ${this.blocked.map(b => `
          <div class="list-item">
            <div class="list-item-main">
              <div class="list-item-title">${Utils.esc((b.ipHash || '').slice(0, 16))}…</div>
              <div class="list-item-sub">拉黑于 ${Utils.esc(this.timeLabel(b.createdAt))}</div>
            </div>
            <button class="btn btn-sm btn-secondary" onclick="Comments.unblock('${b.ipHash}')">解除</button>
          </div>
        `).join('')}
      </div>
    `;
  },

  /* 表还没建：把 SQL 直接摆出来给他复制 */
  setupHtml() {
    return `
      <div class="card">
        <div class="card-title"><span>还差一步：建表</span></div>
        <div class="text-sm text-muted" style="line-height:1.9;">
          留言功能需要两张新表。去 Cloudflare 后台 → D1 → 你的数据库 → Console，
          把下面这段整个粘进去执行一次，然后回来点「刷新」。
        </div>
        <div class="setup-sql" id="setup-sql">${Utils.esc(this.SETUP_SQL)}</div>
        <div class="flex gap-8 mt-16" style="flex-wrap:wrap;">
          <button class="btn btn-sm btn-primary" onclick="Comments.copySql()">复制建表 SQL</button>
          <button class="btn btn-sm btn-secondary" onclick="Comments.copyAlterSql()">复制升级 SQL（老表补字段）</button>
          <button class="btn btn-sm btn-secondary" onclick="Comments.refresh()">建好了，刷新</button>
        </div>
        <div class="text-sm text-muted mt-8" id="setup-msg"></div>
      </div>
    `;
  },

  copySql() {
    const msg = (text) => {
      const el = document.getElementById('setup-msg');
      if (el) el.textContent = text;
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(this.SETUP_SQL)
        .then(() => msg('已复制建表 SQL，去 D1 控制台粘贴执行'))
        .catch(() => msg('浏览器不让自动复制，手动选中上面那段吧'));
      return;
    }
    msg('浏览器不让自动复制，手动选中上面那段吧');
  },

  copyAlterSql() {
    const msg = (text) => {
      const el = document.getElementById('setup-msg');
      if (el) el.textContent = text;
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(this.ALTER_SQL)
        .then(() => msg('已复制升级 SQL（补充回复与属地字段），去 D1 控制台粘贴执行'))
        .catch(() => msg('浏览器不让自动复制，手动选中上面那段吧'));
      return;
    }
    msg('浏览器不让自动复制，手动选中上面那段吧');
  },

  /* ---- 回复操作 ---- */
  openReply(id) {
    const c = this.list.find(x => x.id === id);
    if (!c) return;
    const box = document.getElementById('reply-box-' + id);
    if (!box) return;

    box.classList.remove('hidden');
    box.innerHTML = `
      <div class="comment-reply-form">
        <textarea id="reply-text-${id}" class="textarea" rows="3" maxlength="1000"
          placeholder="写下对 ${Utils.esc(c.name || '访客')} 的回复…">${Utils.esc(c.reply || '')}</textarea>
        <div class="flex gap-8 mt-8">
          <button class="btn btn-sm btn-primary" onclick="Comments.saveReply(${id})">保存回复</button>
          <button class="btn btn-sm btn-secondary" onclick="Comments.closeReply(${id})">取消</button>
        </div>
      </div>
    `;
    const textarea = document.getElementById('reply-text-' + id);
    if (textarea) textarea.focus();
  },

  closeReply(id) {
    const box = document.getElementById('reply-box-' + id);
    if (box) {
      box.classList.add('hidden');
      box.innerHTML = '';
    }
  },

  async saveReply(id) {
    const textarea = document.getElementById('reply-text-' + id);
    if (!textarea) return;
    const reply = (textarea.value || '').trim();
    if (!reply) {
      alert('请输入回复内容（若想删除已有回复，请点「删除回复」按钮）');
      textarea.focus();
      return;
    }

    try {
      await this.request(this.API, {
        method: 'PATCH',
        body: JSON.stringify({ id, reply })
      });
      await this.refresh();
    } catch (err) {
      alert('保存回复失败：' + (err.message || err));
    }
  },

  async removeReply(id) {
    const ok = await Utils.confirm('确定删除对该留言的站主回复？');
    if (!ok) return;

    try {
      await this.request(this.API, {
        method: 'PATCH',
        body: JSON.stringify({ id, reply: '' })
      });
      await this.refresh();
    } catch (err) {
      alert('删除回复失败：' + (err.message || err));
    }
  },

  /* ---- 操作 ---- */
  async toggleHidden(id, hidden) {
    try {
      await this.request(this.API, { method: 'PATCH', body: JSON.stringify({ id, hidden }) });
      await this.refresh();
    } catch (err) {
      alert('操作失败：' + (err.message || err));
    }
  },

  async removeComment(id) {
    const ok = await Utils.confirm('彻底删除这条留言？删了就找不回来了（只想让它不显示的话，用「隐藏」。）');
    if (!ok) return;
    try {
      await this.request(this.API + '?id=' + id, { method: 'DELETE' });
      await this.refresh();
    } catch (err) {
      alert('删除失败：' + (err.message || err));
    }
  },

  async blockIp(ipShort) {
    /* 列表上只显示前 8 位，但拉黑要用完整的哈希。
       从当前列表里找回完整值，别把短的那个写进库里。 */
    const hit = this.list.find(c => (c.ipHash || '').slice(0, 8) === ipShort);
    if (!hit) { alert('找不到这条留言的网络地址，刷新一下再试'); return; }

    const ok = await Utils.confirm('拉黑这个网络地址？之后 TA 一条都发不出来（已有的留言不会自动消失）。');
    if (!ok) return;

    try {
      await this.request(this.API, { method: 'POST', body: JSON.stringify({ ipHash: hit.ipHash }) });
      await this.refresh();
    } catch (err) {
      alert('拉黑失败：' + (err.message || err));
    }
  },

  async unblock(ipHash) {
    try {
      await this.request(this.API + '?ipHash=' + encodeURIComponent(ipHash), { method: 'DELETE' });
      await this.refresh();
    } catch (err) {
      alert('解除失败：' + (err.message || err));
    }
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
