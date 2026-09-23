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
    if (!els.links) showBuilder();
  }

  window.addEventListener('hashchange', function () { location.reload(); });
  route();
})();
