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
  var lastBatch = 0;      /* 上一批实际拿到几条 —— 用来判断还有没有更早的 */
  var loading = false;
  var firstLoad = true;

  /* 日记筛选（年份 / 月份，走服务端的 year / month 参数） */
  var filterYear = '';
  var filterMonth = '';
  var latestYear = 0;     /* 只选了月份没选年份时，用它补上（接口的 month 必须配 year 才生效） */

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

  /* "08:30" → 510（分钟）。用来排序和判断「接下来」。格式不对返回 null */
  function mins(t) {
    var m = String(t || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
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

  /* 名单型的一行（在读的书、在学的技能）。
     badge 传了就显示一个胶囊标签（已读 / 已掌握），圆点同时变绿 —— 扫一眼就分得出完成与否。 */
  function plainRow(title, sub, badge) {
    var done = !!badge;
    return '<div class="pub-row pub-row-dot' + (done ? ' done' : '') + '">' +
      '<div class="pub-row-main">' +
        '<div class="pub-row-title">' + esc(title || '未命名') + '</div>' +
        (sub ? '<div class="pub-row-sub">' + esc(sub) + '</div>' : '') +
      '</div>' +
      (done ? '<span class="pub-row-badge">' + esc(badge) + '</span>' : '') +
    '</div>';
  }

  /* 推进记录的日期标签：今年只写 9/20，跨年补两位年份 25/12/24 */
  function logDate(str) {
    if (!str) return '';
    var d = parseDate(str);
    var prefix = (d.getFullYear() === new Date().getFullYear())
      ? '' : String(d.getFullYear()).slice(2) + '/';
    return prefix + (d.getMonth() + 1) + '/' + d.getDate();
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

  function updateMoreButton() {
    var wrap = document.getElementById('pub-more-wrap');
    if (!wrap) return;
    /* 上一批装满了一页 → 可能还有更早的；不满 → 到底了。
       用这个判断而不是比对总数，是因为筛选后的总数接口不返回。 */
    if (lastBatch >= PAGE_SIZE) wrap.classList.remove('hidden');
    else wrap.classList.add('hidden');
  }

  /* ---------- 日记筛选条（年份 / 月份） ---------- */

  function buildFilter(stats) {
    var box = document.getElementById('pub-filter');
    if (!box) return;

    var firstY = (stats && stats.firstDate) ? Number(String(stats.firstDate).slice(0, 4)) : 0;
    var lastY = (stats && stats.lastDate) ? Number(String(stats.lastDate).slice(0, 4)) : 0;
    if (lastY) latestYear = lastY;

    var years = [];
    if (firstY && lastY) {
      for (var y = lastY; y >= firstY; y--) years.push(y);
    }

    var html = '';

    /* 只有一年的时候不摆年份下拉 —— 一个选项的下拉是纯噪音 */
    if (years.length > 1) {
      html += '<select class="pub-select" id="pub-filter-year" aria-label="按年份筛选">' +
        '<option value="">全部年份</option>' +
        years.map(function (y) {
          return '<option value="' + y + '"' + (String(y) === filterYear ? ' selected' : '') + '>' +
            y + ' 年</option>';
        }).join('') + '</select>';
    }

    html += '<select class="pub-select" id="pub-filter-month" aria-label="按月份筛选">' +
      '<option value="">全部月份</option>';
    for (var m = 1; m <= 12; m++) {
      html += '<option value="' + m + '"' + (String(m) === filterMonth ? ' selected' : '') + '>' +
        m + ' 月</option>';
    }
    html += '</select>';

    if (filterYear || filterMonth) {
      html += '<button class="pub-filter-clear" id="pub-filter-clear" type="button">清除</button>';
    }

    box.innerHTML = html;
    box.classList.remove('hidden');
    box.classList.toggle('filtering', !!(filterYear || filterMonth));
  }

  /* 改了筛选条件：清空列表重新从第一页拉 */
  function resetAndReload() {
    offset = 0;
    lastBatch = 0;
    firstLoad = true;
    var tl = document.getElementById('pub-timeline');
    if (tl) tl.innerHTML = '<div class="pub-state">正在读取…</div>';
    var more = document.getElementById('pub-more-wrap');
    if (more) more.classList.add('hidden');
    loadDiary();
  }

  function onFilterChange(e) {
    var t = e.target;
    if (!t || !t.id) return;

    if (t.id === 'pub-filter-year') {
      filterYear = t.value;
    } else if (t.id === 'pub-filter-month') {
      filterMonth = t.value;
      /* 接口的 month 必须带 year 才生效。只挑了月份时，自动补上最近那一年，
         并且重建筛选条把年份也显示出来，免得界面和实际查询对不上。 */
      if (filterMonth && !filterYear && latestYear) filterYear = String(latestYear);
    } else {
      return;
    }
    resetAndReload();
  }

  function onFilterClick(e) {
    if (e.target && e.target.id === 'pub-filter-clear') {
      filterYear = '';
      filterMonth = '';
      resetAndReload();
    }
  }

  function diaryUrl() {
    var url = API + '?limit=' + PAGE_SIZE + '&offset=' + offset;
    if (filterYear) url += '&year=' + encodeURIComponent(filterYear);
    if (filterMonth) url += '&month=' + encodeURIComponent(filterMonth);
    return url;
  }

  function loadDiary() {
    if (loading) return;
    loading = true;

    var btn = document.getElementById('pub-more');
    if (btn && !firstLoad) {
      btn.disabled = true;
      btn.textContent = '加载中…';
    }

    fetch(diaryUrl(), { headers: { accept: 'application/json' } })
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
          renderStats(data.stats);
          buildFilter(data.stats);
        }

        var filtering = !!(filterYear || filterMonth);

        if (entries.length === 0 && offset === 0) {
          tl.innerHTML = filtering
            ? stateHtml('这个范围里没有记录')
            : stateHtml('还没有记录');
        } else if (entries.length) {
          tl.insertAdjacentHTML('beforeend', entries.map(entryHtml).join(''));
        }

        offset += entries.length;
        lastBatch = entries.length;
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

    /* 在读 / 已读 —— 字段是 title / notes（没有 author）。
       进度条整体去掉：书籍数据里根本没有 progress 这个字段，
       之前那根永远是 0% 的空条，纯属噪音。
       已读的也要露出来 —— 这是「读完了什么」的存证，不显示等于白记。 */
    var reading = books.filter(function (b) { return b.status !== 'done'; });
    var finished = books.filter(function (b) { return b.status === 'done'; });

    if (reading.length) {
      html += '<div class="pub-section"><div class="pub-section-title">在读</div><div class="pub-list">' +
        reading.map(function (b) { return plainRow(b.title, b.notes, ''); }).join('') +
        '</div></div>';
    }
    if (finished.length) {
      html += '<div class="pub-section"><div class="pub-section-title">已读</div><div class="pub-list">' +
        finished.map(function (b) { return plainRow(b.title, b.notes, '已读'); }).join('') +
        '</div></div>';
    }

    /* 技能 —— 字段是 name / notes（之前错写成 note，备注一直读不出来） */
    var learning = skills.filter(function (s) { return s.status !== 'done'; });
    var mastered = skills.filter(function (s) { return s.status === 'done'; });

    if (learning.length) {
      html += '<div class="pub-section"><div class="pub-section-title">在学</div><div class="pub-list">' +
        learning.map(function (s) { return plainRow(s.name, s.notes, ''); }).join('') +
        '</div></div>';
    }
    if (mastered.length) {
      html += '<div class="pub-section"><div class="pub-section-title">已掌握</div><div class="pub-list">' +
        mastered.map(function (s) { return plainRow(s.name, s.notes, '已掌握'); }).join('') +
        '</div></div>';
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
    var now = new Date();
    var todayIdx = now.getDay();
    var nowMin = now.getHours() * 60 + now.getMinutes();
    var html = '';
    var any = false;

    WEEK_ORDER.forEach(function (i) {
      var raw = d[i];
      var slots = Array.isArray(raw) ? raw.filter(function (s) {
        return s && (s.activity || s.time);
      }) : [];
      if (!slots.length) return;
      any = true;

      /* 按时间排。没填时间的排最后（mins 返回 null） */
      slots = slots.slice().sort(function (a, b) {
        var ta = mins(a.time);
        var tb = mins(b.time);
        if (ta === tb) return 0;
        if (ta === null) return 1;
        if (tb === null) return -1;
        return ta - tb;
      });

      var isToday = (i === todayIdx);

      /* 今天：第一个还没到的时段标「接下来」。
         不去猜哪个时段"正在进行" —— 数据里没有时长，猜就是编。 */
      var nextIdx = -1;
      if (isToday) {
        for (var k = 0; k < slots.length; k++) {
          var t = mins(slots[k].time);
          if (t !== null && t > nowMin) { nextIdx = k; break; }
        }
      }

      html += '<div class="pub-day' + (isToday ? ' today' : '') + '">' +
        '<div class="pub-day-head">' +
          '<span class="pub-day-name">' + esc(DAY_NAMES[i]) + '</span>' +
          (isToday ? '<span class="pub-day-badge">今天</span>' : '') +
          '<span class="pub-day-count">' + slots.length + ' 项</span>' +
        '</div>' +
        '<div class="pub-slots">';

      slots.forEach(function (s, k) {
        var isNext = (k === nextIdx);
        html += '<div class="pub-slot' + (isNext ? ' next' : '') + '">' +
          '<span class="pub-slot-time">' + esc(s.time || '') + '</span>' +
          '<span class="pub-rail"><i></i></span>' +
          '<span class="pub-slot-text">' + esc(s.activity || '') +
            (isNext ? '<span class="pub-slot-tag">接下来</span>' : '') +
          '</span>' +
        '</div>';
      });

      html += '</div></div>';
    });

    body.innerHTML = any ? html : stateHtml('还没有排日程');
  }

  /* =========================================================
     目标
     ========================================================= */

  function goalHtml(g) {
    var note = [];
    if (g.note) note.push(g.note);
    if (g.deadline) note.push('截止 ' + g.deadline);

    /* 目标的字段名是 title，不是 name —— 之前读错字段，页面上全是「未命名」。
       进度条一并去掉：目标现在就只有「名字 + 备注 + 完成标记 + 推进记录」。 */
    var logs = Array.isArray(g.logs) ? g.logs.slice().reverse() : [];   /* 最新的排上面 */
    var hasLogs = logs.length > 0;

    var logsHtml = hasLogs
      ? '<div class="pub-logs">' + logs.map(function (l) {
          return '<div class="pub-log">' +
            '<span class="pub-log-date">' + esc(logDate(l.date)) + '</span>' +
            '<span class="pub-rail"><i></i></span>' +
            '<span class="pub-log-text">' + esc(l.content || '') + '</span>' +
          '</div>';
        }).join('') + '</div>'
      : '';

    /* 有记录的才可展开 —— 没记录的点了也没反应，别给人一个假按钮 */
    var headAttrs = hasLogs ? ' role="button" tabindex="0" aria-expanded="false"' : '';

    return '<div class="pub-goal' + (g.done ? ' done' : '') + (hasLogs ? ' has-logs' : '') + '">' +
      '<div class="pub-goal-head"' + headAttrs + '>' +
        '<span class="pub-goal-mark' + (g.done ? ' done' : '') + '">' + (g.done ? '✓' : '') + '</span>' +
        '<div class="pub-goal-main">' +
          '<div class="pub-goal-name">' + esc(g.title || '未命名') + '</div>' +
          (note.length ? '<div class="pub-goal-note">' + esc(note.join(' · ')) + '</div>' : '') +
        '</div>' +
        (hasLogs
          ? '<span class="pub-goal-meta">' + logs.length + ' 条跟进</span>' +
            '<span class="pub-goal-caret" aria-hidden="true">›</span>'
          : '') +
      '</div>' +
      logsHtml +
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
     目标卡片：展开 / 收起推进记录
     ========================================================= */

  function toggleGoalCard(head) {
    var card = head && head.parentNode;
    if (!card || !card.classList || !card.classList.contains('has-logs')) return;
    var open = card.classList.toggle('open');
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function onGoalAreaClick(e) {
    var head = (e.target && e.target.closest) ? e.target.closest('.pub-goal-head') : null;
    if (head) toggleGoalCard(head);
  }

  /* 键盘也能开合（head 上有 tabindex，回车/空格应该跟点击一个效果） */
  function onGoalAreaKey(e) {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    var head = (e.target && e.target.closest) ? e.target.closest('.pub-goal-head') : null;
    if (!head || !head.parentNode.classList.contains('has-logs')) return;
    e.preventDefault();
    toggleGoalCard(head);
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

    /* 筛选条每次都整块重建，所以监听挂在容器上（委托），不跟着重建丢 */
    var filter = document.getElementById('pub-filter');
    if (filter) {
      filter.addEventListener('change', onFilterChange);
      filter.addEventListener('click', onFilterClick);
    }

    /* 目标卡同理：卡片是渲染出来的，事件挂在容器上 */
    var goalsBody = document.getElementById('goals-body');
    if (goalsBody) {
      goalsBody.addEventListener('click', onGoalAreaClick);
      goalsBody.addEventListener('keydown', onGoalAreaKey);
    }

    loadDiary();
  });
})();
