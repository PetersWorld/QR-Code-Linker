/* Motion layer: GSAP + ScrollTrigger + Lenis. Content stays fully visible if any of them
   fail to load, or if the visitor prefers reduced motion. */
(function () {
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var ok = !!(window.gsap && window.ScrollTrigger) && !reduce;
  var CLEAR = 'opacity,visibility,transform,filter';
  var lenis = null;
  var homeDone = false;

  function q(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function noop() {}

  var api = { scrollTo: null, home: noop, auth: noop, swap: noop, builder: noop, landing: noop };
  window.QRLMotion = api;
  api.scrollTo = function (el) {
    if (lenis) lenis.scrollTo(el, { duration: 1.4, offset: 0 });
    else el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  };
  if (!ok) return;

  gsap.registerPlugin(ScrollTrigger);
  gsap.defaults({ ease: 'power3.out', duration: 0.85 });

  function splitWords(el) {
    if (el.dataset.split === 'done') return q('.word > span', el);
    var text = el.textContent.trim();
    el.setAttribute('aria-label', text);
    el.textContent = '';
    text.split(/\s+/).forEach(function (w, i, all) {
      var mask = document.createElement('span');
      var inner = document.createElement('span');
      mask.className = 'word';
      mask.setAttribute('aria-hidden', 'true');
      inner.textContent = w;
      mask.appendChild(inner);
      el.appendChild(mask);
      if (i < all.length - 1) el.appendChild(document.createTextNode(' '));
    });
    el.dataset.split = 'done';
    return q('.word > span', el);
  }

  function initLenis() {
    if (lenis || !window.Lenis) return;
    lenis = new Lenis({ lerp: 0.085, smoothWheel: true, wheelMultiplier: 0.9 });
    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add(function (t) { lenis.raf(t * 1000); });
    gsap.ticker.lagSmoothing(0);
  }

  api.home = function () {
    if (homeDone) { ScrollTrigger.refresh(); return; }
    homeDone = true;
    initLenis();

    // Hero entrance: frame first, headline lines, then supporting copy.
    var tl = gsap.timeline({ defaults: { ease: 'power4.out' } });
    tl.from('[data-hero-vf]', { autoAlpha: 0, scale: 0.92, duration: 1.2, clearProps: CLEAR }, 0)
      .from('.hero-vf .vf > i', { scale: 0.5, autoAlpha: 0, duration: 0.9, stagger: 0.06, transformOrigin: 'center', clearProps: CLEAR }, 0.2)
      .from('.hero .lab', { autoAlpha: 0, y: 16, duration: 0.8, clearProps: CLEAR }, 0.15)
      .from('[data-hero-line]', { yPercent: 115, duration: 1.15, stagger: 0.12, clearProps: 'transform' }, 0.25)
      .from('.hero .sub, .hero .cta-row, .hero .facts', { autoAlpha: 0, y: 28, duration: 0.9, stagger: 0.1, clearProps: CLEAR }, 0.7);

    gsap.to('.hero-vf', { yPercent: -8, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: 1.2 } });

    q('[data-split]').forEach(function (el) {
      var words = splitWords(el);
      gsap.from(words, { yPercent: 115, duration: 1, ease: 'power4.out', stagger: 0.055, clearProps: 'transform',
        scrollTrigger: { trigger: el, start: 'top 85%', once: true } });
    });
    q('[data-reveal]').forEach(function (el) {
      gsap.from(el, { autoAlpha: 0, y: 24, duration: 0.9, ease: 'power4.out', clearProps: CLEAR,
        scrollTrigger: { trigger: el, start: 'top 88%', once: true } });
    });

    // Groups that arrive one after another.
    [['.how', '.how-li'], ['.bl', '.bl-li'], ['.use', 'li'], ['.fin-row', '.cta-row']].forEach(function (g) {
      var group = document.querySelector('#home ' + g[0]);
      if (!group) return;
      var items = q(g[1], group);
      gsap.from(items, { autoAlpha: 0, y: 36, duration: 0.95, ease: 'power4.out', stagger: 0.08, clearProps: CLEAR,
        scrollTrigger: { trigger: group, start: 'top 82%', once: true } });
    });

    // How it works: each numeral lights up in turn as its step arrives.
    var steps = q('.how-li');
    var mm = gsap.matchMedia();
    mm.add('(min-width: 901px) and (min-height: 860px)', function () {
      ScrollTrigger.create({
        trigger: '#how', start: 'top top', end: '+=' + Math.round(window.innerHeight * 1.6),
        pin: true, anticipatePin: 1, scrub: true,
        onUpdate: function (self) {
          var n = Math.min(steps.length - 1, Math.floor(self.progress * steps.length * 0.999));
          steps.forEach(function (s, i) { s.classList.toggle('on', i <= n); });
        },
        onLeaveBack: function () { steps.forEach(function (s) { s.classList.remove('on'); }); }
      });
    });
    mm.add('(max-width: 900px), (max-height: 859px)', function () {
      steps.forEach(function (s) {
        ScrollTrigger.create({ trigger: s, start: 'top 70%', onEnter: function () { s.classList.add('on'); } });
      });
    });

    // Magnetic buttons.
    if (!window.matchMedia('(pointer: coarse)').matches) {
      q('[data-magnetic]').forEach(function (el) {
        var xTo = gsap.quickTo(el, 'x', { duration: 0.45, ease: 'power3.out' });
        var yTo = gsap.quickTo(el, 'y', { duration: 0.45, ease: 'power3.out' });
        el.addEventListener('pointermove', function (e) {
          var r = el.getBoundingClientRect();
          xTo((e.clientX - r.left - r.width / 2) * 0.18);
          yTo((e.clientY - r.top - r.height / 2) * 0.28);
        });
        el.addEventListener('pointerleave', function () { xTo(0); yTo(0); });
      });
    }

    var refresh = function () { ScrollTrigger.refresh(); };
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(refresh);
    window.addEventListener('load', refresh);
  };

  api.auth = function () {
    gsap.from('.auth-pitch .lab, .pitch:not([hidden]) h1, .pitch:not([hidden]) p', { autoAlpha: 0, y: 40, duration: 1, ease: 'power4.out', stagger: 0.1, clearProps: CLEAR });
    gsap.from('.auth-vf', { autoAlpha: 0, scale: 0.9, duration: 1.1, delay: 0.3, ease: 'power4.out', clearProps: CLEAR });
    gsap.from('.auth-top, .auth-card > *', { autoAlpha: 0, y: 24, duration: 0.9, delay: 0.2, stagger: 0.07, clearProps: CLEAR });
  };
  api.swap = function (el) {
    if (!el) return;
    gsap.from(q('h1, p', el), { autoAlpha: 0, y: 36, duration: 0.8, ease: 'power4.out', stagger: 0.08, clearProps: CLEAR });
  };
  api.builder = function () {
    gsap.from('.app-header', { autoAlpha: 0, y: -16, duration: 0.8, clearProps: CLEAR });
    gsap.from('.intro .lab, .intro h1', { autoAlpha: 0, y: 40, duration: 1, ease: 'power4.out', stagger: 0.1, clearProps: CLEAR });
    gsap.from('.form-card > *', { autoAlpha: 0, y: 28, duration: 0.9, delay: 0.25, stagger: 0.08, clearProps: CLEAR });
  };
  api.landing = function () {
    gsap.from('.landing header > *', { autoAlpha: 0, y: 36, duration: 1, ease: 'power4.out', stagger: 0.09, clearProps: CLEAR });
    gsap.from('.landing-links li', { autoAlpha: 0, y: 28, duration: 0.9, delay: 0.3, stagger: 0.08, clearProps: CLEAR });
    gsap.from('.made-with', { autoAlpha: 0, duration: 0.8, delay: 0.7, clearProps: CLEAR });
  };
})();
