(function () {
  'use strict';

  var HASH_KEY = 'd=';
  var MAX_LINKS = 20;

  // Encode text as UTF-8 so labels with emoji/accents survive the QR code.
  qrcode.stringToBytes = function (s) {
    return Array.from(new TextEncoder().encode(s));
  };

  // ---- Payload encoding (links are stored in the URL hash, no server needed) ----

  function toBase64Url(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    bytes.forEach(function (b) { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromBase64Url(b64) {
    var bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
    var bytes = Uint8Array.from(bin, function (c) { return c.charCodeAt(0); });
    return new TextDecoder().decode(bytes);
  }

  function encodeData(data) {
    var obj = { t: data.title, l: data.links.map(function (l) { return [l.label, l.url]; }) };
    // The picture rides beside the JSON, not inside it, so it is only base64-encoded once.
    return toBase64Url(JSON.stringify(obj)) + (data.avatar ? AVATAR_PARAM + data.avatar : '');
  }

  // The picture travels inside the code as a tiny palette image: size, colour count, the colours,
  // then packed pixel indexes. A normal PNG or JPEG header alone is bigger than this whole picture.
  var AVATAR_PARAM = '&p=';
  var PREVIEW_PIC_KEY = 'qrl.previewPic';

  function bitsFor(k) { return k <= 2 ? 1 : k <= 4 ? 2 : k <= 8 ? 3 : 4; }

  function b64urlToBytes(s) {
    var bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToB64url(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  }

  function pipeBytes(bytes, stream) {
    var w = stream.writable.getWriter();
    w.write(bytes);
    w.close();
    return new Response(stream.readable).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }

  // Resolves to a PNG data URL, or '' when the picture cannot be read.
  function avatarToDataUrl(p) {
    if (typeof p !== 'string' || !/^[A-Za-z0-9_-]{8,2000}$/.test(p)) return Promise.resolve('');
    var raw;
    try {
      if (p.charAt(0) === 'z') {
        if (!window.DecompressionStream) return Promise.resolve('');
        raw = pipeBytes(b64urlToBytes(p.slice(1)), new DecompressionStream('deflate-raw'));
      } else {
        raw = Promise.resolve(b64urlToBytes(p));
      }
    } catch (e) {
      return Promise.resolve('');
    }
    return raw.then(function (bin) {
      var size = bin[0], k = bin[1];
      if (size < 8 || size > 96 || k < 2 || k > 16 || bin.length < 2 + k * 3) return '';
      var bpp = bitsFor(k), base = 2 + k * 3;
      if (bin.length < base + Math.ceil(size * size * bpp / 8)) return '';
      var canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      var ctx = canvas.getContext('2d');
      var out = ctx.createImageData(size, size);
      for (var n = 0; n < size * size; n++) {
        var idx = 0;
        for (var b = 0; b < bpp; b++) {
          var bit = n * bpp + b;
          idx = (idx << 1) | ((bin[base + (bit >> 3)] >> (7 - (bit & 7))) & 1);
        }
        if (idx >= k) idx = k - 1;
        out.data[n * 4] = bin[2 + idx * 3];
        out.data[n * 4 + 1] = bin[3 + idx * 3];
        out.data[n * 4 + 2] = bin[4 + idx * 3];
        out.data[n * 4 + 3] = 255;
      }
      ctx.putImageData(out, 0, 0);
      return canvas.toDataURL('image/png');
    }).catch(function () { return ''; });
  }

  function decodeData(encoded) {
    var cut = encoded.indexOf(AVATAR_PARAM);
    var pic = cut === -1 ? '' : encoded.slice(cut + AVATAR_PARAM.length);
    if (cut !== -1) encoded = encoded.slice(0, cut);
    var raw = JSON.parse(fromBase64Url(encoded));
    if (!raw || !Array.isArray(raw.l)) throw new Error('Invalid data');
    return {
      title: typeof raw.t === 'string' ? raw.t : '',
      avatar: /^[A-Za-z0-9_-]{8,2000}$/.test(pic) ? pic : '',
      links: raw.l
        .filter(function (l) { return Array.isArray(l) && isSafeUrl(l[1]); })
        .map(function (l) { return { label: String(l[0] || ''), url: String(l[1]) }; })
    };
  }

  // ---- URL helpers ----

  function normalizeUrl(value) {
    var v = value.trim();
    if (!v) return '';
    if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = 'https://' + v;
    return v;
  }

  // Only allow schemes that are safe to render as links on the landing page.
  function isSafeUrl(value) {
    try {
      var u = new URL(value);
      return ['http:', 'https:', 'mailto:', 'tel:', 'sms:'].indexOf(u.protocol) !== -1;
    } catch (e) {
      return false;
    }
  }

  function displayLabel(link) {
    if (link.label) return link.label;
    try {
      var u = new URL(link.url);
      return u.protocol.indexOf('http') === 0 ? u.host + u.pathname.replace(/\/$/, '') : link.url;
    } catch (e) {
      return link.url;
    }
  }

  function appBaseUrl() {
    return location.href.split('#')[0].split('?')[0];
  }

  // ---- Accounts (client-side only: this app has no server) ----

  var USERS_KEY = 'qrl.users';
  var SESSION_KEY = 'qrl.session';
  var memoryStore = {};

  function storeGet(key) {
    try { var v = localStorage.getItem(key); if (v !== null) return v; } catch (e) { /* blocked */ }
    return memoryStore.hasOwnProperty(key) ? memoryStore[key] : null;
  }
  function storeSet(key, value) {
    memoryStore[key] = value;
    try { localStorage.setItem(key, value); } catch (e) { /* blocked: memory only */ }
  }
  function storeRemove(key) {
    delete memoryStore[key];
    try { localStorage.removeItem(key); } catch (e) { /* blocked */ }
  }

  function loadUsers() {
    try { var u = JSON.parse(storeGet(USERS_KEY) || '{}'); return u && typeof u === 'object' ? u : {}; }
    catch (e) { return {}; }
  }
  function getSession() {
    try {
      var s = JSON.parse(storeGet(SESSION_KEY) || 'null');
      if (s && typeof s.email === 'string' && loadUsers()[s.email]) return s;
    } catch (e) { /* ignore */ }
    return null;
  }

  function bytesToB64(buf) {
    var bin = '';
    new Uint8Array(buf).forEach(function (b) { bin += String.fromCharCode(b); });
    return btoa(bin);
  }

  // PBKDF2-SHA256 with a per-account random salt.
  function hashPassword(password, saltB64) {
    if (!window.crypto || !crypto.subtle) return Promise.reject(new Error('unsupported'));
    var salt = saltB64
      ? Uint8Array.from(atob(saltB64), function (c) { return c.charCodeAt(0); })
      : crypto.getRandomValues(new Uint8Array(16));
    return crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
      .then(function (key) {
        return crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: 150000, hash: 'SHA-256' }, key, 256);
      })
      .then(function (bits) { return { salt: bytesToB64(salt), hash: bytesToB64(bits) }; });
  }

  function isEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v); }

  // Shows an error above the form and flags (and focuses) the field it is about.
  function authError(form, msg, field) {
    var el = form.querySelector('.error');
    el.textContent = msg || '';
    el.hidden = !msg;
    Array.prototype.forEach.call(form.querySelectorAll('input'), function (i) { i.removeAttribute('aria-invalid'); });
    if (msg && field && form.elements[field]) {
      form.elements[field].setAttribute('aria-invalid', 'true');
      form.elements[field].focus();
    }
  }
  function setBusy(form, busy) {
    var btn = form.querySelector('button[type="submit"]');
    btn.disabled = busy;
  }

  function signUp(form) {
    var name = form.name.value.trim();
    var email = form.email.value.trim().toLowerCase();
    var pw = form.password.value;
    if (!name) return authError(form, 'Enter your name.', 'name');
    if (!isEmail(email)) return authError(form, 'Enter a valid email address.', 'email');
    if (pw.length < 8) return authError(form, 'Password must be at least 8 characters.', 'password');
    if (pw !== form.confirm.value) return authError(form, 'Passwords do not match.', 'confirm');
    var users = loadUsers();
    if (users[email]) return authError(form, 'An account with this email already exists. Try signing in.', 'email');
    authError(form, '');
    setBusy(form, true);
    hashPassword(pw).then(function (h) {
      users = loadUsers();
      users[email] = { name: name, salt: h.salt, hash: h.hash, created: Date.now() };
      storeSet(USERS_KEY, JSON.stringify(users));
      storeSet(SESSION_KEY, JSON.stringify({ email: email }));
      form.reset();
      enterApp();
    }, function () {
      authError(form, 'This browser cannot create accounts here (secure context required).');
    }).then(function () { setBusy(form, false); });
  }

  function signIn(form) {
    var email = form.email.value.trim().toLowerCase();
    var pw = form.password.value;
    if (!email || !pw) return authError(form, 'Enter your email and password.', form.email.value.trim() ? 'password' : 'email');
    authError(form, '');
    setBusy(form, true);
    var user = loadUsers()[email];
    // Hash even for unknown emails so timing doesn't reveal which accounts exist.
    hashPassword(pw, user ? user.salt : null).then(function (h) {
      if (!user || h.hash !== user.hash) return authError(form, 'Incorrect email or password.', 'password');
      storeSet(SESSION_KEY, JSON.stringify({ email: email }));
      form.reset();
      enterApp();
    }, function () {
      authError(form, 'This browser cannot sign in here (secure context required).');
    }).then(function () { setBusy(form, false); });
  }

  function selectTab(which) {
    var signin = which === 'signin';
    [['signin', signin], ['signup', !signin]].forEach(function (p) {
      var tab = document.getElementById('tab-' + p[0]);
      tab.setAttribute('aria-selected', String(p[1]));
      tab.tabIndex = p[1] ? 0 : -1;
      document.getElementById('form-' + p[0]).hidden = !p[1];
      document.getElementById('pitch-' + p[0]).hidden = !p[1];
    });
    if (!signin) animateSteps();
  }

  // Slide-left-in, character by character, for the sign up steps.
  var stepsSplit = false;
  function animateSteps() {
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var n = 0;
    Array.prototype.forEach.call(document.querySelectorAll('#pitch-signup .step-text'), function (el) {
      if (!stepsSplit) {
        var text = el.textContent;
        el.setAttribute('aria-label', text);
        el.textContent = '';
        text.split('').forEach(function (c) {
          var sp = document.createElement('span');
          sp.className = 'ch';
          sp.setAttribute('aria-hidden', 'true');
          sp.textContent = c === ' ' ? '\u00a0' : c;
          el.appendChild(sp);
        });
      }
      if (reduce) return;
      Array.prototype.forEach.call(el.children, function (sp, i) {
        sp.style.animation = 'none';
        void sp.offsetWidth;
        sp.style.animation = '';
        sp.style.animationDelay = ((n + i) * 0.03) + 's';
      });
      n += el.children.length;
    });
    stepsSplit = true;
  }

  // ---- Theme (bright / dark) ----

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    var tc = document.querySelector('meta[name="theme-color"]');
    if (tc) tc.setAttribute('content', theme === 'light' ? '#F5F5F5' : '#1A1A1A');
    var light = theme === 'light';
    Array.prototype.forEach.call(document.querySelectorAll('.theme-toggle'), function (b) {
      b.setAttribute('aria-pressed', String(light));
      var label = light ? 'Switch to dark mode' : 'Switch to light mode';
      b.setAttribute('aria-label', label);
      b.title = label;
    });
  }
  var themeReady = false;
  function initTheme() {
    if (themeReady) return;
    themeReady = true;
    applyTheme(currentTheme());
    Array.prototype.forEach.call(document.querySelectorAll('.theme-toggle'), function (b) {
      b.addEventListener('click', function () {
        var next = currentTheme() === 'light' ? 'dark' : 'light';
        applyTheme(next);
        storeSet('qrl.theme', next);
      });
    });
  }

  var authReady = false;
  function initAuth() {
    if (authReady) return;
    authReady = true;
    ['signin', 'signup'].forEach(function (name, i) {
      var tab = document.getElementById('tab-' + name);
      tab.addEventListener('click', function () { selectTab(name); if (window.QRLMotion) QRLMotion.swap(document.getElementById('pitch-' + name)); });
      tab.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          var other = i === 0 ? 'signup' : 'signin';
          selectTab(other);
          document.getElementById('tab-' + other).focus();
        }
      });
    });
    document.getElementById('form-signin').addEventListener('submit', function (e) { e.preventDefault(); signIn(e.target); });
    document.getElementById('form-signup').addEventListener('submit', function (e) { e.preventDefault(); signUp(e.target); });
    Array.prototype.forEach.call(document.querySelectorAll('.pw-toggle'), function (btn) {
      btn.addEventListener('click', function () {
        var input = btn.parentNode.querySelector('input');
        var show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.classList.toggle('shown', show);
        btn.setAttribute('aria-pressed', String(show));
        btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      });
    });
    initTheme();
    document.getElementById('sign-out').addEventListener('click', function () {
      storeRemove(SESSION_KEY);
      if (location.hash === '#home') location.reload(); else location.hash = '#home';
    });
  }

  // The marketing page shown to signed-out visitors.
  // Decorative sample codes on the home and sign in screens.
  var demoDone = false;
  function renderDemoQrs() {
    if (demoDone) return;
    demoDone = true;
    var demo = { title: "Joshua's links", links: [
      { label: 'Portfolio', url: 'https://example.com/portfolio' },
      { label: 'GitHub', url: 'https://github.com/example' },
      { label: 'Email me', url: 'mailto:hello@example.com' },
      { label: 'WhatsApp', url: 'https://wa.me/0000000000' }
    ] };
    var text = appBaseUrl() + '#' + HASH_KEY + encodeData(demo);
    ['home-qr', 'home-qr-mini', 'auth-qr'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      try { el.innerHTML = makeQr(text).createSvgTag({ cellSize: 8, margin: 0, scalable: true }); } catch (e) { /* decorative only */ }
    });
  }

  var homeReady = false;
  function initHome() {
    if (homeReady) return;
    homeReady = true;
    initTheme();
    renderDemoQrs();
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    Array.prototype.forEach.call(document.querySelectorAll('[data-scroll]'), function (a) {
      a.addEventListener('click', function (e) {
        var t = document.getElementById(a.getAttribute('data-scroll'));
        if (!t) return;
        e.preventDefault();
        if (window.QRLMotion) QRLMotion.scrollTo(t); else t.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-home]'), function (a) {
      a.addEventListener('click', function (e) {
        if (!document.getElementById('home').hidden) { e.preventDefault(); window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' }); }
      });
    });
  }

  function showHome() {
    initHome();
    document.getElementById('auth').hidden = true;
    document.getElementById('builder').hidden = true;
    document.getElementById('landing').hidden = true;
    document.getElementById('home').hidden = false;
    document.title = 'QR Code Linker: one QR code for every link';
    window.scrollTo(0, 0);
    if (window.QRLMotion) QRLMotion.home();
  }

  function showAuth(tab) {
    initAuth();
    document.getElementById('home').hidden = true;
    document.getElementById('builder').hidden = true;
    document.getElementById('landing').hidden = true;
    document.getElementById('auth').hidden = false;
    document.title = 'Sign in · QR Code Linker';
    renderDemoQrs();
    selectTab(tab === 'signup' ? 'signup' : 'signin');
    window.scrollTo(0, 0);
    if (window.QRLMotion) QRLMotion.auth();
  }

  // Shows the editor when signed in, otherwise the sign in / sign up screen.
  function enterApp() {
    initAuth();
    var session = getSession();
    if (!session) return showAuth();
    document.getElementById('auth').hidden = true;
    document.getElementById('user-name').textContent = loadUsers()[session.email].name || session.email;
    showBuilder();
    if (window.QRLMotion) QRLMotion.builder();
    document.title = 'QR Code Linker';
    window.scrollTo(0, 0);
  }

  // ---- Landing view ----

  function showLanding(data) {
    initTheme();
    var title = data.title || 'Links';
    document.title = title;
    document.getElementById('landing-title').textContent = title;
    var list = document.getElementById('landing-links');
    list.textContent = '';
    var avatar = document.getElementById('landing-avatar');
    avatar.textContent = '';
    avatar.hidden = !data.avatar;
    if (data.avatar) {
      var pic = document.createElement('img');
      pic.alt = '';
      avatar.appendChild(pic);
      // On the device that made the code, show the full-quality picture; everyone else sees the small copy.
      var own = null;
      try { own = JSON.parse(storeGet(PREVIEW_PIC_KEY)); } catch (e) { /* none saved */ }
      if (own && typeof own === 'object' && own.k === data.avatar && typeof own.u === 'string' && own.u.indexOf('data:image/') === 0) {
        pic.src = own.u;
      } else {
        avatarToDataUrl(data.avatar).then(function (url) {
          if (url) pic.src = url; else avatar.hidden = true;
        });
      }
    }
    data.links.forEach(function (link) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = link.url;
      a.rel = 'noopener noreferrer';
      var text = document.createElement('span');
      text.className = 'link-text';
      var name = document.createElement('span');
      name.className = 'link-name';
      name.textContent = displayLabel(link);
      var sub = document.createElement('span');
      sub.className = 'link-sub';
      sub.textContent = link.url.replace(/^(https?:\/\/|mailto:)/i, '').replace(/\/$/, '');
      text.appendChild(name);
      text.appendChild(sub);
      var badge = document.createElement('span');
      badge.className = 'arrow';
      badge.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12L12 4M5.5 4H12v6.5"/></svg>';
      a.appendChild(text);
      a.appendChild(badge);
      li.appendChild(a);
      list.appendChild(li);
    });
    document.getElementById('builder').hidden = true;
    document.getElementById('auth').hidden = true;
    document.getElementById('landing').hidden = false;
    if (window.QRLMotion) QRLMotion.landing();
  }

  // ---- Builder view ----

  var els = {};
  var current = { svg: '', target: '', filename: 'qr-code', logo: '', avatar: '' };
  var renderTimer = null;

  function addRow(label, url) {
    if (els.links.children.length >= MAX_LINKS) return;
    var row = document.getElementById('link-row').content.firstElementChild.cloneNode(true);
    row.querySelector('.label').value = label || '';
    row.querySelector('.url').value = url || '';
    row.querySelector('.remove').addEventListener('click', function () {
      row.remove();
      if (!els.links.children.length) addRow();
      scheduleRender();
    });
    els.links.appendChild(row);
    els.addLink.disabled = els.links.children.length >= MAX_LINKS;
    return row;
  }

  function collectLinks() {
    var links = [];
    var invalid = 0;
    Array.prototype.forEach.call(els.links.children, function (row) {
      var urlInput = row.querySelector('.url');
      var url = normalizeUrl(urlInput.value);
      var ok = !url || isSafeUrl(url);
      urlInput.classList.toggle('invalid', !ok);
      if (!url) return;
      if (!ok) { invalid++; return; }
      links.push({ label: row.querySelector('.label').value.trim(), url: url });
    });
    return { links: links, invalid: invalid };
  }

  function buildTarget(data, mode) {
    if (mode === 'text') {
      var lines = data.title ? [data.title] : [];
      data.links.forEach(function (l) {
        lines.push(l.label ? l.label + ': ' + l.url : l.url);
      });
      return lines.join('\n');
    }
    return appBaseUrl() + '#' + HASH_KEY + encodeData(data);
  }

  function makeQr(text, level) {
    var qr = qrcode(0, level || 'M');
    qr.addData(text, 'Byte');
    qr.make();
    return qr;
  }

  // ---- Logo in the centre of the code ----

  var LOGO_BOX = 0.26;   // white backing, share of the code width
  var LOGO_IMG = 0.2;    // the picture itself

  // Strongest error correction that still fits the data, so a covered centre still scans.
  function makeQrWithLogo(text, hasLogo) {
    // Short payloads can afford the strongest correction; long ones need a smaller grid to stay scannable.
    var levels = !hasLogo ? ['M'] : text.length > 300 ? ['Q', 'M'] : ['H', 'Q', 'M'];
    var lastErr;
    for (var i = 0; i < levels.length; i++) {
      try { return makeQr(text, levels[i]); } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }

  function addLogoToSvg(svg) {
    var m = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
    if (!m || !current.logo) return svg;
    var size = parseFloat(m[1]);
    var box = size * LOGO_BOX, img = size * LOGO_IMG;
    var bx = (size - box) / 2, ix = (size - img) / 2;
    var extra =
      '<defs><clipPath id="qrl-logo-clip"><rect x="' + ix + '" y="' + ix + '" width="' + img + '" height="' + img + '" rx="' + (img * 0.2) + '"/></clipPath></defs>' +
      '<rect x="' + bx + '" y="' + bx + '" width="' + box + '" height="' + box + '" rx="' + (box * 0.2) + '" fill="#fff"/>' +
      '<image href="' + current.logo + '" xlink:href="' + current.logo + '" x="' + ix + '" y="' + ix + '" width="' + img + '" height="' + img + '" preserveAspectRatio="xMidYMid slice" clip-path="url(#qrl-logo-clip)"/>';
    return svg.replace('<svg ', '<svg xmlns:xlink="http://www.w3.org/1999/xlink" ').replace(/<\/svg>\s*$/, extra + '</svg>');
  }

  function setLogoError(msg) {
    var el = document.getElementById('logo-error');
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  function setLogo(dataUrl, avatar) {
    current.logo = dataUrl || '';
    current.avatar = avatar || '';
    document.getElementById('logo-page-opt').hidden = !dataUrl;
    var thumb = document.getElementById('logo-thumb');
    var rm = document.getElementById('logo-remove');
    thumb.hidden = !dataUrl;
    rm.hidden = !dataUrl;
    document.getElementById('logo-preview').src = dataUrl || '';
    document.getElementById('logo-label').textContent = dataUrl ? 'Change image' : 'Choose image';
    render();
  }

  // A small copy for the scanned page. A QR code only holds a few kilobytes, so the picture is reduced to
  // a few colours on a small grid and compressed. The largest grid that still fits the budget wins.
  function makeAvatar(img, w, h, side) {
    if (!window.CompressionStream) return Promise.resolve('');
    var tries = [[64, 16], [56, 16], [48, 16], [48, 8], [40, 8], [32, 8], [24, 8], [16, 8]];
    var BUDGET = 560;
    var chain = Promise.resolve('');
    tries.forEach(function (t) {
      chain = chain.then(function (found) {
        if (found) return found;
        var size = t[0];
        var c = document.createElement('canvas');
        c.width = c.height = size;
        var x = c.getContext('2d');
        x.imageSmoothingQuality = 'high';
        x.fillStyle = '#fff';
        x.fillRect(0, 0, size, size);
        x.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size);
        var px = x.getImageData(0, 0, size, size).data;
        var pal = quantize(px, t[1]);
        var bpp = bitsFor(pal.length);
        var bytes = [size, pal.length];
        pal.forEach(function (col) { bytes.push(col[0], col[1], col[2]); });
        var packed = new Array(Math.ceil(size * size * bpp / 8));
        for (var z = 0; z < packed.length; z++) packed[z] = 0;
        for (var n = 0; n < size * size; n++) {
          var idx = nearest(pal, px[n * 4], px[n * 4 + 1], px[n * 4 + 2]);
          for (var b = 0; b < bpp; b++) {
            if ((idx >> (bpp - 1 - b)) & 1) {
              var bit = n * bpp + b;
              packed[bit >> 3] |= 1 << (7 - (bit & 7));
            }
          }
        }
        return pipeBytes(new Uint8Array(bytes.concat(packed)), new CompressionStream('deflate-raw')).then(function (zipped) {
          var enc = 'z' + bytesToB64url(zipped);
          return enc.length <= BUDGET ? enc : '';
        });
      });
    });
    return chain;
  }

  function nearest(pal, r, g, b) {
    var best = 0, bd = Infinity;
    for (var i = 0; i < pal.length; i++) {
      var dr = pal[i][0] - r, dg = pal[i][1] - g, db = pal[i][2] - b;
      var d = dr * dr + dg * dg + db * db;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  // Median cut: repeatedly split the colour group with the widest spread.
  function quantize(px, k) {
    var all = [];
    for (var i = 0; i < px.length; i += 4) all.push([px[i], px[i + 1], px[i + 2]]);
    var boxes = [all];
    function spread(box) {
      var lo = [255, 255, 255], hi = [0, 0, 0];
      box.forEach(function (c) { for (var ch = 0; ch < 3; ch++) { if (c[ch] < lo[ch]) lo[ch] = c[ch]; if (c[ch] > hi[ch]) hi[ch] = c[ch]; } });
      var best = 0, range = -1;
      for (var ch = 0; ch < 3; ch++) if (hi[ch] - lo[ch] > range) { range = hi[ch] - lo[ch]; best = ch; }
      return { ch: best, range: range };
    }
    while (boxes.length < k) {
      var pick = -1, score = 0;
      boxes.forEach(function (box, bi) {
        if (box.length < 2) return;
        var sc = spread(box).range * box.length;
        if (sc > score) { score = sc; pick = bi; }
      });
      if (pick === -1) break;
      var box = boxes[pick], ch = spread(box).ch;
      box.sort(function (p, q) { return p[ch] - q[ch]; });
      var mid = box.length >> 1;
      boxes.splice(pick, 1, box.slice(0, mid), box.slice(mid));
    }
    var pal = boxes.map(function (box) {
      var s = [0, 0, 0];
      box.forEach(function (c) { s[0] += c[0]; s[1] += c[1]; s[2] += c[2]; });
      return [Math.round(s[0] / box.length), Math.round(s[1] / box.length), Math.round(s[2] / box.length)];
    });
    while (pal.length < 2) pal.push(pal[0]);
    return pal;
  }

  // Crops to a square and shrinks, so the file stays small and the code stays readable.
  function loadLogo(file) {
    setLogoError('');
    if (!file) return;
    if (!/^image\//.test(file.type)) { setLogoError('That file is not an image. Choose a PNG, JPG, SVG or WebP.'); return; }
    if (file.size > 8 * 1024 * 1024) { setLogoError('That image is over 8 MB. Choose a smaller one.'); return; }
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      try {
        var side = Math.min(img.naturalWidth || img.width, img.naturalHeight || img.height) || 256;
        var out = 256;
        var canvas = document.createElement('canvas');
        canvas.width = canvas.height = out;
        var ctx = canvas.getContext('2d');
        var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        ctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, out, out);
        var full = canvas.toDataURL('image/png');
        makeAvatar(img, w, h, side).then(function (av) {
          if (av) storeSet(PREVIEW_PIC_KEY, JSON.stringify({ k: av, u: full }));
          setLogo(full, av);
        }).catch(function () {
          setLogo(full, '');
        }).then(function () { URL.revokeObjectURL(url); });
        return;
      } catch (e) {
        setLogoError('Could not read that image. Try another one.');
      }
      URL.revokeObjectURL(url);
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      setLogoError('Could not read that image. Try another one.');
    };
    img.src = url;
  }

  function setError(msg) {
    els.error.textContent = msg || '';
    els.error.hidden = !msg;
  }

  function render() {
    var collected = collectLinks();
    var data = { title: els.title.value.trim(), links: collected.links };
    if (current.logo && current.avatar && document.getElementById('logo-on-page').checked) data.avatar = current.avatar;
    var mode = document.querySelector('input[name="mode"]:checked').value;

    if (collected.invalid) {
      setError('Some links are not valid. Use http(s), mailto:, tel: or sms: links.');
    } else {
      setError('');
    }

    if (!data.links.length) {
      els.result.hidden = true;
      return;
    }

    var target = buildTarget(data, mode);
    var qr;
    try {
      qr = makeQrWithLogo(target, !!current.logo);
    } catch (e) {
      els.result.hidden = true;
      setError('Too much data for one QR code. Remove some links, shorten labels, or turn off the picture on the scanned page.');
      return;
    }

    current.svg = addLogoToSvg(qr.createSvgTag({ cellSize: 8, margin: 4, scalable: true }));
    current.target = target;
    current.qr = qr;
    current.filename = (data.title || 'qr-code').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'qr-code';

    els.qr.innerHTML = current.svg;
    els.result.hidden = false;

    var isPage = mode === 'page';
    els.openLink.hidden = !isPage;
    els.copyLink.hidden = !isPage;
    if (isPage) els.openLink.href = target;
    els.fileWarning.hidden = !(isPage && location.protocol === 'file:');
    els.meta.textContent = data.links.length + (data.links.length === 1 ? ' link' : ' links') +
      ' · ' + qr.getModuleCount() + '×' + qr.getModuleCount() + ' modules';
  }

  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 150);
  }

  function download(href, filename) {
    var a = document.createElement('a');
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function downloadPng() {
    var qr = current.qr;
    if (!qr) return;
    var cell = 10, margin = 4;
    var count = qr.getModuleCount();
    var size = (count + margin * 2) * cell;
    var canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000';
    for (var r = 0; r < count; r++) {
      for (var c = 0; c < count; c++) {
        if (qr.isDark(r, c)) ctx.fillRect((c + margin) * cell, (r + margin) * cell, cell, cell);
      }
    }
    function finish() { download(canvas.toDataURL('image/png'), current.filename + '.png'); }
    if (!current.logo) { finish(); return; }
    var box = size * LOGO_BOX, side = size * LOGO_IMG;
    var bx = (size - box) / 2, ix = (size - side) / 2;
    var logo = new Image();
    logo.onload = function () {
      ctx.fillStyle = '#fff';
      roundRect(ctx, bx, bx, box, box, box * 0.2);
      ctx.fill();
      ctx.save();
      roundRect(ctx, ix, ix, side, side, side * 0.2);
      ctx.clip();
      ctx.drawImage(logo, ix, ix, side, side);
      ctx.restore();
      finish();
    };
    logo.src = current.logo;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function downloadSvg() {
    if (!current.svg) return;
    var blob = new Blob([current.svg], { type: 'image/svg+xml' });
    var url = URL.createObjectURL(blob);
    download(url, current.filename + '.svg');
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function copyLink() {
    var btn = els.copyLink;
    navigator.clipboard.writeText(current.target).then(function () {
      btn.textContent = 'Copied!';
    }, function () {
      btn.textContent = 'Copy failed';
    }).then(function () {
      setTimeout(function () { btn.textContent = 'Copy link'; }, 1500);
    });
  }

  function showBuilder() {
    if (els.links) {
      document.getElementById('landing').hidden = true;
      document.getElementById('builder').hidden = false;
      return;
    }
    ['title', 'links', 'error', 'result', 'qr', 'meta'].forEach(function (id) {
      els[id] = document.getElementById(id);
    });
    els.addLink = document.getElementById('add-link');
    els.openLink = document.getElementById('open-link');
    els.copyLink = document.getElementById('copy-link');
    els.fileWarning = document.getElementById('file-warning');

    addRow();
    addRow();

    els.addLink.addEventListener('click', function () {
      addRow().querySelector('.url').focus();
    });
    document.getElementById('builder').addEventListener('input', scheduleRender);
    document.getElementById('builder').addEventListener('change', scheduleRender);
    document.getElementById('logo-input').addEventListener('change', function (e) {
      loadLogo(e.target.files && e.target.files[0]);
      e.target.value = '';
    });
    document.getElementById('logo-remove').addEventListener('click', function () { setLogoError(''); setLogo(''); });
    document.getElementById('download-png').addEventListener('click', downloadPng);
    document.getElementById('download-svg').addEventListener('click', downloadSvg);
    els.copyLink.addEventListener('click', copyLink);

    document.getElementById('landing').hidden = true;
    document.getElementById('builder').hidden = false;
  }

  // ---- Boot ----

  function route() {
    var hash = location.hash.slice(1);
    if (hash.indexOf(HASH_KEY) === 0) {
      try {
        var data = decodeData(hash.slice(HASH_KEY.length));
        if (data.links.length) return showLanding(data);
      } catch (e) { /* fall through to the builder */ }
    }
    if (hash === 'signin' || hash === 'signup') return showAuth(hash);
    if (hash === 'home') return showHome();
    if (!getSession()) return showHome();
    enterApp();
  }

  window.addEventListener('hashchange', function () { location.reload(); });
  route();
})();
