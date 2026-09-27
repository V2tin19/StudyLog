/* ============================================
   Dashboard - 数据仪表盘 / 总览模块
   全站数据聚合、统计图表、快捷入口
   ============================================ */

const Dashboard = {
  render(container) {
    const today = Utils.today();

    /* 核心统计数据 */
    const diaryDates = Diary.getActiveDates();
    const diaryCount = diaryDates.length;

    const checkinDates = Study.getCheckinDates();
    const checkinCount = checkinDates.length;
    const streak = Study.getStreak();

    const studySessions = Study.getSessions();
    const totalStudyMinutes = Study.getTotalDuration(studySessions);
    const todayStudyMin = Study.getDurationByDate(today);

    const activeGoals = Extras.getGoals().filter(g => !g.done).length;

    const todayDiary = Diary.getEntry(today);
    const todayTasks = Study.getTodayTasks();
    const doneTasks = todayTasks.filter(t => t.done).length;

    /* 今日概览 */
    container.innerHTML = `
      <div class="mb-16">
        <div style="font-size:0.9rem;color:var(--text-secondary);margin-bottom:8px;">
          ${new Date().toLocaleDateString('zh-CN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
        </div>
        <div class="card-grid card-grid-4">
          <div class="card stat-card">
            <div class="stat-value">${diaryCount}</div>
            <div class="stat-label">日记总数</div>
          </div>
          <div class="card stat-card">
            <div class="stat-value">${Study.formatDuration(totalStudyMinutes).replace('分钟','')}</div>
            <div class="stat-label">累计学习</div>
          </div>
          <div class="card stat-card">
            <div class="stat-value">${checkinCount}</div>
            <div class="stat-label">打卡天数</div>
          </div>
          <div class="card stat-card">
            <div class="stat-value">${activeGoals}</div>
            <div class="stat-label">进行中目标</div>
          </div>
        </div>
      </div>

      <div class="card-grid card-grid-2 mb-16">
        <div class="card">
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
          </div>
        </div>
        <div class="card">
          <div class="card-title"><span>打卡连续 ${streak.current} 天</span></div>
          <div class="text-center">
            <div class="stat-value" style="font-size:2.5rem;">${streak.current}</div>
            <div class="text-sm text-muted">最长连续 ${streak.max} 天</div>
          </div>
        </div>
      </div>

      <div class="card-grid card-grid-2 mb-16">
        <div class="card">
          <div class="card-title"><span>学习趋势（近7天）</span></div>
          <div id="dashboard-study-chart"></div>
        </div>
        <div class="card">
          <div class="card-title"><span>情绪曲线（近30天）</span></div>
          <div id="dashboard-mood-chart"></div>
        </div>
      </div>

      <div class="card mb-16">
        <div class="card-title"><span>快捷入口</span></div>
        <div class="flex gap-12" style="flex-wrap:wrap;">
          <button class="btn btn-secondary" onclick="Diary.showSearch()">搜索日记</button>
          <button class="btn btn-secondary" onclick="Study.showAddSession()">记录学习</button>
          <button class="btn btn-secondary" onclick="App.navigate('settings')">设置</button>
        </div>
      </div>
    `;

    /* 绘制图表 */
    this.renderCharts();
  },

  renderCharts() {
    /* 学习趋势 */
    const studyData = Study.getStudyChartData(7);
    Utils.drawBar(document.getElementById('dashboard-study-chart'), studyData.map(d => ({
      label: d.label.slice(-2),
      value: d.value
    })), { height: 140, barWidth: 24, color: 'var(--accent-blue)' });

    /* 情绪曲线 */
    const moodData = Diary.getMoodChartData();
    if (moodData.length > 1) {
      Utils.drawLine(document.getElementById('dashboard-mood-chart'), moodData, {
        height: 140, width: 300, color: 'var(--accent-pink)'
      });
    } else {
      document.getElementById('dashboard-mood-chart').innerHTML = '<div class="empty-state-text">数据不足，记录更多日记吧</div>';
    }
  }
};