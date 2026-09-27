/* ============================================
   Utils - 工具函数模块
   日期格式化、DOM 工具、图表绘制等
   ============================================ */

const Utils = {
  /* ---- 日期工具 ---- */
  today() { return this.formatDate(new Date()); },

  formatDate(d) {
    if (typeof d === 'string') d = new Date(d);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  },

  formatTime(d) {
    if (typeof d === 'string') d = new Date(d);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  },

  formatDateTime(d) {
    return this.formatDate(d) + ' ' + this.formatTime(d);
  },

  parseDate(str) {
    const [y, m, d] = str.split('-').map(Number);
    return new Date(y, m - 1, d);
  },

  isToday(dateStr) { return dateStr === this.today(); },

  getWeekStart(dateStr) {
    const d = this.parseDate(dateStr);
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    return this.formatDate(d);
  },

  getMonthStart(dateStr) {
    return dateStr.slice(0, 7) + '-01';
  },

  getMonthDays(year, month) {
    return new Date(year, month, 0).getDate();
  },

  getMonthFirstDay(year, month) {
    return new Date(year, month - 1, 1).getDay();
  },

  getWeekNumber(dateStr) {
    const d = this.parseDate(dateStr);
    const start = new Date(d.getFullYear(), 0, 1);
    const diff = (d - start + (start.getTimezoneOffset() - d.getTimezoneOffset()) * 60000) / 86400000;
    return Math.ceil((diff + start.getDay() + 1) / 7);
  },

  dateRange(start, end) {
    const dates = [];
    let cur = this.parseDate(start);
    const endD = this.parseDate(end);
    while (cur <= endD) {
      dates.push(this.formatDate(cur));
      cur.setDate(cur.getDate() + 1);
    }
    return dates;
  },

  /* ---- 数字工具 ---- */
  formatNumber(n) { return Number(n).toLocaleString('zh-CN'); },

  formatMoney(n) { return '¥' + Number(n).toFixed(2); },

  /* ---- 随机 ID ---- */
  uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  },

  /* ---- 转义 ----
     把用户输入拼进 innerHTML 之前先过一道。
     日记正文走的是 textarea，不怕；但「一行文字直接拼成 HTML」的地方
     （比如目标底下那条推进记录）不过这道，内容里带个 `<` 就会把版式弄乱。 */
  esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  /* ---- 跟进记录（目标 / 书籍 / 技能共用） ----
     结构：[{ id, date: 'YYYY-MM-DD', content, createdAt }]
     挂在各自对象内部（goal.logs / book.logs / skill.logs），不是独立的一份数据 ——
     这样它跟着父对象一起被 doc 同步带走，一行同步代码都不用写。 */
  getLogs(item) {
    return (item && Array.isArray(item.logs)) ? item.logs : [];
  },

  /* 日期标签：今年的显示 9/20，跨年的显示 25/12/24 */
  logDateLabel(date) {
    const parts = String(date || '').split('-');
    if (parts.length < 3) return String(date || '');
    const sameYear = parts[0] === this.today().slice(0, 4);
    return sameYear
      ? `${Number(parts[1])}/${Number(parts[2])}`
      : `${parts[0].slice(2, 4)}/${Number(parts[1])}/${Number(parts[2])}`;
  },

  /* 追加一条，返回整个新数组。
     ⚠️ Store.updateItem 是浅合并（只覆盖你传的那几个字段），
     所以改嵌套数组必须把整个新数组传回去；只传新增的那一条会把已有记录全抹掉。 */
  appendLog(item, text) {
    return this.getLogs(item).concat([{
      id: this.uid(),
      date: this.today(),
      content: text,
      createdAt: new Date().toISOString()
    }]);
  },

  removeLog(item, logId) {
    return this.getLogs(item).filter(l => l.id !== logId);
  },

  /* 一组记录行。传进来的货按显示顺序排（最新的在上面）。
     onDelete(itemId, logId) 要返回一段 JS 调用串，比如 "Extras.deleteGoalLog('a','b')" */
  logsHtml(item, onDelete) {
    const logs = this.getLogs(item).slice().reverse();
    if (logs.length === 0) return '';
    return '<div class="track-logs">' + logs.map(l => `
      <div class="track-log">
        <span class="track-log-date">${this.logDateLabel(l.date)}</span>
        <span class="track-log-text">${this.esc(l.content)}</span>
        <button class="track-log-del" title="删除这条记录" onclick="${onDelete(item.id, l.id)}">×</button>
      </div>`).join('') + '</div>';
  },

  /* 一整块「随手记」输入行。call 是一段 JS 调用串，回车和按钮都走它 */
  logFormHtml(id, call, placeholder) {
    return `
      <div class="track-log-form">
        <input class="input" id="log-input-${id}"
               placeholder="${placeholder || '记一笔…（回车提交）'}"
               onkeydown="if(event.key==='Enter'){event.preventDefault();${call}}">
        <button class="btn btn-sm btn-primary" onclick="${call}">记录</button>
      </div>`;
  },

  /* 读输入框。空的就聚焦一下并返回 null —— 空提交当没点过，不用弹窗骂人 */
  readLogInput(id) {
    const el = document.getElementById('log-input-' + id);
    if (!el) return null;
    const text = el.value.trim();
    if (!text) { el.focus(); return null; }
    return text;
  },

  /* 整页重渲染会丢焦点 —— 记完一笔把光标放回输入框，好连着记几条 */
  focusLogInput(id) {
    const el = document.getElementById('log-input-' + id);
    if (!el) return;
    el.focus();
    if (el.setSelectionRange) el.setSelectionRange(el.value.length, el.value.length);
  },

  /* ---- 深拷贝 ---- */
  clone(obj) { return JSON.parse(JSON.stringify(obj)); },

  /* ---- DOM 工具 ---- */
  $(sel, ctx) { return (ctx || document).querySelector(sel); },

  $$(sel, ctx) { return Array.from((ctx || document).querySelectorAll(sel)); },

  html(el, html) { if (el) el.innerHTML = html; },

  show(el) { if (el) el.classList.remove('hidden'); },

  hide(el) { if (el) el.classList.add('hidden'); },

  /* ---- 确认对话框 ---- */
  confirm(msg) {
    return new Promise(resolve => {
      const dlg = document.getElementById('confirm-dialog');
      const msgEl = document.getElementById('confirm-msg');
      const ok = document.getElementById('confirm-ok');
      const cancel = document.getElementById('confirm-cancel');
      if (!dlg) { resolve(false); return; }
      msgEl.textContent = msg;
      dlg.classList.remove('hidden');
      const cleanup = () => { dlg.classList.add('hidden'); };
      ok.onclick = () => { cleanup(); resolve(true); };
      cancel.onclick = () => { cleanup(); resolve(false); };
      dlg.onclick = (e) => { if (e.target === dlg) { cleanup(); resolve(false); } };
    });
  },

  /* ---- 节流 ---- */
  throttle(fn, delay) {
    let last = 0;
    return function (...args) {
      const now = Date.now();
      if (now - last >= delay) { last = now; fn.apply(this, args); }
    };
  },

  /* ---- SVG 图表 - 简易绘制 ---- */

  /* 饼图 */
  drawPie(container, data, colors) {
    const total = data.reduce((s, d) => s + d.value, 0) || 1;
    const cx = 100, cy = 100, r = 80;
    let startAngle = -Math.PI / 2;
    let svg = `<svg viewBox="0 0 200 200" width="100%" height="200">`;

    data.forEach((item, i) => {
      const angle = (item.value / total) * Math.PI * 2;
      const endAngle = startAngle + angle;
      const x1 = cx + r * Math.cos(startAngle);
      const y1 = cy + r * Math.sin(startAngle);
      const x2 = cx + r * Math.cos(endAngle);
      const y2 = cy + r * Math.sin(endAngle);
      const large = angle > Math.PI ? 1 : 0;
      const color = colors ? colors[i % colors.length] : `hsl(${i * 60}, 60%, 70%)`;

      if (angle > 0.01) {
        svg += `<path d="M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large},1 ${x2},${y2} Z" fill="${color}" stroke="white" stroke-width="1.5"/>`;
      }
      startAngle = endAngle;
    });

    svg += '<circle cx="100" cy="100" r="35" fill="var(--bg-card)" stroke="var(--border-light)" stroke-width="1"/>';
    svg += `<text x="100" y="96" text-anchor="middle" font-size="14" font-weight="600" fill="var(--text-primary)">${total}</text>`;
    svg += `<text x="100" y="113" text-anchor="middle" font-size="10" fill="var(--text-muted)">总计</text>`;
    svg += '</svg>';

    container.innerHTML = svg;

    /* 图例 */
    let legend = '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;justify-content:center;">';
    data.forEach((item, i) => {
      const color = colors ? colors[i % colors.length] : `hsl(${i * 60}, 60%, 70%)`;
      const pct = ((item.value / total) * 100).toFixed(1);
      legend += `<span style="display:inline-flex;align-items:center;gap:4px;font-size:0.78rem;color:var(--text-secondary);">
        <span style="width:10px;height:10px;border-radius:2px;background:${color};display:inline-block;"></span>
        ${item.label} ${pct}%
      </span>`;
    });
    legend += '</div>';
    container.insertAdjacentHTML('beforeend', legend);
  },

  /* 柱状图 */
  drawBar(container, data, options) {
    const h = options?.height || 160;
    const barWidth = options?.barWidth || 20;
    const gap = options?.gap || 8;
    const maxVal = Math.max(...data.map(d => d.value), 1);
    const totalWidth = data.length * (barWidth + gap) - gap + 40;
    const color = options?.color || 'var(--accent-blue)';

    let svg = `<svg viewBox="0 0 ${Math.max(totalWidth, 200)} ${h + 30}" width="100%" style="max-width:100%;">`;

    data.forEach((item, i) => {
      const x = 20 + i * (barWidth + gap);
      const barH = (item.value / maxVal) * h;
      const y = h - barH;
      svg += `<rect x="${x}" y="${y}" width="${barWidth}" height="${barH}" rx="4" fill="${color}" opacity="0.8">
        <animate attributeName="height" from="0" to="${barH}" dur="0.3s" fill="freeze"/>
      </rect>`;
      if (item.label) {
        svg += `<text x="${x + barWidth / 2}" y="${h + 16}" text-anchor="middle" font-size="9" fill="var(--text-muted)">${item.label}</text>`;
      }
    });

    svg += '</svg>';
    container.innerHTML = svg;
  },

  /* 折线图 */
  drawLine(container, data, options) {
    const w = options?.width || 300;
    const h = options?.height || 140;
    const pad = options?.pad || 20;
    const maxVal = Math.max(...data.map(d => d.value), 1);
    const stepX = (w - pad * 2) / Math.max(data.length - 1, 1);
    const color = options?.color || 'var(--accent-blue)';

    const points = data.map((d, i) => ({
      x: pad + i * stepX,
      y: h - pad - ((d.value / maxVal) * (h - pad * 2))
    }));

    const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');

    let svg = `<svg viewBox="0 0 ${w} ${h}" width="100%" style="max-width:100%;">`;
    svg += `<path d="${pathD}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
    svg += `<path d="${pathD} L${points[points.length - 1].x},${h - pad} L${points[0].x},${h - pad} Z" fill="${color}" opacity="0.08"/>`;

    points.forEach((p, i) => {
      svg += `<circle cx="${p.x}" cy="${p.y}" r="3" fill="${color}" stroke="white" stroke-width="1.5"/>`;
    });

    svg += '</svg>';
    container.innerHTML = svg;
  }
};