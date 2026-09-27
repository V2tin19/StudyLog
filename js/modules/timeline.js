/* ============================================
   Timeline - 时间线模块
   左侧时间线展示全部日记，顶部最新、底部最旧
   数据实时读取日记存储，写入/修改后自动同步
   ============================================ */

const Timeline = {
  render(container) {
    const today = Utils.today();
    const dates = Diary.getActiveDates(); /* 已按日期倒序：顶部新、底部旧 */

    container.innerHTML = `
      <div class="card mb-16">
        <div class="card-title">
          <span>时间线</span>
          <button class="btn btn-sm btn-primary" onclick="Diary.showEditor('${today}')">写今日日记</button>
        </div>
        <div class="text-sm text-muted">按日期倒序排列 · 共 ${dates.length} 篇</div>
      </div>
      <div class="timeline" id="timeline-wrap"></div>
    `;

    const wrap = document.getElementById('timeline-wrap');
    if (dates.length === 0) {
      wrap.innerHTML = '<div class="empty-state"><div class="empty-state-text">还没有日记，写下第一篇吧</div></div>';
      return;
    }

    let html = '';
    dates.forEach(d => {
      const entry = Diary.getEntry(d);
      if (!entry || !entry.content) return;
      const content = entry.content.replace(/<[^>]*>/g, '').trim();
      const imgs = entry.images || [];
      html += `
        <div class="timeline-item">
          <span class="timeline-dot"></span>
          <span class="timeline-date">${d}</span>
          <div class="timeline-card" onclick="Diary.showEditor('${d}')">
            <div class="timeline-card-date">${d}</div>
            <div class="timeline-card-text">${content || '(空)'}</div>
            ${imgs.length ? `<div class="timeline-imgs">${imgs.slice(0, 3).map(img => `<img src="${img}" alt="日记图片">`).join('')}</div>` : ''}
          </div>
        </div>
      `;
    });
    wrap.innerHTML = html;
  }
};
