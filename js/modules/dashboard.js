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

    const activeGoals = Extras.getGoals().filter(g => !g.done).length;

    const todayDiary = Diary.getEntry(today);
    const todayStudyMin = Study.getDurationByDate(today);
    const todayTasks = Study.getTodayTasks();
    const doneTasks = todayTasks.filter(t => t.done).length;

    /* 今日概览 */
    container.innerHTML = `
      <div class="mb-16">
        <div style="font-size:0.9rem;color:var(--text-secondary);margin-bottom:8px;">
          ${new Date().toLocaleDateString('zh-CN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
        </div>
        <div class="card-grid card-grid-2">
          <div class="card stat-card">
            <div class="stat-value">${diaryCount}</div>
            <div class="stat-label">日记总数</div>
          </div>
          <div class="card stat-card">
            <div class="stat-value">${activeGoals}</div>
            <div class="stat-label">进行中目标</div>
          </div>
        </div>
      </div>

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
  }
};