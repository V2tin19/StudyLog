/* ============================================
   Public Site - 公开只读页
   从 /api/diary 拉数据渲染时间线，页面上没有任何编辑入口。
   ============================================ */

(function () {
  'use strict';

  var API = '/api/diary';
  var PAGE_SIZE = 30;
  var THEME_KEY = 'studylog_public_theme';
  var WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

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

  var offset = 0;
  var total = 0;
  var loading = false;
  var firstLoad = true;

  /* ---------- 小工具 ---------- */

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function parseDate(str) {
    var p = String(str).split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }

  function dateLabel(str) {
    var d = parseDate(str);
    return d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
  }

  function weekdayLabel(str) {
    return WEEKDAYS[parseDate(str).getDay()] || '';
  }

  function shortDate(str) {
    if (!str) return '—';
    var d = parseDate(str);
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  /* ---------- 渲染 ---------- */

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
          return '<img src="' + esc(u) + '" alt="日记配图" loading="lazy" referrerpolicy="no-referrer">';
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
      '<div class="pub-stat"><div class="pub-stat-value">' + stats.total + '</div>' +
        '<div class="pub-stat-label">累计记录</div></div>' +
      '<div class="pub-stat"><div class="pub-stat-value">' + esc(shortDate(stats.firstDate)) + '</div>' +
        '<div class="pub-stat-label">开始于</div></div>' +
      '<div class="pub-stat"><div class="pub-stat-value">' + esc(shortDate(stats.lastDate)) + '</div>' +
        '<div class="pub-stat-label">最近更新</div></div>';
  }

  function updateMoreButton() {
    var wrap = document.getElementById('pub-more-wrap');
    if (!wrap) return;
    if (offset < total) wrap.classList.remove('hidden');
    else wrap.classList.add('hidden');
  }

  function showError(msg) {
    var tl = document.getElementById('pub-timeline');
    if (!tl) return;

    if (offset === 0) {
      document.getElementById('pub-hero').innerHTML = '';
      document.getElementById('pub-more-wrap').classList.add('hidden');
      tl.innerHTML = '<div class="pub-state"><strong>没能读到记录</strong>' + esc(msg) + '</div>';
      return;
    }

    var tip = document.createElement('div');
    tip.className = 'pub-state';
    tip.textContent = '加载失败：' + msg;
    tl.appendChild(tip);
  }

  /* ---------- 数据加载 ---------- */

  function load() {
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
          tl.innerHTML = '<div class="pub-state"><strong>还没有记录</strong>等我写下第一篇，这里就会亮起来。</div>';
        } else if (entries.length) {
          tl.insertAdjacentHTML('beforeend', entries.map(entryHtml).join(''));
        }

        offset += entries.length;
        if (firstLoad && !total) total = offset;
        firstLoad = false;
        updateMoreButton();
      })
      .catch(function (err) { showError(err.message || String(err)); })
      .finally(function () {
        loading = false;
        if (btn) {
          btn.disabled = false;
          btn.textContent = '加载更早的记录';
        }
      });
  }

  /* ---------- 主题 ---------- */

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

  /* ---------- 启动 ---------- */

  document.addEventListener('DOMContentLoaded', function () {
    initTheme();

    var tl = document.getElementById('pub-timeline');
    if (tl) tl.innerHTML = '<div class="pub-state">正在读取…</div>';

    var more = document.getElementById('pub-more');
    if (more) more.addEventListener('click', load);

    load();
  });
})();
