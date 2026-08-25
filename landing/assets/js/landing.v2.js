/* Sichuan Citur Travel — landing page v2 交互
   只做三件事：导航滚动态、hero 加载编排、航线图逐条绘制。
   内容默认可见；本脚本只负责「增强」，不加载也不影响可读性。 */
(() => {
  'use strict';

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* 只有跑到这里，说明 JS 已启用 —— 打开动效开关 */
  if (!prefersReducedMotion) {
    document.documentElement.classList.add('js-anim');
  }

  /* ---------- 导航：滚动后加底色 ---------- */
  const nav = document.getElementById('siteNav');
  const NAV_SCROLL_THRESHOLD = 40;
  if (nav) {
    const syncNav = () => {
      nav.classList.toggle('scrolled', window.scrollY > NAV_SCROLL_THRESHOLD);
    };
    syncNav();
    window.addEventListener('scroll', syncNav, { passive: true });
  }

  /* ---------- Hero 加载编排 ---------- */
  if (!prefersReducedMotion) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.documentElement.classList.add('is-ready');
      });
    });
  }

  /* ---------- 航线图：进入视口后依次绘出，只播一次 ---------- */
  const routeMap = document.querySelector('.route-map');
  if (routeMap && !prefersReducedMotion) {
    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            entry.target.classList.add('in-view');
            observer.unobserve(entry.target);
          });
        },
        { threshold: 0.25 }
      );
      observer.observe(routeMap);
    } else {
      routeMap.classList.add('in-view');
    }
  } else if (routeMap) {
    routeMap.classList.add('in-view');
  }

  /* ---------- 页脚年份 ---------- */
  const year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());
})();
