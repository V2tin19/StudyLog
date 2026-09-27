/* ============================================
   Settings - 设置模块
   主题切换、数据备份、基础配置、关于本站
   ============================================ */

const Settings = {
  CONFIG_KEY: 'app_config',

  init() {
    const config = this.getConfig();
    document.documentElement.setAttribute('data-theme', config.theme || 'light');
  },

  getConfig() {
    return Store.get(this.CONFIG_KEY, {
      theme: 'light',
      fontSize: 'medium',
      accentColor: 'blue'
    });
  },

  updateConfig(data) {
    const config = { ...this.getConfig(), ...data };
    Store.set(this.CONFIG_KEY, config);
    if (data.theme) document.documentElement.setAttribute('data-theme', config.theme);
    return config;
  },

  /* ---- 数据管理 ---- */
  exportData() {
    const data = Store.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `daily_tracker_backup_${Utils.today()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  },

  importData(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = function(e) {
        try {
          const data = JSON.parse(e.target.result);
          Store.importAll(data);
          resolve(true);
        } catch (err) {
          reject('文件格式错误');
        }
      };
      reader.onerror = () => reject('读取文件失败');
      reader.readAsText(file);
    });
  },

  async clearAllData() {
    if (await Utils.confirm('确定清除所有数据？此操作不可恢复！')) {
      if (await Utils.confirm('再次确认：清除所有本地数据？')) {
        Store.clearAll();
        location.reload();
      }
    }
  },

  /* ---- 渲染 ---- */
  render(container) {
    const config = this.getConfig();
    const storageSize = this.getStorageSize();
    const diaryCount = Diary.getActiveDates().length;
    const studyCount = Study.getSessions().length;
    const goalCount = Extras.getGoals().filter(g => !g.done).length;

    container.innerHTML = `
      <div class="card-grid card-grid-2 mb-16">
        <div class="card">
          <div class="card-title"><span>主题设置</span></div>
          <div class="form-group">
            <label class="form-label">外观主题</label>
            <div class="flex gap-8">
              <button class="btn ${config.theme === 'light' ? 'btn-primary' : 'btn-secondary'}" onclick="Settings.setTheme('light')">浅色</button>
              <button class="btn ${config.theme === 'dark' ? 'btn-primary' : 'btn-secondary'}" onclick="Settings.setTheme('dark')">深色</button>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-title"><span>数据管理</span></div>
          <div class="flex gap-8" style="flex-wrap:wrap;">
            <button class="btn btn-primary" onclick="Settings.exportData()">导出备份</button>
            <label class="btn btn-secondary" style="cursor:pointer;">
              导入备份
              <input type="file" accept=".json" style="display:none;" onchange="Settings.handleImport(this)">
            </label>
            <button class="btn btn-danger" onclick="Settings.clearAllData()">清除所有数据</button>
          </div>
        </div>
      </div>
      <div class="card mb-16">
        <div class="card-title"><span>云端同步</span></div>
        <div class="text-sm text-muted" style="line-height:1.8;margin-bottom:12px;">
          把本地写的日记发布到你自己的网站上，朋友通过公开页就能看到。<br>
          写入权限由服务器校验令牌，别人没有令牌就改不了你的内容。
        </div>
        <div class="form-group">
          <label class="form-label">管理令牌</label>
          <input class="input" id="cloud-token" type="password" autocomplete="off"
                 placeholder="粘贴你在 Cloudflare 配置的 ADMIN_TOKEN">
          <div class="text-sm text-muted mt-8">令牌只保存在本机浏览器，不会随页面发送给其他人。</div>
        </div>
        <div class="flex gap-8" style="flex-wrap:wrap;">
          <button class="btn btn-secondary" id="cloud-btn-save" onclick="Cloud.handleSaveToken()">保存令牌</button>
          <button class="btn btn-secondary" id="cloud-btn-verify" onclick="Cloud.handleVerify()">测试连接</button>
          <button class="btn btn-primary" id="cloud-btn-publish" onclick="Cloud.handlePublish()">发布到云端</button>
          <a class="btn btn-secondary" href="view.html" target="_blank" rel="noopener">查看公开页</a>
        </div>
        <div id="cloud-status" class="text-sm mt-8"></div>
      </div>
      <div class="card mb-16">
        <div class="card-title"><span>数据统计</span></div>
        <div class="card-grid card-grid-3">
          <div class="stat-card"><div class="stat-value">${diaryCount}</div><div class="stat-label">日记</div></div>
          <div class="stat-card"><div class="stat-value">${studyCount}</div><div class="stat-label">学习记录</div></div>
          <div class="stat-card"><div class="stat-value">${goalCount}</div><div class="stat-label">进行中目标</div></div>
        </div>
        <div class="text-sm text-muted mt-8">本地存储占用：${storageSize}</div>
      </div>
      <div class="card">
        <div class="card-title"><span>关于本站</span></div>
        <div class="text-sm" style="line-height:1.8;">
          <p><strong>StudyLog</strong> · 个人日常记录 v1.0</p>
          <p>一款轻量化个人日常记录 Web 网站</p>
          <p>专注服务个人记录、生活留存、数据复盘</p>
          <p class="mt-8">平时写作完全在本地浏览器，不联网也能用</p>
          <p>只有你主动点「发布到云端」时，日记才会同步到你自己的站点</p>
          <p>公开页是只读的，别人无法修改你的内容</p>
          <p>纯前端静态页面，可离线使用</p>
        </div>
      </div>
    `;

    /* 令牌回填（不走模板，避免特殊字符被转义破坏） */
    const tokenInput = document.getElementById('cloud-token');
    if (tokenInput) tokenInput.value = Cloud.getToken();
  },

  setTheme(theme) {
    this.updateConfig({ theme });
    Utils.$$('[data-page="settings"]').forEach(el => {
      if (el.classList.contains('nav-item') || el.classList.contains('bottom-nav-item')) {
        /* do nothing */
      }
    });
    App.refresh();
  },

  getStorageSize() {
    let total = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('daily_tracker_')) {
        total += localStorage.getItem(k).length * 2;
      }
    }
    if (total < 1024) return total + ' B';
    if (total < 1024 * 1024) return (total / 1024).toFixed(1) + ' KB';
    return (total / 1024 / 1024).toFixed(1) + ' MB';
  },

  handleImport(input) {
    if (input.files && input.files[0]) {
      this.importData(input.files[0]).then(() => {
        alert('导入成功！页面将刷新。');
        location.reload();
      }).catch(err => {
        alert('导入失败：' + err);
      });
    }
    input.value = '';
  }
};