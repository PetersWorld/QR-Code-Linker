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
    return toBase64Url(JSON.stringify({ t: data.title, l: data.links.map(function (l) { return [l.label, l.url]; }) }));
  }

  function decodeData(encoded) {
    var raw = JSON.parse(fromBase64Url(encoded));
    if (!raw || !Array.isArray(raw.l)) throw new Error('Invalid data');
    return {
      title: typeof raw.t === 'string' ? raw.t : '',
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

  function authError(form, msg) {
    var el = form.querySelector('.error');
    el.textContent = msg || '';
    el.hidden = !msg;
  }
  function setBusy(form, busy) {
    var btn = form.querySelector('button[type="submit"]');
    btn.disabled = busy;
  }

  function signUp(form) {
    var name = form.name.value.trim();
    var email = form.email.value.trim().toLowerCase();
    var pw = form.password.value;
    if (!name) return authError(form, 'Enter your name.');
    if (!isEmail(email)) return authError(form, 'Enter a valid email address.');
    if (pw.length < 8) return authError(form, 'Password must be at least 8 characters.');
    if (pw !== form.confirm.value) return authError(form, 'Passwords do not match.');
    var users = loadUsers();
    if (users[email]) return authError(form, 'An account with this email already exists. Try signing in.');
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
    if (!email || !pw) return authError(form, 'Enter your email and password.');
    authError(form, '');
    setBusy(form, true);
    var user = loadUsers()[email];
    // Hash even for unknown emails so timing doesn't reveal which accounts exist.
    hashPassword(pw, user ? user.salt : null).then(function (h) {
      if (!user || h.hash !== user.hash) return authError(form, 'Incorrect email or password.');
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
    });
  }

  var authReady = false;
  function initAuth() {
    if (authReady) return;
    authReady = true;
    ['signin', 'signup'].forEach(function (name, i) {
      var tab = document.getElementById('tab-' + name);
      tab.addEventListener('click', function () { selectTab(name); });
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
        btn.textContent = show ? 'Hide' : 'Show';
        btn.setAttribute('aria-pressed', String(show));
        btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      });
    });
    document.getElementById('sign-out').addEventListener('click', function () {
      storeRemove(SESSION_KEY);
      showAuth();
    });
  }

  function showAuth() {
    initAuth();
    document.getElementById('builder').hidden = true;
    document.getElementById('landing').hidden = true;
    document.getElementById('auth').hidden = false;
    document.title = 'Sign in · QR Code Linker';
    selectTab('signin');
    window.scrollTo(0, 0);
  }

  // Shows the editor when signed in, otherwise the sign in / sign up screen.
  function enterApp() {
    initAuth();
    var session = getSession();
    if (!session) return showAuth();
    document.getElementById('auth').hidden = true;
    document.getElementById('user-name').textContent = loadUsers()[session.email].name || session.email;
    showBuilder();
    document.title = 'QR Code Linker';
    window.scrollTo(0, 0);
  }

  // ---- Landing view ----

  function showLanding(data) {
    var title = data.title || 'Links';
    document.title = title;
    document.getElementById('landing-title').textContent = title;
    var list = document.getElementById('landing-links');
    list.textContent = '';
    data.links.forEach(function (link) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = link.url;
      a.rel = 'noopener noreferrer';
      a.textContent = displayLabel(link);
      li.appendChild(a);
      list.appendChild(li);
    });
    document.getElementById('builder').hidden = true;
    document.getElementById('auth').hidden = true;
    document.getElementById('landing').hidden = false;
  }

  // ---- Builder view ----

  var els = {};
  var current = { svg: '', target: '', filename: 'qr-code' };
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

  function makeQr(text) {
    var qr = qrcode(0, 'M');
    qr.addData(text, 'Byte');
    qr.make();
    return qr;
  }

  function setError(msg) {
    els.error.textContent = msg || '';
    els.error.hidden = !msg;
  }

  function render() {
    var collected = collectLinks();
    var data = { title: els.title.value.trim(), links: collected.links };
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
      qr = makeQr(target);
    } catch (e) {
      els.result.hidden = true;
      setError('Too much data for one QR code. Remove some links or shorten labels.');
      return;
    }

    current.svg = qr.createSvgTag({ cellSize: 8, margin: 4, scalable: true });
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
    download(canvas.toDataURL('image/png'), current.filename + '.png');
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
    enterApp();
  }

  window.addEventListener('hashchange', function () { location.reload(); });
  route();
})();
