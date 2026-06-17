/* Sichuan Citur Travel — landing page 交互
   仅做三件事：导航滚动态、入场显示、统计数字滚动 */
(() => {
  'use strict';

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- 导航：滚动后加底色 ---------- */
  const nav = document.getElementById('siteNav');
  const NAV_SCROLL_THRESHOLD = 40;
  const syncNav = () => {
    nav.classList.toggle('scrolled', window.scrollY > NAV_SCROLL_THRESHOLD);
  };
  syncNav();
  window.addEventListener('scroll', syncNav, { passive: true });

  /* ---------- 统计数字滚动 ---------- */
  const COUNT_DURATION_MS = 1400;
  const easeOutExpo = (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t));

  const animateCount = (el) => {
    const target = Number(el.dataset.count);
    if (!Number.isFinite(target)) return;
    if (prefersReducedMotion) {
      el.textContent = target.toLocaleString('zh-CN');
      return;
    }
    const start = performance.now();
    const tick = (now) => {
      const progress = Math.min((now - start) / COUNT_DURATION_MS, 1);
      const value = Math.round(target * easeOutExpo(progress));
      el.textContent = value.toLocaleString('zh-CN');
      if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  /* ---------- 入场显示（IntersectionObserver） ---------- */
  const revealEls = document.querySelectorAll('.reveal');
  if (prefersReducedMotion || !('IntersectionObserver' in window)) {
    revealEls.forEach((el) => el.classList.add('is-visible'));
    document.querySelectorAll('[data-count]').forEach(animateCount);
  } else {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          entry.target.querySelectorAll('[data-count]').forEach(animateCount);
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.15, rootMargin: '0px 0px -8% 0px' }
    );
    revealEls.forEach((el) => observer.observe(el));
  }

  /* ---------- 页脚年份 ---------- */
  const year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());
})();
