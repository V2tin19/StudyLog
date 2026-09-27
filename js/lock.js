/* ============================================
   Lock - 写作台门禁
   没令牌的人打开写作台，只会看到锁屏，看不到编辑器。

   重要：这一层是「显得该锁的都锁着」+ 顺手拦一下，
   真正的安全边界在服务端的令牌校验（/api/admin/diary）。
   就算有人拆掉这层锁屏，他拿到也只是一个纯本地的编辑器，
   没有令牌就发不到你的数据库。
   ============================================ */

(function () {
  'use strict';

  var root = document.documentElement;

  function isUnlocked() { return root.classList.contains('unlocked'); }

  function unlock() { root.classList.add('unlocked'); }

  function showMsg(text, type) {
    var el = document.getElementById('lock-msg');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = type === 'err' ? 'var(--accent-red)'
                   : type === 'ok' ? 'var(--accent-green)'
                   : 'var(--text-muted)';
  }

  function setBusy(busy) {
    var btn = document.getElementById('lock-enter');
    var input = document.getElementById('lock-token');
    if (btn) { btn.disabled = busy; btn.textContent = busy ? '验证中…' : '进入'; }
    if (input) input.disabled = busy;
  }

  async function tryEnter() {
    var input = document.getElementById('lock-token');
    var token = input ? input.value.trim() : '';

    if (!token) { showMsg('请先填入管理令牌', 'err'); return; }

    setBusy(true);
    showMsg('正在向服务器验证…');

    try {
      /* 先存下来，Cloud.verify 会用它；验证不过再清掉 */
      Cloud.setToken(token);
      await Cloud.verify();

      showMsg('验证通过，正在进入…', 'ok');
      unlock();
      setTimeout(function () { location.reload(); }, 300);
    } catch (err) {
      Cloud.setToken('');
      setBusy(false);
      showMsg(err.message, 'err');
    }
  }

  /* 本地离线使用：只在本次会话内有效，刷新页面后仍会重置为「未解锁」以外，
     不会写入 localStorage，避免长期削弱门禁。 */
  function useOffline() {
    try { sessionStorage.setItem('studylog_local_only', '1'); } catch (e) { /* 忽略 */ }
    unlock();
    location.reload();
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (isUnlocked()) return;   /* 已解锁，什么都不用做 */

    var btn = document.getElementById('lock-enter');
    var input = document.getElementById('lock-token');
    var off = document.getElementById('lock-offline');

    if (btn) btn.addEventListener('click', tryEnter);

    if (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') tryEnter();
      });
      input.focus();
    }

    if (off) {
      off.addEventListener('click', function (e) {
        e.preventDefault();
        useOffline();
      });
    }
  });
})();
