/* ============================================
   Public Site - 公开页
   五个板块：日记 / 阅读 / 日程 / 目标 / 留言
   访客能留言、能荐书、能荐目标；改站主内容的写权限全在服务端。
   ============================================ */

(function () {
  'use strict';

  var API = '/api/diary';
  var DOC_API = '/api/doc';
  var PAGE_SIZE = 15;   /* 跟写作台时间线一致 */
  var THEME_KEY = 'studylog_public_theme';

  var DAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  var WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];   /* 展示顺序按周一开头，跟中文习惯一致 */
  var TABS = ['diary', 'study', 'schedule', 'goals', 'board'];

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

  /* 日记翻页状态。跟写作台时间线同一套：上一页 / n / 下一页，不做无限滚动。
     分母得从服务端要（/api/diary 返回的 total，是**当前筛选条件下**的条数）——
     只靠「上一批装满一页」判断的话，摆不出「3 / 12」这种页码。 */
  var page = 1;
  var totalPages = 1;
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

  /* 一组跟进记录（点状时间轴）。传进来的数组要按显示顺序排好，最新的在上面 */
  function logsHtml(logs) {
    if (!logs || !logs.length) return '';
    return '<div class="pub-logs">' + logs.map(function (l) {
      return '<div class="pub-log">' +
        '<span class="pub-log-date">' + esc(logDate(l.date)) + '</span>' +
        '<span class="pub-rail"><i></i></span>' +
        '<span class="pub-log-text">' + esc(l.content || '') + '</span>' +
      '</div>';
    }).join('') + '</div>';
  }

  /* 名单型的一行（在读的书、技能、最近的学习记录）。
     opts: { title, sub, value, badge, done, dot, logs, tag }
     badge 传了就显示一个胶囊标签（已读 / 已掌握），圆点同时变绿 —— 扫一眼就分得出完成与否；
     done 只上「完成」的样式、不挂胶囊，给已经整体收进「已读」折叠的行用（那里再挂一次纯属噪音）；
     tag 是「谁推荐的」小标签，只有荐读 / 目标推荐进来的条目才有；
     logs 非空则整行可展开，点标题行看跟进记录（跟目标卡同一套交互）。 */
  function plainRow(opts) {
    var o = opts || {};
    var logs = Array.isArray(o.logs) ? o.logs.slice().reverse() : [];
    var hasLogs = logs.length > 0;
    var done = !!(o.badge || o.done);

    return '<div class="pub-row' +
        (o.dot ? ' pub-row-dot' : '') +
        (done ? ' done' : '') +
        (hasLogs ? ' has-logs' : '') + '">' +
      '<div class="pub-row-head"' +
        (hasLogs ? ' role="button" tabindex="0" aria-expanded="false"' : '') + '>' +
        '<div class="pub-row-main">' +
          '<div class="pub-row-title">' + esc(o.title || '未命名') +
            (o.tag ? '<span class="from-tag">' + esc(o.tag) + '</span>' : '') +
          '</div>' +
          (o.sub ? '<div class="pub-row-sub">' + esc(o.sub) + '</div>' : '') +
        '</div>' +
        (o.value ? '<div class="pub-row-value">' + esc(o.value) + '</div>' : '') +
        (o.badge ? '<span class="pub-row-badge">' + esc(o.badge) + '</span>' : '') +
        (hasLogs ? '<span class="pub-row-meta">' + logs.length + ' 条跟进</span>' : '') +
        (hasLogs ? '<span class="pub-row-caret" aria-hidden="true">›</span>' : '') +
      '</div>' +
      (hasLogs ? logsHtml(logs) : '') +
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
        commentsBoxHtml(e.date) +
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
    tl.innerHTML = stateHtml('没能读到记录', msg);
  }

  function renderPager() {
    var box = document.getElementById('pub-pagination');
    if (!box) return;
    if (totalPages <= 1) { box.innerHTML = ''; return; }

    box.innerHTML =
      '<div class="pub-pager">' +
        '<button class="pub-page-btn" data-goto="' + (page - 1) + '"' +
          (page <= 1 ? ' disabled' : '') + '>上一页</button>' +
        '<span class="pub-page-info">' + page + ' / ' + totalPages + '</span>' +
        '<button class="pub-page-btn" data-goto="' + (page + 1) + '"' +
          (page >= totalPages ? ' disabled' : '') + '>下一页</button>' +
      '</div>';
  }

  function setPage(p) {
    if (!(p >= 1) || p > totalPages || p === page) return;
    page = p;
    var tl = document.getElementById('pub-timeline');
    if (tl) tl.innerHTML = '<div class="pub-state">正在读取…</div>';
    window.scrollTo({ top: 0, behavior: 'smooth' });
    loadDiary();
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

  /* 改了筛选条件：回到第一页重拉 */
  function resetAndReload() {
    page = 1;
    firstLoad = true;
    var tl = document.getElementById('pub-timeline');
    if (tl) tl.innerHTML = '<div class="pub-state">正在读取…</div>';
    var pag = document.getElementById('pub-pagination');
    if (pag) pag.innerHTML = '';
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
    var url = API + '?limit=' + PAGE_SIZE + '&offset=' + ((page - 1) * PAGE_SIZE);
    if (filterYear) url += '&year=' + encodeURIComponent(filterYear);
    if (filterMonth) url += '&month=' + encodeURIComponent(filterMonth);
    return url;
  }

  function loadDiary() {
    if (loading) return;
    loading = true;

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

        /* total 是当前筛选条件下的条数（不是 stats.total，那个永远是全部）。
           服务端万一没给，就退化成「只有这一页」，至少页码不会乱。 */
        var total = typeof data.total === 'number' ? data.total : entries.length;
        totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
        if (page > totalPages) page = totalPages;

        var filtering = !!(filterYear || filterMonth);

        if (firstLoad) {
          renderStats(data.stats);
          buildFilter(data.stats);
        }

        if (!entries.length) {
          tl.innerHTML = filtering
            ? stateHtml('这个范围里没有记录')
            : stateHtml('还没有记录');
        } else {
          tl.innerHTML = entries.map(entryHtml).join('');
          /* 留言条数是单独一路拉回来的（先渲染日记、后补数字）。
             翻页会整块重画，所以要把已经拿到的数字补回去。 */
          applyCommentCounts();
        }

        firstLoad = false;
        renderPager();
      })
      .catch(function (err) { showDiaryError(err.message || String(err)); })
      .finally(function () { loading = false; });
  }

  /* =========================================================
     阅读
     ========================================================= */

  /* 一本书一行。字段名对账：书是 title，备注叫 notes（没有 author 这个字段）。 */
  function bookRow(b, isDone) {
    return plainRow({
      title: b.title,
      sub: b.notes,
      dot: true,
      done: !!isDone,
      logs: b.logs,
      /* from 是书目荐读留下的印记：这本书是谁推荐的 */
      tag: b.from ? b.from + ' 推荐' : ''
    });
  }

  /* 在读的书排两列 —— 上下各占一整行太费纵向空间。
     只有一两本的时候就别硬分栏了，单列反而更齐。 */
  function bookCols(list) {
    if (list.length <= 1) {
      return '<div class="pub-list">' + list.map(function (b) { return bookRow(b, false); }).join('') + '</div>';
    }
    var half = Math.ceil(list.length / 2);
    return '<div class="pub-cols">' +
      '<div class="pub-list">' + list.slice(0, half).map(function (b) { return bookRow(b, false); }).join('') + '</div>' +
      '<div class="pub-list">' + list.slice(half).map(function (b) { return bookRow(b, false); }).join('') + '</div>' +
    '</div>';
  }

  function renderStudy(doc) {
    var body = document.getElementById('study-body');
    if (!body) return;

    var d = (doc && doc.data) || {};
    var sessions = Array.isArray(d.sessions) ? d.sessions : [];
    var books = Array.isArray(d.books) ? d.books : [];

    var reading = books.filter(function (b) { return b.status !== 'done'; });
    var read = books.filter(function (b) { return b.status === 'done'; });

    var html = '';

    if (!sessions.length && !books.length) {
      /* ⚠️ 这里不能直接 return —— 荐读区得照常出现。
         站主自己没记阅读数据，不代表访客就不能荐书。 */
      html += stateHtml('还没有记录');
    } else {
      /* 最近记录压在最上面，横跨整宽 */
      var recent = sessions.slice()
        .sort(function (a, b) { return String(b.date || '').localeCompare(String(a.date || '')); })
        .slice(0, 8);

      if (recent.length) {
        html += '<div class="pub-section"><div class="pub-section-title">最近记录</div><div class="pub-list">';
        recent.forEach(function (s) {
          html += plainRow({
            title: s.subject || '未分类',
            sub: shortDate(s.date) + (s.content ? ' · ' + s.content : ''),
            value: fmtDuration(s.duration)
          });
        });
        html += '</div></div>';
      }

      /* 在读的书：两列 */
      html += '<div class="pub-section"><div class="pub-section-title">在读 · ' + reading.length + '</div>' +
        (reading.length ? bookCols(reading) : '<div class="pub-col-empty">还没有</div>') +
      '</div>';

      /* 已读的书：整块收起来。书单会越攒越长，读完的那些不该把在读的挤到屏幕外。
         ⚠️ 注意这里跟 sessions 无关 —— 全读完了也要照常出现。 */
      if (read.length) {
        html += '<details class="pub-fold"><summary>已读 · ' + read.length + '</summary>' +
          '<div class="pub-fold-body"><div class="pub-list">' +
            read.map(function (b) { return bookRow(b, true); }).join('') +
          '</div></div>' +
        '</details>';
      }
    }

    /* 荐读区放在最后 —— 它是「访客参与」的部分，不属于站主自己的台账。
       内容由 renderSuggest 单独填（要走 /api/suggestions，跟 doc 不是一路）。 */
    html += '<div id="pub-suggest"></div>';

    body.innerHTML = html;
    renderSuggest();
    loadSuggest();
  }

  /* =========================================================
     推荐区（书目荐读 / 目标推荐）

     两处共用同一套零件：访客提交 → 站主在写作台审 → 通过了才上墙。
     差别只有文案、以及书多一个「作者」输入框。
     状态每个实例各一份，所以用一个小工厂 + 闭包，而不是把变量名
     拼成一堆 suggestXxx / gsuggestXxx —— 那样改一处必漏另一处。
     ========================================================= */

  function makeSuggester(cfg) {
    var items = null;      /* null = 还没拉到 */
    var blocked = false;   /* 表还没建：整块不出现，别给访客看坏掉的东西 */
    var inited = false;
    var loading = false;

    function msg(form, text, type) {
      var el = form.querySelector('.pub-sform-msg');
      if (!el) return;
      el.className = 'pub-sform-msg' + (type ? ' ' + type : '');
      el.textContent = text || '';
    }

    /* 说明文字压到只剩一句「通过后展示」—— 这站的字都很省。
       表单里本来就没有作者栏的（目标），加 pub-sform-solo 让标题框独占一行。 */
    function formHtml() {
      return '<form class="pub-sform' + (cfg.solo ? ' pub-sform-solo' : '') + '">' +
        '<div class="pub-sform-row">' +
          '<input class="input pub-suggest-title" name="title" maxlength="60" autocomplete="off" ' +
            'placeholder="' + esc(cfg.titlePh) + '">' +
          (cfg.solo ? '' :
            '<input class="input pub-suggest-author" name="author" maxlength="40" autocomplete="off" placeholder="作者（可不填）">') +
        '</div>' +
        '<textarea class="textarea pub-suggest-note" name="note" maxlength="200" ' +
          'placeholder="推荐理由（可不填）"></textarea>' +
        '<div class="pub-sform-row pub-sform-send">' +
          '<input class="input pub-input-name" name="name" maxlength="24" autocomplete="off" ' +
            'placeholder="昵称" value="' + esc(savedName()) + '">' +
          '<button class="btn btn-sm btn-primary" type="submit">推荐</button>' +
        '</div>' +
        /* 蜜罐：跟留言同一个手法。正常访客看不见，只有机器人会填。 */
        '<input class="hp-field" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">' +
        '<div class="pub-sform-msg"></div>' +
        '<div class="pub-cform-note">通过后展示</div>' +
      '</form>';
    }

    function rowHtml(it) {
      return '<div class="pub-suggest-item">' +
        '<div class="pub-comment-av">' + esc(nameInitial(it.name)) + '</div>' +
        '<div class="pub-suggest-main">' +
          '<div class="pub-suggest-book">' + esc(cfg.quote(it.title)) +
            (it.author ? '<span class="pub-suggest-author">' + esc(it.author) + '</span>' : '') +
          '</div>' +
          (it.note ? '<div class="pub-suggest-note">' + esc(it.note) + '</div>' : '') +
          '<div class="pub-comment-head"><span class="pub-comment-name">' +
            esc(it.name || '访客') + '</span> · ' + esc(shortTime(it.createdAt)) + '</div>' +
        '</div>' +
      '</div>';
    }

    /* 把容器整块画出来。切 tab 回来时是拿缓存重画的，不会再请求一次。 */
    function render() {
      var box = document.getElementById(cfg.boxId);
      if (!box) return;
      if (blocked) { box.innerHTML = ''; return; }

      var wall;
      if (items === null) {
        wall = '<div class="pub-state">正在读取…</div>';
      } else if (!items.length) {
        wall = '<div class="pub-col-empty">还没有</div>';
      } else {
        wall = '<div class="pub-suggest-list">' + items.map(rowHtml).join('') + '</div>';
      }

      box.innerHTML = '<div class="pub-section">' +
        '<div class="pub-section-title">' + esc(cfg.sectionTitle) + '</div>' +
        formHtml() + wall +
      '</div>';
    }

    function load() {
      if (inited || loading || blocked) return;
      loading = true;

      fetch(cfg.api + '?limit=100', { headers: { accept: 'application/json' } })
        .then(function (res) { return res.json().catch(function () { return {}; }); })
        .then(function (data) {
          /* 表没建时接口返回 200 + needTable，不报错 —— 页面本身是好的，
             只是不该给访客看一块空壳子，所以整块撤掉。 */
          if (data && data.needTable) blocked = true;
          else items = (data && data.items) || [];
          inited = true;
        })
        .catch(function () {
          /* 拉不到不影响看页面：把墙画成空的，表单还能用 */
          items = [];
          inited = true;
        })
        .finally(function () {
          loading = false;
          render();
        });
    }

    function send(form) {
      var titleEl = form.querySelector('.pub-suggest-title');
      var authorEl = form.querySelector('.pub-suggest-author');
      var noteEl = form.querySelector('.pub-suggest-note');
      var nameEl = form.querySelector('.pub-input-name');
      var hpEl = form.querySelector('.hp-field');
      var btn = form.querySelector('button[type="submit"]');

      var title = (titleEl.value || '').trim();
      if (!title) { msg(form, '还没写' + cfg.titlePh, 'err'); titleEl.focus(); return; }

      var name = (nameEl.value || '').trim();
      if (name) rememberName(name);

      btn.disabled = true;
      btn.textContent = '提交中…';
      msg(form, '', '');

      fetch(cfg.api, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: title,
          author: authorEl ? (authorEl.value || '').trim() : '',
          note: (noteEl.value || '').trim(),
          name: name,
          hp: hpEl ? hpEl.value : ''
        })
      })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (data) {
            if (!res.ok) throw new Error(data.error || ('请求失败（' + res.status + '）'));
            return data;
          });
        })
        .then(function () {
          titleEl.value = '';
          if (authorEl) authorEl.value = '';
          noteEl.value = '';
          /* 蜜罐命中时服务端不返回内容，静静收场，别给机器人反馈 */
          msg(form, '已提交', 'ok');
        })
        .catch(function (err) { msg(form, err.message || String(err), 'err'); })
        .finally(function () {
          btn.disabled = false;
          btn.textContent = '推荐';
        });
    }

    return { render: render, load: load, send: send };
  }

  var suggest = makeSuggester({
    api: '/api/suggestions',
    boxId: 'pub-suggest',
    sectionTitle: '书目荐读',
    titlePh: '书名',
    quote: function (t) { return '《' + t + '》'; }
  });

  var gsuggest = makeSuggester({
    api: '/api/goal-suggestions',
    boxId: 'pub-gsuggest',
    sectionTitle: '目标推荐',
    titlePh: '目标',
    solo: true,
    quote: function (t) { return '「' + t + '」'; }
  });

  function renderSuggest() { suggest.render(); }
  function loadSuggest() { suggest.load(); }
  function renderGSuggest() { gsuggest.render(); }
  function loadGSuggest() { gsuggest.load(); }

  /* 两个推荐区的提交都走委托：监听挂在容器上（容器本身不会被替换），
     跟留言是同一个套路。 */
  function bindSuggestForm(boxId, s) {
    var box = document.getElementById(boxId);
    if (!box) return;
    box.addEventListener('submit', function (e) {
      var f = e.target;
      if (!f || !f.classList || !f.classList.contains('pub-sform')) return;
      e.preventDefault();
      s.send(f);
    });
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
    var logsPart = hasLogs ? logsHtml(logs) : '';

    /* 有记录的才可展开 —— 没记录的点了也没反应，别给人一个假按钮 */
    var headAttrs = hasLogs ? ' role="button" tabindex="0" aria-expanded="false"' : '';

    return '<div class="pub-goal' + (g.done ? ' done' : '') + (hasLogs ? ' has-logs' : '') + '">' +
      '<div class="pub-goal-head"' + headAttrs + '>' +
        '<span class="pub-goal-mark' + (g.done ? ' done' : '') + '">' + (g.done ? '✓' : '') + '</span>' +
        '<div class="pub-goal-main">' +
          '<div class="pub-goal-name">' + esc(g.title || '未命名') +
            (g.from ? '<span class="from-tag">' + esc(g.from) + ' 推荐</span>' : '') +
          '</div>' +
          (note.length ? '<div class="pub-goal-note">' + esc(note.join(' · ')) + '</div>' : '') +
        '</div>' +
        (hasLogs
          ? '<span class="pub-goal-meta">' + logs.length + ' 条跟进</span>' +
            '<span class="pub-goal-caret" aria-hidden="true">›</span>'
          : '') +
      '</div>' +
      logsPart +
    '</div>';
  }

  /* 技能原来跟书籍并排在「阅读」页。阅读页现在只装书，技能挪到这儿 ——
     目标和技能都是「我要变成什么样」，书籍是「我读了什么」，这么分更顺。
     注意技能的数据并不在 doc.goals 里，它还在 doc.study，所以要从 docs.study 取。 */
  function skillRow(s) {
    return plainRow({
      title: s.name,
      sub: s.notes,
      badge: s.status === 'done' ? '已掌握' : '',
      dot: true,
      logs: s.logs
    });
  }

  function renderGoals(doc) {
    var body = document.getElementById('goals-body');
    if (!body) return;

    var list = (doc && Array.isArray(doc.data)) ? doc.data : [];
    var studyData = (docs && docs.study && docs.study.data) || {};
    var skills = Array.isArray(studyData.skills) ? studyData.skills : [];
    var html = '';

    if (!list.length && !skills.length) {
      html += stateHtml('还没有目标');
    } else {
      var doing = list.filter(function (g) { return !g.done; });
      var done = list.filter(function (g) { return g.done; });

      if (doing.length) {
        html += '<div class="pub-section"><div class="pub-section-title">进行中 · ' + doing.length +
          '</div><div class="pub-goals">' + doing.map(goalHtml).join('') + '</div></div>';
      }
      if (done.length) {
        html += '<div class="pub-section"><div class="pub-section-title">已完成 · ' + done.length +
          '</div><div class="pub-goals">' + done.map(goalHtml).join('') + '</div></div>';
      }
      if (skills.length) {
        html += '<div class="pub-section"><div class="pub-section-title">技能 · ' + skills.length +
          '</div><div class="pub-list">' + skills.map(skillRow).join('') + '</div></div>';
      }
    }

    /* 目标推荐区放在最后，跟阅读页的荐读区对称 */
    html += '<div id="pub-gsuggest"></div>';

    body.innerHTML = html;
    renderGSuggest();
    loadGSuggest();
  }

  /* =========================================================
     可展开的卡片：目标卡 + 有跟进记录的书 / 技能行
     两者结构一致（.has-logs 容器 > .xxx-head + .pub-logs），共用一套开关。
     ========================================================= */

  var HEAD_SEL = '.pub-goal-head, .pub-row-head';

  function toggleFold(head) {
    var card = head && head.parentNode;
    if (!card || !card.classList || !card.classList.contains('has-logs')) return;
    var open = card.classList.toggle('open');
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function onFoldClick(e) {
    var head = (e.target && e.target.closest) ? e.target.closest(HEAD_SEL) : null;
    if (head) toggleFold(head);
  }

  /* 键盘也能开合（head 上有 tabindex，回车/空格应该跟点击一个效果） */
  function onFoldKey(e) {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    var head = (e.target && e.target.closest) ? e.target.closest(HEAD_SEL) : null;
    if (!head || !head.parentNode.classList.contains('has-logs')) return;
    e.preventDefault();
    toggleFold(head);
  }

  /* =========================================================
     留言

     两处用同一套零件：日记卡底部（scope=diary + 日期）和留言簿（scope=board）。
     差别只有三处：外壳 class、排序方向、以及「日记下要按日期缓存」。
     ========================================================= */

  var COMMENT_API = '/api/comments';
  var NAME_KEY = 'studylog_comment_name';
  var BOARD_PAGE = 15;

  var commentCounts = {};     /* 日期 → 条数。公开页启动时一次查完 */
  var commentCache = {};      /* 日期 → 留言数组。点开过一次就不再请求 */
  var commentBlocked = false; /* 留言表还没建：整块隐藏，别给访客看坏掉的东西 */

  /* 留言簿分页状态 */
  var boardPage = 1;
  var boardTotalPages = 1;
  var boardTotal = 0;
  var boardLoading = false;
  var boardInited = false;

  function savedName() {
    try { return localStorage.getItem(NAME_KEY) || ''; } catch (e) { return ''; }
  }

  function rememberName(name) {
    try { localStorage.setItem(NAME_KEY, name); } catch (e) { /* 隐私模式忽略 */ }
  }

  /* 头像圈里就一个字 */
  function nameInitial(name) {
    var s = String(name || '').trim();
    return s ? s.slice(0, 1) : '访';
  }

  /* ISO 时间 → 9/27 21:10（今年的省掉年份） */
  function shortTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var now = new Date();
    var ymd = (d.getFullYear() === now.getFullYear() ? '' : String(d.getFullYear()).slice(2) + '/') +
      (d.getMonth() + 1) + '/' + d.getDate();
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    return ymd + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /* 一条留言。outerClass 分开日记（.pub-comment）和留言簿（.pub-board-item），
     内部那几个类两边共用。 */
  function commentHtml(c, outerClass) {
    var replyHtml = c.reply ? (
      '<div class="pub-comment-reply">' +
        '<div class="pub-reply-head">' +
          '<span class="pub-reply-badge">站主回复</span>' +
          (c.replyAt ? '<span class="pub-reply-time">' + esc(shortTime(c.replyAt)) + '</span>' : '') +
        '</div>' +
        '<div class="pub-reply-text">' + esc(c.reply) + '</div>' +
      '</div>'
    ) : '';

    return '<div class="' + (outerClass || 'pub-comment') + '">' +
      '<div class="pub-comment-av">' + esc(nameInitial(c.name)) + '</div>' +
      '<div class="pub-comment-main">' +
        '<div class="pub-comment-head"><span class="pub-comment-name">' +
          esc(c.name || '访客') + '</span> · ' + esc(shortTime(c.createdAt)) + '</div>' +
        '<div class="pub-comment-text">' + esc(c.content || '') + '</div>' +
        replyHtml +
      '</div>' +
    '</div>';
  }

  /* 发布表单。scope / target 挂在 form 的 data 属性上，提交时从 DOM 读回去 ——
     这样同一个函数能同时给「每一篇日记」和「留言簿」用，不用生成一堆唯一 id。 */
  function formHtml(scope, target) {
    return '<form class="pub-cform" data-scope="' + esc(scope) + '" data-target="' + esc(target) + '">' +
      '<div class="pub-cform-row">' +
        '<input class="input pub-input-name" name="name" maxlength="24" autocomplete="off" ' +
          'placeholder="昵称" value="' + esc(savedName()) + '">' +
        '<input class="input pub-input-text" name="content" maxlength="500" autocomplete="off" placeholder="说点什么…">' +
        '<button class="btn btn-sm btn-primary" type="submit">发送</button>' +
      '</div>' +
      '<input class="hp-field" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">' +
      '<div class="pub-cform-msg"></div>' +
      '<div class="pub-cform-note">留言会公开展示 · 一分钟最多 3 条 · 不能带链接</div>' +
    '</form>';
  }

  function setFormMsg(form, text, kind) {
    var el = form.querySelector('.pub-cform-msg');
    if (!el) return;
    el.className = 'pub-cform-msg' + (kind ? ' ' + kind : '');
    el.textContent = text || '';
  }

  /* 日记卡底部那条「n 条留言」 */
  function commentsBoxHtml(date) {
    if (commentBlocked) return '';    /* 表还没建：连这一行都不出现 */
    var n = commentCounts[date];
    var known = typeof n === 'number';
    /* -1 = 「还没问到条数」，等 counts 回来再补数字，别先显示 0 骗人 */
    return '<div class="pub-comments" data-date="' + esc(date) + '" data-count="' + (known ? n : -1) + '">' +
      '<button type="button" class="pub-comments-toggle">' +
        '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">' +
          '<path d="M2 3.5h12v8H7l-3.5 3v-3H2z"/></svg>' +
        '<span class="pub-comments-label">' + (known && n ? n + ' 条留言' : '留言') + '</span>' +
        '<span class="pub-caret" aria-hidden="true">›</span>' +
      '</button>' +
      '<div class="pub-comments-body"></div>' +
    '</div>';
  }

  function paintComments(body, date, list) {
    body.setAttribute('data-loaded', '1');
    body.innerHTML = (list.length
      ? list.map(function (c) { return commentHtml(c); }).join('')
      : '<div class="pub-comments-hint">还没有人留言，来说第一句</div>') +
      formHtml('diary', date);
  }

  function loadComments(date, body) {
    if (commentCache[date]) { paintComments(body, date, commentCache[date]); return; }

    body.innerHTML = '<div class="pub-comments-hint">正在读取…</div>';

    fetch(COMMENT_API + '?scope=diary&target=' + encodeURIComponent(date), { headers: { accept: 'application/json' } })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) throw new Error(data.error || ('请求失败（' + res.status + '）'));
          return data;
        });
      })
      .then(function (data) {
        var list = data.comments || [];
        commentCache[date] = list;
        paintComments(body, date, list);
      })
      .catch(function (err) {
        body.innerHTML = '<div class="pub-comments-hint">读取失败：' + esc(err.message || String(err)) + '</div>';
      });
  }

  function toggleComments(btn) {
    var box = btn.parentNode;
    if (!box || !box.classList) return;

    if (box.classList.toggle('open') === false) return;   /* 收起来了，不用读数据 */

    var body = box.querySelector('.pub-comments-body');
    if (!body || body.getAttribute('data-loaded') === '1') return;
    loadComments(box.getAttribute('data-date'), body);
  }

  function onCommentClick(e) {
    var btn = e.target && e.target.closest ? e.target.closest('.pub-comments-toggle') : null;
    if (btn) toggleComments(btn);
  }

  /* ---- 发一条 ---- */

  function onSubmitComment(e) {
    var form = e.target;
    if (!form || !form.classList || !form.classList.contains('pub-cform')) return;
    e.preventDefault();
    sendComment(form);
  }

  function sendComment(form) {
    var scope = form.getAttribute('data-scope') || 'diary';
    var target = form.getAttribute('data-target') || '';
    var nameEl = form.querySelector('.pub-input-name');
    var textEl = form.querySelector('.pub-input-text');
    var hpEl = form.querySelector('.hp-field');
    var btn = form.querySelector('button[type="submit"]');

    var content = (textEl.value || '').trim();
    if (!content) { setFormMsg(form, '还没写内容', 'err'); textEl.focus(); return; }

    var name = (nameEl.value || '').trim();
    if (name) rememberName(name);

    btn.disabled = true;
    btn.textContent = '发送中…';
    setFormMsg(form, '', '');

    fetch(COMMENT_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: scope,
        target: target,
        name: name,
        content: content,
        hp: hpEl ? hpEl.value : ''
      })
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) throw new Error(data.error || ('请求失败（' + res.status + '）'));
          return data;
        });
      })
      .then(function (data) {
        var created = data.comment;
        textEl.value = '';
        setFormMsg(form, '已发送', 'ok');
        if (!created) return;       /* 蜜罐命中时服务端不返回内容，静静收场 */
        insertComment(form, scope, target, created);
      })
      .catch(function (err) { setFormMsg(form, err.message || String(err), 'err'); })
      .finally(function () {
        btn.disabled = false;
        btn.textContent = '发送';
      });
  }

  /* 发完不重拉整个列表（省一次请求），直接把新那条插进该在的位置 */
  function insertComment(form, scope, target, created) {
    if (scope === 'board') {
      var list = document.getElementById('board-list');
      if (!list) return;
      var empty = list.querySelector('.pub-state');
      if (empty) empty.parentNode.removeChild(empty);

      /* 如果在第一页，直接插入到最顶部，并截断超出一页的部分保持 15 条 */
      if (boardPage === 1) {
        list.insertAdjacentHTML('afterbegin', commentHtml(created, 'pub-board-item'));
        var boardItems = list.querySelectorAll('.pub-board-item');
        if (boardItems.length > BOARD_PAGE) {
          var last = boardItems[boardItems.length - 1];
          if (last && last.parentNode) last.parentNode.removeChild(last);
        }
      } else {
        setBoardPage(1);
      }
      boardTotal += 1;
      boardTotalPages = Math.max(1, Math.ceil(boardTotal / BOARD_PAGE));
      renderBoardPager();
      return;
    }

    var box = form.closest ? form.closest('.pub-comments') : null;
    if (!box) return;

    var hint = box.querySelector('.pub-comments-hint');
    if (hint) hint.parentNode.removeChild(hint);

    /* 日记下的留言是正序（老的在上），所以插在表单前面 = 接在最末 */
    form.insertAdjacentHTML('beforebegin', commentHtml(created));

    var n = (parseInt(box.getAttribute('data-count'), 10) || 0) + 1;
    box.setAttribute('data-count', n);
    var label = box.querySelector('.pub-comments-label');
    if (label) label.textContent = n + ' 条留言';
    commentCounts[target] = n;
    if (commentCache[target]) commentCache[target].push(created);
  }

  /* ---- 每篇日记的留言数：一次查完，别一篇一个请求 ---- */

  function loadCommentCounts() {
    fetch(COMMENT_API + '?counts=1', { headers: { accept: 'application/json' } })
      .then(function (res) { return res.json().catch(function () { return {}; }); })
      .then(function (data) {
        if (data && data.needTable) { hideAllComments(); return; }
        commentCounts = (data && data.counts) || {};
        applyCommentCounts();
      })
      .catch(function () { /* 拿不到条数不影响看日记，保持「留言」两个字 */ });
  }

  /* 条数是后到的：把先前占位的「-1」补成真实数字 */
  function applyCommentCounts() {
    Array.prototype.forEach.call(document.querySelectorAll('.pub-comments[data-date]'), function (box) {
      if (box.getAttribute('data-count') !== '-1') return;
      var n = commentCounts[box.getAttribute('data-date')] || 0;
      box.setAttribute('data-count', n);
      var label = box.querySelector('.pub-comments-label');
      if (label && n) label.textContent = n + ' 条留言';
    });
  }

  /* 留言表还没建：整块藏掉。访客看到的是「正常但没留言功能」，不是坏掉 */
  function hideAllComments() {
    commentBlocked = true;
    Array.prototype.forEach.call(document.querySelectorAll('.pub-comments'), function (el) {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
  }

  /* ---- 留言簿 ---- */

  function renderBoard() {
    var body = document.getElementById('board-body');
    if (!body) return;
    /* 已经建过就不重建 —— 切走再切回来要保留滚动位置和已加载的列表 */
    if (boardInited) return;

    body.innerHTML =
      '<div class="pub-board-top">' +
        '<div class="pub-board-title">留言簿</div>' +
        '<div class="pub-board-desc">不看日记也想说点什么，就写这儿。</div>' +
        formHtml('board', '') +
      '</div>' +
      '<div id="board-list" class="pub-board-list"><div class="pub-state">正在读取…</div></div>' +
      '<div id="board-pagination"></div>';

    boardInited = true;
    loadBoard(true);
  }

  function renderBoardPager() {
    var box = document.getElementById('board-pagination');
    if (!box) return;
    if (boardTotalPages <= 1) { box.innerHTML = ''; return; }

    box.innerHTML =
      '<div class="pub-pager">' +
        '<button class="pub-page-btn" data-board-goto="' + (boardPage - 1) + '"' +
          (boardPage <= 1 ? ' disabled' : '') + '>上一页</button>' +
        '<span class="pub-page-info">' + boardPage + ' / ' + boardTotalPages + '</span>' +
        '<button class="pub-page-btn" data-board-goto="' + (boardPage + 1) + '"' +
          (boardPage >= boardTotalPages ? ' disabled' : '') + '>下一页</button>' +
      '</div>';
  }

  function setBoardPage(p) {
    if (!(p >= 1) || p > boardTotalPages || p === boardPage) return;
    boardPage = p;
    var list = document.getElementById('board-list');
    if (list) list.innerHTML = '<div class="pub-state">正在读取…</div>';
    var boardTop = document.querySelector('.pub-board-top');
    if (boardTop && boardTop.scrollIntoView) {
      boardTop.scrollIntoView({ behavior: 'smooth' });
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    loadBoard(false);
  }

  function loadBoard(reset) {
    if (boardLoading) return;
    var list = document.getElementById('board-list');
    if (!list) return;

    if (reset) boardPage = 1;
    boardLoading = true;

    var offset = (boardPage - 1) * BOARD_PAGE;

    fetch(COMMENT_API + '?scope=board&limit=' + BOARD_PAGE + '&offset=' + offset, { headers: { accept: 'application/json' } })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) throw new Error(data.error || ('请求失败（' + res.status + '）'));
          return data;
        });
      })
      .then(function (data) {
        if (data.needTable) {
          list.innerHTML = stateHtml('留言功能还没启用', '站主还没把留言表建起来');
          var pag = document.getElementById('board-pagination');
          if (pag) pag.innerHTML = '';
          return;
        }

        var items = data.comments || [];
        var total = typeof data.total === 'number' && data.total >= 0 ? data.total : (offset + items.length + (data.hasMore ? 1 : 0));
        boardTotal = total;
        boardTotalPages = Math.max(1, Math.ceil(total / BOARD_PAGE));
        if (boardPage > boardTotalPages) boardPage = boardTotalPages;

        if (!items.length) {
          list.innerHTML = stateHtml('还没有留言', '来说第一句吧');
        } else {
          list.innerHTML = items.map(function (c) {
            return commentHtml(c, 'pub-board-item');
          }).join('');
        }

        renderBoardPager();
      })
      .catch(function (err) {
        list.innerHTML = stateHtml('没能读到留言', err.message || String(err));
      })
      .finally(function () {
        boardLoading = false;
      });
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

    if (tab === 'board') {
      /* 留言簿的数据不走 /api/doc，自己拉，别把 doc 那套带上 */
      if (commentBlocked) {
        var b = document.getElementById('board-body');
        if (b && !b.innerHTML) b.innerHTML = stateHtml('留言功能还没启用', '站主还没把留言表建起来');
      } else {
        renderBoard();
      }
    } else if (tab !== 'diary') {
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

    /* 翻页按钮整块重建，所以监听挂在容器上（它本身不会被替换） */
    var pag = document.getElementById('pub-pagination');
    if (pag) {
      pag.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('[data-goto]') : null;
        if (!btn || btn.disabled) return;
        setPage(parseInt(btn.getAttribute('data-goto'), 10));
      });
    }

    /* 筛选条每次都整块重建，所以监听挂在容器上（委托），不跟着重建丢 */
    var filter = document.getElementById('pub-filter');
    if (filter) {
      filter.addEventListener('change', onFilterChange);
      filter.addEventListener('click', onFilterClick);
    }

    /* 目标卡同理：卡片是渲染出来的，事件挂在容器上。
       阅读页的书行、目标页的技能行也用同一套开关，所以两边都挂。 */
    ['goals-body', 'study-body'].forEach(function (id) {
      var box = document.getElementById(id);
      if (!box) return;
      box.addEventListener('click', onFoldClick);
      box.addEventListener('keydown', onFoldKey);
    });

    /* 留言区也是渲染出来的：开合和提交都走委托。
       注意监听挂在 #pub-timeline / #board-body 上（这两个容器本身不会被替换），
       而不是挂在会重建的留言块上。 */
    ['pub-timeline', 'board-body'].forEach(function (id) {
      var box = document.getElementById(id);
      if (!box) return;
      box.addEventListener('click', onCommentClick);
      box.addEventListener('submit', onSubmitComment);
    });

    /* 留言簿翻页事件委托 */
    var boardBody = document.getElementById('board-body');
    if (boardBody) {
      boardBody.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('[data-board-goto]') : null;
        if (!btn || btn.disabled) return;
        setBoardPage(parseInt(btn.getAttribute('data-board-goto'), 10));
      });
    }

    /* 访客昵称自动保存与多处输入实时同步：
       只要在任一昵称框输入或修改，立刻保存至 localStorage，
       并同步页面上其他输入框（日记留言、留言簿、书目/目标推荐），
       下次访问或关浏览器重开时都能自动带出，无需手动反复填写 */
    document.addEventListener('input', function (e) {
      if (e.target && e.target.classList && e.target.classList.contains('pub-input-name')) {
        var val = (e.target.value || '').trim();
        rememberName(val);
        Array.prototype.forEach.call(document.querySelectorAll('.pub-input-name'), function (el) {
          if (el !== e.target && el.value !== e.target.value) el.value = e.target.value;
        });
      }
    });

    /* 留言数单独拉：条数是后到的，先渲染日记再补数字，别为了一行数字让整页等着 */
    loadCommentCounts();

    /* 推荐区的提交同理：挂在容器上（容器本身不会被替换，render 只换它的 innerHTML）。
       阅读页的荐读、目标页的目标推荐，各挂一个。 */
    bindSuggestForm('study-body', suggest);
    bindSuggestForm('goals-body', gsuggest);

    loadDiary();
  });
})();
