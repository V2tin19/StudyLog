/* ============================================
   Public Site - 公开只读页
   四个板块：日记 / 学习 / 日程 / 目标
   页面上没有任何编辑入口，写权限全在服务端。
   ============================================ */

(function () {
  'use strict';

  var API = '/api/diary';
  var DOC_API = '/api/doc';
  var PAGE_SIZE = 30;
  var THEME_KEY = 'studylog_public_theme';

  var DAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  var WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];   /* 展示顺序按周一开头，跟中文习惯一致 */
  var TABS = ['diary', 'study', 'schedule', 'goals'];

  /* 心情标签 → 显示名 + 颜色（颜色值取自 style.css 的 accent 变量） */
  var MOODS = {
    happy:     { label: '开心', color: '#d4a76a' },
    excited:   { label: '兴奋', color: '#c99aa6' },
    fulfilled: { label: '充实', color: '#8cb8a0' },
    neutral:   { label: '平淡', color: '#7ba4c7' },
    tired:     { label: '疲惫', color: '#a08fc9' },
    anxious:   { label: '焦虑', color: '#c97a7a' },
    sad:       { label: '难过', color: '#7bb8b8' },
    irritated: { label: '烦躁', color: '#c97a7a' }
  };

  /* 日记分页状态 */
  var offset = 0;
  var total = 0;
  var loading = false;
  var firstLoad = true;

  /* 其他三类数据的状态 */
  var docs = null;
  var docLoaded = false;
  var docLoading = false;
  var activeTab = 'diary';

  /* ---------- 小工具 ---------- */

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function parseDate(str) {
    var p = String(str || '').split('-').map(Number);
    if (p.length < 3 || !p[0]) return new Date();
    return new Date(p[0], p[1] - 1, p[2]);
  }

  function dateLabel(str) {
    var d = parseDate(str);
    return d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
  }

  function weekdayLabel(str) {
    return DAY_NAMES[parseDate(str).getDay()] || '';
  }

  function shortDate(str) {
    if (!str) return '—';
    var d = parseDate(str);
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  function clampPct(v) {
    var n = Number(v);
    if (!isFinite(n)) n = 0;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  function fmtDuration(min) {
    var n = Number(min) || 0;
    var h = Math.floor(n / 60);
    var m = Math.round(n % 60);
    if (h > 0) return h + ' 小时' + (m > 0 ? ' ' + m + ' 分' : '');
    return m + ' 分钟';
  }

  function statHtml(value, label) {
    return '<div class="pub-stat"><div class="pub-stat-value">' + esc(value) + '</div>' +
      '<div class="pub-stat-label">' + esc(label) + '</div></div>';
  }

  function stateHtml(title, desc) {
    return '<div class="pub-state"><strong>' + esc(title) + '</strong>' +
      (desc ? esc(desc) : '') + '</div>';
  }

  /* =========================================================
     日记
     ========================================================= */

  function entryHtml(e) {
    var mood = MOODS[e.mood];
    var imgs = (e.images || []).filter(Boolean);

    var moodHtml = mood
      ? '<span class="pub-mood" style="color:' + mood.color + '">' + esc(mood.label) + '</span>'
      : '';
    var pinHtml = e.pinned ? '<span class="pub-pin">置顶</span>' : '';
    var contentHtml = e.content ? '<div class="pub-content">' + esc(e.content) + '</div>' : '';
    var reviewHtml = e.review
      ? '<div class="pub-review"><span class="pub-review-tag">复盘</span>' + esc(e.review) + '</div>'
      : '';
    var imagesHtml = imgs.length
      ? '<div class="pub-images">' + imgs.map(function (u) {
          return '<img src="' + esc(u) + '" alt="配图" loading="lazy" referrerpolicy="no-referrer">';
        }).join('') + '</div>'
      : '';

    return '<article class="pub-entry' + (e.pinned ? ' pinned' : '') + '">' +
      '<div class="pub-card">' +
        '<div class="pub-card-head">' +
          '<span class="pub-date">' + esc(dateLabel(e.date)) + '</span>' +
          '<span class="pub-weekday">' + esc(weekdayLabel(e.date)) + '</span>' +
          pinHtml + moodHtml +
        '</div>' +
        contentHtml + reviewHtml + imagesHtml +
      '</div>' +
    '</article>';
  }

  function renderStats(stats) {
    var hero = document.getElementById('pub-hero');
    if (!hero) return;
    if (!stats || !stats.total) { hero.innerHTML = ''; return; }

    hero.innerHTML =
      statHtml(stats.total, '累计记录') +
      statHtml(shortDate(stats.firstDate), '开始于') +
      statHtml(shortDate(stats.lastDate), '最近更新');
  }

  function updateMoreButton() {
    var wrap = document.getElementById('pub-more-wrap');
    if (!wrap) return;
    if (offset < total) wrap.classList.remove('hidden');
    else wrap.classList.add('hidden');
  }

  function showDiaryError(msg) {
    var tl = document.getElementById('pub-timeline');
    if (!tl) return;

    if (offset === 0) {
      var hero = document.getElementById('pub-hero');
      if (hero) hero.innerHTML = '';
      var more = document.getElementById('pub-more-wrap');
      if (more) more.classList.add('hidden');
      tl.innerHTML = stateHtml('没能读到记录', msg);
      return;
    }

    var tip = document.createElement('div');
    tip.className = 'pub-state';
    tip.textContent = '加载失败：' + msg;
    tl.appendChild(tip);
  }

  function loadDiary() {
    if (loading) return;
    loading = true;

    var btn = document.getElementById('pub-more');
    if (btn && !firstLoad) {
      btn.disabled = true;
      btn.textContent = '加载中…';
    }

    fetch(API + '?limit=' + PAGE_SIZE + '&offset=' + offset, { headers: { accept: 'application/json' } })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) throw new Error(data.error || ('请求失败（' + res.status + '）'));
          return data;
        });
      })
      .then(function (data) {
        var tl = document.getElementById('pub-timeline');
        var entries = data.entries || [];

        if (firstLoad) {
          tl.innerHTML = '';
          total = (data.stats && data.stats.total) || 0;
          renderStats(data.stats);
        }

        if (entries.length === 0 && offset === 0) {
          tl.innerHTML = stateHtml('还没有记录');
        } else if (entries.length) {
          tl.insertAdjacentHTML('beforeend', entries.map(entryHtml).join(''));
        }

        offset += entries.length;
        if (firstLoad && !total) total = offset;
        firstLoad = false;
        updateMoreButton();
      })
      .catch(function (err) { showDiaryError(err.message || String(err)); })
      .finally(function () {
        loading = false;
        if (btn) {
          btn.disabled = false;
          btn.textContent = '加载更早的记录';
        }
      });
  }

  /* =========================================================
     学习
     ========================================================= */

  function renderStudy(doc) {
    var hero = document.getElementById('study-hero');
    var body = document.getElementById('study-body');
    if (!hero || !body) return;

    var d = (doc && doc.data) || {};
    var sessions = Array.isArray(d.sessions) ? d.sessions : [];
    var books = Array.isArray(d.books) ? d.books : [];
    var skills = Array.isArray(d.skills) ? d.skills : [];
    var checkin = (d.checkin && typeof d.checkin === 'object') ? d.checkin : {};
    var checkinDays = Object.keys(checkin).filter(function (k) { return checkin[k]; }).length;

    if (!sessions.length && !books.length && !skills.length && !checkinDays) {
      hero.innerHTML = '';
      body.innerHTML = stateHtml('还没有学习记录');
      return;
    }

    var totalMin = sessions.reduce(function (s, x) { return s + (Number(x.duration) || 0); }, 0);
    hero.innerHTML =
      statHtml(fmtDuration(totalMin), '累计学习') +
      statHtml(sessions.length, '记录条数') +
      statHtml(checkinDays, '打卡天数');

    var html = '';

    var recent = sessions.slice()
      .sort(function (a, b) { return String(b.date || '').localeCompare(String(a.date || '')); })
      .slice(0, 8);

    if (recent.length) {
      html += '<div class="pub-section"><div class="pub-section-title">最近记录</div><div class="pub-list">';
      recent.forEach(function (s) {
        html += '<div class="pub-row">' +
          '<div class="pub-row-main">' +
            '<div class="pub-row-title">' + esc(s.subject || '未分类') + '</div>' +
            '<div class="pub-row-sub">' + esc(shortDate(s.date)) +
              (s.content ? ' · ' + esc(s.content) : '') + '</div>' +
          '</div>' +
          '<div class="pub-row-value">' + esc(fmtDuration(s.duration)) + '</div>' +
        '</div>';
      });
      html += '</div></div>';
    }

    var reading = books.filter(function (b) { return b.status !== 'done'; }).slice(0, 5);
    if (reading.length) {
      html += '<div class="pub-section"><div class="pub-section-title">在读</div><div class="pub-goals">';
      reading.forEach(function (b) {
        var p = clampPct(b.progress);
        html += '<div class="pub-goal">' +
          '<div class="pub-goal-head">' +
            '<span class="pub-goal-name">' + esc(b.title || '未命名') + '</span>' +
            '<span class="pub-goal-pct">' + p + '%</span>' +
          '</div>' +
          (b.author ? '<div class="pub-goal-note">' + esc(b.author) + '</div>' : '') +
          '<div class="pub-progress"><div class="pub-progress-bar" style="width:' + p + '%"></div></div>' +
        '</div>';
      });
      html += '</div></div>';
    }

    if (skills.length) {
      html += '<div class="pub-section"><div class="pub-section-title">技能</div><div class="pub-goals">';
      skills.slice(0, 6).forEach(function (s) {
        var p = clampPct(s.progress);
        html += '<div class="pub-goal">' +
          '<div class="pub-goal-head">' +
            '<span class="pub-goal-name">' + esc(s.name || '未命名') + '</span>' +
            '<span class="pub-goal-pct">' + p + '%</span>' +
          '</div>' +
          (s.note ? '<div class="pub-goal-note">' + esc(s.note) + '</div>' : '') +
          '<div class="pub-progress"><div class="pub-progress-bar" style="width:' + p + '%"></div></div>' +
        '</div>';
      });
      html += '</div></div>';
    }

    body.innerHTML = html;
  }

  /* =========================================================
     日程
     ========================================================= */

  function renderSchedule(doc) {
    var body = document.getElementById('schedule-body');
    if (!body) return;

    var d = (doc && doc.data) || {};
    var todayIdx = new Date().getDay();
    var html = '';
    var any = false;

    WEEK_ORDER.forEach(function (i) {
      var raw = d[i];
      var slots = Array.isArray(raw) ? raw.filter(function (s) {
        return s && (s.activity || s.time);
      }) : [];
      if (!slots.length) return;
      any = true;

      html += '<div class="pub-day">' +
        '<div class="pub-day-name' + (i === todayIdx ? ' today' : '') + '">' +
          esc(DAY_NAMES[i]) + (i === todayIdx ? ' · 今天' : '') +
        '</div>';
      slots.forEach(function (s) {
        html += '<div class="pub-slot-row">' +
          '<span class="pub-slot-time">' + esc(s.time || '') + '</span>' +
          '<span>' + esc(s.activity || '') + '</span>' +
        '</div>';
      });
      html += '</div>';
    });

    body.innerHTML = any ? html : stateHtml('还没有排日程');
  }

  /* =========================================================
     目标
     ========================================================= */

  function goalHtml(g) {
    var p = g.done ? 100 : clampPct(g.progress);
    var note = [];
    if (g.note) note.push(g.note);
    if (g.deadline) note.push('截止 ' + g.deadline);

    return '<div class="pub-goal' + (g.done ? ' done' : '') + '">' +
      '<div class="pub-goal-head">' +
        '<span class="pub-goal-name">' + esc(g.name || '未命名') + '</span>' +
        '<span class="pub-goal-pct">' + (g.done ? '已完成' : p + '%') + '</span>' +
      '</div>' +
      (note.length ? '<div class="pub-goal-note">' + esc(note.join(' · ')) + '</div>' : '') +
      '<div class="pub-progress"><div class="pub-progress-bar' + (g.done ? ' done' : '') +
        '" style="width:' + p + '%"></div></div>' +
    '</div>';
  }

  function renderGoals(doc) {
    var body = document.getElementById('goals-body');
    if (!body) return;

    var list = (doc && Array.isArray(doc.data)) ? doc.data : [];
    if (!list.length) {
      body.innerHTML = stateHtml('还没有目标');
      return;
    }

    var doing = list.filter(function (g) { return !g.done; });
    var done = list.filter(function (g) { return g.done; });
    var html = '';

    if (doing.length) {
      html += '<div class="pub-section"><div class="pub-section-title">进行中 · ' + doing.length +
        '</div><div class="pub-goals">' + doing.map(goalHtml).join('') + '</div></div>';
    }
    if (done.length) {
      html += '<div class="pub-section"><div class="pub-section-title">已完成 · ' + done.length +
        '</div><div class="pub-goals">' + done.map(goalHtml).join('') + '</div></div>';
    }

    body.innerHTML = html;
  }

  /* =========================================================
     其他三类数据的加载与切换
     ========================================================= */

  function paintDoc(tab) {
    if (!docs) return;
    if (tab === 'study') renderStudy(docs.study);
    else if (tab === 'schedule') renderSchedule(docs.schedule);
    else if (tab === 'goals') renderGoals(docs.goals);
  }

  function showDocLoading(tab) {
    var id = tab + '-body';
    var el = document.getElementById(id);
    /* 只在空白时占位，免得已经把内容画好了又被覆盖 */
    if (el && !el.innerHTML) el.innerHTML = '<div class="pub-state">正在读取…</div>';
  }

  function loadDocs() {
    if (docLoaded || docLoading) return;
    docLoading = true;

    fetch(DOC_API, { headers: { accept: 'application/json' } })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) throw new Error(data.error || ('请求失败（' + res.status + '）'));
          return data;
        });
      })
      .then(function (data) {
        docs = data.docs || {};
        docLoaded = true;
        paintDoc(activeTab);
      })
      .catch(function (err) {
        var msg = err.message || String(err);
        ['study-body', 'schedule-body', 'goals-body'].forEach(function (id) {
          var el = document.getElementById(id);
          if (el) el.innerHTML = stateHtml('没能读到数据', msg);
        });
      })
      .finally(function () { docLoading = false; });
  }

  function switchTab(tab) {
    if (TABS.indexOf(tab) === -1) tab = 'diary';
    activeTab = tab;

    TABS.forEach(function (t) {
      var panel = document.getElementById('pub-panel-' + t);
      if (panel) panel.classList.toggle('hidden', t !== tab);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.pub-tab'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === tab);
    });

    if (tab !== 'diary') {
      /* 命中缓存也要重画 —— 面板是切一次画一次，
         少了 paintDoc 这条分支，第二个被点开的板块会是空白。 */
      if (docLoaded) paintDoc(tab);
      else { showDocLoading(tab); loadDocs(); }
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* =========================================================
     主题
     ========================================================= */

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#1a1a1e' : '#f5f0eb');
  }

  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (e) { /* 隐私模式忽略 */ }

    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(saved || (prefersDark ? 'dark' : 'light'));

    var toggle = document.getElementById('theme-toggle');
    if (toggle) {
      toggle.addEventListener('click', function () {
        var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        applyTheme(next);
        try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* 忽略 */ }
      });
    }
  }

  /* =========================================================
     启动
     ========================================================= */

  document.addEventListener('DOMContentLoaded', function () {
    initTheme();

    var tabs = document.getElementById('pub-tabs');
    if (tabs) {
      tabs.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('.pub-tab') : null;
        if (btn) switchTab(btn.getAttribute('data-tab'));
      });
    }

    var tl = document.getElementById('pub-timeline');
    if (tl) tl.innerHTML = '<div class="pub-state">正在读取…</div>';

    var more = document.getElementById('pub-more');
    if (more) more.addEventListener('click', loadDiary);

    loadDiary();
  });
})();
