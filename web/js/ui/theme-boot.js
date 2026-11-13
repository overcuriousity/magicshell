// Classic script, loaded first in <head>: applies the stored theme and text size before first paint.
// The CSP allows no inline script; theme.js changes the values later.
(function () {
  var root = document.documentElement;
  try {
    var theme = localStorage.getItem('magicshell.theme');
    if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
    if (localStorage.getItem('magicshell.textsize') === 'compact') root.dataset.density = 'compact';
  } catch (e) {
    // storage blocked: keep the defaults
  }
})();
