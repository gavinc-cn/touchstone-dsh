/* Touchstone 官网脚本：只做一件小事，没有它页面照常可读
   首屏那块开发看板进入视口时，让卡片依次落位（reduced-motion 下直接给终态）。
   看板本身是静态 HTML/CSS——不加载数据、不画图表，也不假装可交互。 */
(function () {
  'use strict';

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var board = document.getElementById('board');
  if (!board) return;

  var show = function () { board.classList.add('is-in'); };

  if (reduce || !('IntersectionObserver' in window)) {
    show();
  } else {
    // 阈值取 0 而不是某个比例：窄屏上整块看板比视口高得多，
    // 用 0.2 会让首屏那一段卡片一直停在 opacity:0，要滚一段才出现。
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { show(); io.disconnect(); }
      });
    }, { threshold: 0, rootMargin: '0px 0px -12% 0px' });
    io.observe(board);
  }
})();
