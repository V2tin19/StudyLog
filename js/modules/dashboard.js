/* ============================================
   Dashboard - 数据仪表盘 / 总览模块
   全站数据聚合、统计图表、快捷入口、留言互动看板
   ============================================ */

const Dashboard = {
  render(container) {
    const today = Utils.today();

    /* 核心本地数据统计 */
    const diaryDates = Diary.getActiveDates();
    const diaryCount = diaryDates.length;

    const activeGoals = Extras.getGoals().filter(g => !g.done).length;

    const todayDiary = Diary.getEntry(today);
    const todayStudyMin = Study.getDurationByDate(today);
    const todayTasks = Study.getTodayTasks();
    const doneTasks = todayTasks.filter(t => t.done).length;

    /* 顶部微统计卡片 + 快捷入口 + 留言看板容器 */
    container.innerHTML = `
      <div class="mb-16 page-enter">
        <div style="font-size:0.9rem;color:var(--text-secondary);margin-bottom:8px;">
          ${new Date().toLocaleDateString('zh-CN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
        </div>
        <div class="card-grid card-grid-4">
          <div class="card stat-card">
            <div class="stat-value">${diaryCount}</div>
            <div class="stat-label">日记总数</div>
          </div>
          <div class="card stat-card">
            <div class="stat-value">${activeGoals}</div>
            <div class="stat-label">进行中目标</div>
          </div>
          <div class="card stat-card">
            <div class="stat-value" id="dash-comment-count">-</div>
            <div class="stat-label">收到留言</div>
          </div>
          <div class="card stat-card">
            <div class="stat-value" id="dash-unreplied-count" style="color:var(--accent-orange);">-</div>
            <div class="stat-label">待回复留言</div>
          </div>
        </div>
      </div>

      <!-- 今日概览 -->
      <div class="card mb-16">
        <div class="card-title"><span>今日概览</span></div>
        <div class="list-item">
          <span>日记</span>
          <span>${todayDiary ? '已记录' : '未记录'}</span>
        </div>
        <div class="list-item">
          <span>学习</span>
          <span>${todayStudyMin > 0 ? Study.formatDuration(todayStudyMin) : '未记录'}</span>
        </div>
        <div class="list-item">
          <span>任务</span>
          <span>${doneTasks}/${todayTasks.length}</span>
        </div>
        <div class="mt-8 flex gap-8" style="flex-wrap:wrap;">
          <a href="#/diary" class="btn btn-sm btn-primary">写日记</a>
          <a href="#/study" class="btn btn-sm btn-primary">去学习</a>
          <button class="btn btn-sm btn-secondary" onclick="App.navigate('comments')">看留言</button>
        </div>
      </div>

      <!-- 留言互动看板（异步拉取云端统计） -->
      <div id="dash-comments-section">
        <div class="card mb-16">
          <div class="card-title"><span>留言互动看板</span></div>
          <div class="empty-state-text">正在统计留言互动数据…</div>
        </div>
      </div>

      <!-- 快捷入口 -->
      <div class="card mb-16">
        <div class="card-title"><span>快捷入口</span></div>
        <div class="flex gap-12" style="flex-wrap:wrap;">
          <button class="btn btn-secondary" onclick="Diary.showSearch()">搜索日记</button>
          <button class="btn btn-secondary" onclick="Study.showAddSession()">记录学习</button>
          <button class="btn btn-secondary" onclick="App.navigate('comments')">留言管理</button>
          <button class="btn btn-secondary" onclick="App.navigate('settings')">设置</button>
        </div>
      </div>
    `;

    this.loadCommentsData();
  },

  async loadCommentsData() {
    const section = document.getElementById('dash-comments-section');
    if (!section) return;

    const token = typeof Cloud !== 'undefined' ? Cloud.getToken() : '';
    if (!token) {
      this.updateTopCards(0, 0);
      section.innerHTML = `
        <div class="card mb-16">
          <div class="card-title"><span>留言互动看板</span></div>
          <div class="text-sm text-muted" style="line-height:1.7;">
            当前为仅本地模式（尚未配置管理暗号）。在「设置 → 云端同步」配置令牌后，即可实时统计访客留言与属地数据。
          </div>
        </div>
      `;
      return;
    }

    try {
      const res = await fetch('/api/admin/comments?limit=200', {
        headers: { authorization: 'Bearer ' + token }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ('请求失败（' + res.status + '）'));

      if (data.needTable) {
        this.updateTopCards(0, 0);
        section.innerHTML = `
          <div class="card mb-16">
            <div class="card-title"><span>留言互动看板</span></div>
            <div class="text-sm text-muted" style="line-height:1.7;">
              云端尚未创建留言表。<a href="#/comments" style="color:var(--accent-blue);font-weight:500;">前往留言页</a> 复制 SQL 并在 Cloudflare D1 控制台执行即可启用。
            </div>
          </div>
        `;
        return;
      }

      const comments = data.comments || [];
      this.renderCommentsDashboard(section, comments);
    } catch (err) {
      this.updateTopCards('-', '-');
      section.innerHTML = `
        <div class="card mb-16">
          <div class="card-title"><span>留言互动看板</span></div>
          <div class="text-sm text-muted">统计读取失败：${Utils.esc(err.message || String(err))}</div>
        </div>
      `;
    }
  },

  updateTopCards(total, unreplied) {
    const elTotal = document.getElementById('dash-comment-count');
    const elUnreplied = document.getElementById('dash-unreplied-count');
    if (elTotal) elTotal.textContent = total;
    if (elUnreplied) {
      elUnreplied.textContent = unreplied;
      elUnreplied.style.color = (typeof unreplied === 'number' && unreplied > 0)
        ? 'var(--accent-orange)' : 'var(--accent-green)';
    }
  },

  renderCommentsDashboard(container, comments) {
    const total = comments.length;
    const active = comments.filter(c => !c.hidden);
    const unreplied = active.filter(c => !c.reply);
    const replied = active.filter(c => !!c.reply);
    const replyRate = active.length > 0 ? Math.round((replied.length / active.length) * 100) : 100;

    this.updateTopCards(total, unreplied.length);

    // 属地统计
    const locMap = {};
    active.forEach(c => {
      const loc = c.location || '未知';
      locMap[loc] = (locMap[loc] || 0) + 1;
    });
    const locEntries = Object.entries(locMap).sort((a, b) => b[1] - a[1]);
    const validLocCount = locEntries.filter(([k]) => k !== '未知' && k !== '本地').length;

    // 来源渠道统计
    const diaryCount = active.filter(c => c.scope === 'diary').length;
    const boardCount = active.filter(c => c.scope === 'board').length;
    const diaryPct = active.length > 0 ? Math.round((diaryCount / active.length) * 100) : 0;
    const boardPct = active.length > 0 ? (100 - diaryPct) : 0;

    // 最新待回复与动态（优先待回复，随后时间倒序，取前 3 条）
    const sorted = active.slice().sort((a, b) => {
      if (!a.reply && b.reply) return -1;
      if (a.reply && !b.reply) return 1;
      return b.id - a.id;
    });
    const recent = sorted.slice(0, 3);

    container.innerHTML = `
      <div class="card mb-16">
        <div class="card-title">
          <span>留言互动看板</span>
          <button class="btn btn-sm btn-primary" onclick="App.navigate('comments')">进入留言管理 →</button>
        </div>

        <!-- 4 维微指标 -->
        <div class="card-grid card-grid-4 mb-16" style="margin-top:6px;">
          <div style="background:var(--bg-tertiary);border-radius:var(--radius-md);padding:12px;text-align:center;">
            <div style="font-size:1.35rem;font-weight:700;color:var(--text-primary);line-height:1.2;">${total}</div>
            <div class="text-sm text-muted mt-8">收到留言</div>
          </div>
          <div style="background:var(--bg-tertiary);border-radius:var(--radius-md);padding:12px;text-align:center;">
            <div style="font-size:1.35rem;font-weight:700;line-height:1.2;color:${unreplied.length > 0 ? 'var(--accent-orange)' : 'var(--accent-green)'};">
              ${unreplied.length}
            </div>
            <div class="text-sm text-muted mt-8">${unreplied.length > 0 ? '待回复留言' : '全部已回复 ✓'}</div>
          </div>
          <div style="background:var(--bg-tertiary);border-radius:var(--radius-md);padding:12px;text-align:center;">
            <div style="font-size:1.35rem;font-weight:700;color:var(--accent-blue);line-height:1.2;">${replyRate}%</div>
            <div class="text-sm text-muted mt-8">回复率</div>
          </div>
          <div style="background:var(--bg-tertiary);border-radius:var(--radius-md);padding:12px;text-align:center;">
            <div style="font-size:1.35rem;font-weight:700;color:var(--accent-pink);line-height:1.2;">${validLocCount || (locEntries.length ? 1 : 0)}</div>
            <div class="text-sm text-muted mt-8">属地省市</div>
          </div>
        </div>

        <!-- 属地热度 TOP & 来源渠道双列图表 -->
        <div class="card-grid card-grid-2 mb-16">
          <!-- 属地分布 -->
          <div style="background:var(--bg-tertiary);border-radius:var(--radius-md);padding:14px;">
            <div style="font-size:0.85rem;font-weight:600;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;">
              <span>访客属地热度 TOP</span>
              <span class="text-muted" style="font-size:0.75rem;">覆盖 ${locEntries.length} 处</span>
            </div>
            ${locEntries.length === 0 ? '<div class="text-sm text-muted">暂无属地数据</div>' :
              locEntries.slice(0, 5).map(([loc, cnt]) => {
                const pct = Math.round((cnt / (active.length || 1)) * 100);
                return `
                  <div style="margin-bottom:9px;">
                    <div style="display:flex;justify-content:space-between;font-size:0.78rem;margin-bottom:4px;">
                      <span><span class="comment-loc" style="margin-right:6px;">${Utils.esc(loc)}</span></span>
                      <span class="text-muted">${cnt} 条 (${pct}%)</span>
                    </div>
                    <div class="progress-bar" style="height:5px;">
                      <div class="progress-fill" style="width:${pct}%;background:var(--accent-blue);"></div>
                    </div>
                  </div>
                `;
              }).join('')
            }
          </div>

          <!-- 来源渠道与回复完成度 -->
          <div style="background:var(--bg-tertiary);border-radius:var(--radius-md);padding:14px;">
            <div style="font-size:0.85rem;font-weight:600;margin-bottom:12px;">留言来源分布</div>
            
            <div style="margin-bottom:12px;">
              <div style="display:flex;justify-content:space-between;font-size:0.78rem;margin-bottom:4px;">
                <span>日记下方留言</span>
                <span class="text-muted">${diaryCount} 条 (${diaryPct}%)</span>
              </div>
              <div class="progress-bar" style="height:5px;">
                <div class="progress-fill" style="width:${diaryPct}%;background:var(--accent-blue);"></div>
              </div>
            </div>

            <div style="margin-bottom:14px;">
              <div style="display:flex;justify-content:space-between;font-size:0.78rem;margin-bottom:4px;">
                <span>独立留言簿</span>
                <span class="text-muted">${boardCount} 条 (${boardPct}%)</span>
              </div>
              <div class="progress-bar" style="height:5px;">
                <div class="progress-fill" style="width:${boardPct}%;background:var(--accent-orange);"></div>
              </div>
            </div>

            <div style="padding-top:10px;border-top:1px dashed var(--border-light);font-size:0.76rem;color:var(--text-secondary);display:flex;justify-content:space-between;">
              <span>已回复 <strong>${replied.length}</strong> 条</span>
              <span>待回复 <strong style="color:var(--accent-orange);">${unreplied.length}</strong> 条</span>
            </div>
          </div>
        </div>

        <!-- 最新动态 / 待回复速览 -->
        <div>
          <div style="font-size:0.85rem;font-weight:600;margin-bottom:10px;">
            ${unreplied.length > 0 ? '待回复留言速览' : '最新留言速览'}
          </div>
          ${recent.length === 0 ? '<div class="empty-state-text">还没有收到留言</div>' :
            recent.map(c => `
              <div class="list-item" style="align-items:flex-start;padding:10px 0;">
                <div class="list-item-main">
                  <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:0.76rem;">
                    <strong style="color:var(--text-primary);">${Utils.esc(c.name || '访客')}</strong>
                    <span class="comment-loc">属地 ${Utils.esc(c.location || '未知')}</span>
                    <span class="comment-src ${c.scope === 'board' ? 'is-board' : ''}">
                      ${c.scope === 'board' ? '留言簿' : ('日记 ' + (c.target || '').slice(5).replace('-', '/'))}
                    </span>
                    <span class="text-muted">${Utils.esc(Dashboard.timeLabel(c.createdAt))}</span>
                    ${c.reply ? '<span class="badge badge-green" style="font-size:0.65rem;">已回复</span>' : '<span class="badge badge-orange" style="font-size:0.65rem;">待回复</span>'}
                  </div>
                  <div class="truncate text-sm" style="margin-top:4px;color:var(--text-secondary);">
                    ${Utils.esc(c.content)}
                  </div>
                </div>
                <button class="btn btn-sm ${c.reply ? 'btn-secondary' : 'btn-primary'}"
                        onclick="App.navigate('comments')"
                        style="margin-left:8px;flex-shrink:0;">
                  ${c.reply ? '查看' : '去回复'}
                </button>
              </div>
            `).join('')
          }
        </div>
      </div>
    `;
  },

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