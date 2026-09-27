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