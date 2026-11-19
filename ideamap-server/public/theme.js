/* Applies the saved theme before first paint, and exposes a toggle. */
(function () {
  var KEY = 'ideamap-theme';
  function saved() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function apply(t) {
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
  }
  function current() {
    var t = document.documentElement.getAttribute('data-theme');
    if (t) return t;
    return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  apply(saved());
  window.IdeaTheme = {
    current: current,
    toggle: function () {
      var next = current() === 'dark' ? 'light' : 'dark';
      apply(next);
      try { localStorage.setItem(KEY, next); } catch (e) { /* private mode */ }
      document.dispatchEvent(new CustomEvent('themechange'));
      return next;
    },
  };
})();
