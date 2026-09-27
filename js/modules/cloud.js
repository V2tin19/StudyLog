/* ============================================
   Cloud - 云端同步模块
   把本地写的日记发布到 Cloudflare D1，供公开页展示。

   权限说明：
   真正的关卡在服务端（/api/admin/diary 会校验令牌），
   这里保存的令牌只是用来向服务器证明「我是我」。
   令牌属于敏感信息，只存在你自己的浏览器里。
   ============================================ */

const Cloud = {
  TOKEN_KEY: 'studylog_admin_token',
  API: '/api/admin/diary',

  /* ---- 令牌管理 ---- */

  getToken() {
    try { return localStorage.getItem(this.TOKEN_KEY) || ''; } catch { return ''; }
  },

  setToken(token) {
    try {
      if (token) localStorage.setItem(this.TOKEN_KEY, token);
      else localStorage.removeItem(this.TOKEN_KEY);
      return true;
    } catch { return false; }
  },

  /* 取输入框里的令牌（有就顺手存起来），返回当前要用的令牌 */
  _resolveToken() {
    const input = document.getElementById('cloud-token');
    const typed = input ? input.value.trim() : '';
    if (typed) this.setToken(typed);
    return this.getToken();
  },

  /* ---- 收集本地日记 ---- */

  collect() {
    const all = Store.get(Diary.STORAGE_KEY, {}) || {};
    const moods = Store.get(Diary.MOOD_KEY, {}) || {};
    const list = [];

    Object.keys(all).forEach(date => {
      const e = all[date];
      if (!e || !e.content) return;   /* 没写内容的空记录不发布 */
      list.push({
        date,
        content: e.content || '',
        mood: e.mood || moods[date] || '',
        review: e.review || '',
        images: Array.isArray(e.images) ? e.images : [],
        pinned: !!e.pinned,
        createdAt: e.createdAt || date
      });
    });

    /* 置顶的排前面，其余按日期倒序，发布顺序更好读 */
    return list.sort((a, b) => (b.pinned - a.pinned) || (a.date < b.date ? 1 : -1));
  },

  /* ---- 与服务器通信 ---- */

  /* 读响应：必须是 JSON，且必须明确 ok:true 才算成功。
     如果被 Cloudflare Access 之类的登录页拦了，返回的是 HTML，
     绝不能把它当成成功——那是「静默失败」，比报错更危险。 */
  async _readJson(res, action) {
    const text = await res.text();

    let data = null;
    try { data = JSON.parse(text); } catch { data = null; }

    if (!data) {
      const looksLikeLogin = res.redirected || /<html|<!doctype/i.test(text);
      if (looksLikeLogin) {
        throw new Error('请求被登录页拦截了（可能已开启 Cloudflare Access）。请先在浏览器里登录，再回来重试');
      }
      throw new Error(`${action}失败：服务器返回了非预期的内容（HTTP ${res.status}）`);
    }

    if (!res.ok) throw new Error(data.error || `${action}失败（HTTP ${res.status}）`);
    if (data.ok !== true) throw new Error(data.error || `${action}失败：服务端没有确认，请检查令牌`);

    return data;
  },

  async verify() {
    const token = this._resolveToken();
    if (!token) throw new Error('请先填入管理令牌');

    const res = await fetch(this.API, { headers: { authorization: 'Bearer ' + token } });
    return this._readJson(res, '验证');
  },

  async publish() {
    const token = this._resolveToken();
    if (!token) throw new Error('请先填入管理令牌');

    const entries = this.collect();
    if (entries.length === 0) throw new Error('本地还没有写过日记，先去「日记」页写一篇吧');

    const res = await fetch(this.API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ entries })
    });

    const data = await this._readJson(res, '发布');
    if (typeof data.saved !== 'number') {
      throw new Error('发布失败：服务端返回的结果不完整，可能被中间层拦截了');
    }
    return data;
  },

  /* ---- 界面交互 ---- */

  _setStatus(msg, type) {
    const box = document.getElementById('cloud-status');
    if (!box) return;
    box.style.color = type === 'ok' ? 'var(--accent-green)'
                    : type === 'err' ? 'var(--accent-red)'
                    : 'var(--text-muted)';
    box.textContent = msg;
  },

  _busy(busy) {
    ['cloud-btn-save', 'cloud-btn-verify', 'cloud-btn-publish'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = !!busy;
    });
  },

  handleSaveToken() {
    const token = this._resolveToken();
    if (!token) { this._setStatus('令牌是空的，没保存', 'err'); return; }
    this._setStatus('令牌已保存在本机浏览器里', 'ok');
  },

  async handleVerify() {
    this._busy(true);
    this._setStatus('正在连接…', 'info');
    try {
      const data = await this.verify();
      this._setStatus(`连接成功，云端目前有 ${data.count || 0} 篇日记`, 'ok');
    } catch (err) {
      this._setStatus(err.message, 'err');
    } finally {
      this._busy(false);
    }
  },

  async handlePublish() {
    this._busy(true);
    this._setStatus('正在发布…', 'info');
    try {
      const data = await this.publish();
      let msg = `发布完成：已写入 ${data.saved} 篇`;
      if (data.skipped && data.skipped.length) msg += `，跳过 ${data.skipped.length} 篇`;
      if (data.note) msg += `。${data.note}`;
      this._setStatus(msg, data.skipped && data.skipped.length ? 'info' : 'ok');
    } catch (err) {
      this._setStatus(err.message, 'err');
    } finally {
      this._busy(false);
    }
  }
};
