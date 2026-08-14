/* Krova Pricing Portal — application logic
 *
 * Everything runs in the browser: matrices are parsed client-side and kept in
 * IndexedDB, so supplier pricing never leaves the machine and the portal works
 * offline once loaded.
 */
(function () {
  'use strict';

  var P = window.MatrixParser;
  var CORE_TERMS = [12, 24, 36, 48, 60];
  var ROW_RENDER_CAP = 600;

  /* ================= dom helpers ================= */

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var toastTimer = null;
  function toast(msg, bad) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'on' + (bad ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = ''; }, bad ? 6000 : 3000);
  }

  function num(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }

  function money(n) {
    if (n === null || !isFinite(n)) return '—';
    return '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function download(filename, content, type) {
    var blob = new Blob([content], { type: type || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* ================= storage ================= */

  var Store = (function () {
    var NAME = 'krova-pricing', VER = 1;
    var dbp = null, mem = null;
    var KEYPATH = { sets: 'id', rows: 'setId', kv: 'k' };

    function useMemory(reason) {
      if (!mem) {
        mem = { sets: {}, rows: {}, kv: {} };
        Store.memoryOnly = true;
        Store.memoryReason = reason || '';
      }
      return null;
    }

    function open() {
      if (mem) return Promise.resolve(null);
      if (dbp) return dbp;
      dbp = new Promise(function (res, rej) {
        var req;
        try { req = indexedDB.open(NAME, VER); }
        catch (e) { return rej(e); }
        req.onupgradeneeded = function () {
          var db = req.result;
          Object.keys(KEYPATH).forEach(function (s) {
            if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: KEYPATH[s] });
          });
        };
        req.onsuccess = function () { res(req.result); };
        req.onerror = function () { rej(req.error || new Error('indexedDB error')); };
        req.onblocked = function () { rej(new Error('indexedDB blocked')); };
      }).catch(function (e) { return useMemory(e && e.message); });
      return dbp;
    }

    function all(name) {
      return open().then(function (db) {
        if (!db) return Object.keys(mem[name]).map(function (k) { return mem[name][k]; });
        return new Promise(function (res, rej) {
          var t = db.transaction(name, 'readonly');
          var r = t.objectStore(name).getAll();
          r.onsuccess = function () { res(r.result || []); };
          r.onerror = function () { rej(r.error); };
        });
      });
    }

    function put(name, obj) {
      return open().then(function (db) {
        if (!db) { mem[name][obj[KEYPATH[name]]] = obj; return; }
        return new Promise(function (res, rej) {
          var t = db.transaction(name, 'readwrite');
          t.objectStore(name).put(obj);
          t.oncomplete = function () { res(); };
          t.onerror = function () { rej(t.error); };
          t.onabort = function () { rej(t.error || new Error('write aborted')); };
        });
      });
    }

    function del(name, key) {
      return open().then(function (db) {
        if (!db) { delete mem[name][key]; return; }
        return new Promise(function (res, rej) {
          var t = db.transaction(name, 'readwrite');
          t.objectStore(name).delete(key);
          t.oncomplete = function () { res(); };
          t.onerror = function () { rej(t.error); };
        });
      });
    }

    function clear(name) {
      return open().then(function (db) {
        if (!db) { mem[name] = {}; return; }
        return new Promise(function (res, rej) {
          var t = db.transaction(name, 'readwrite');
          t.objectStore(name).clear();
          t.oncomplete = function () { res(); };
          t.onerror = function () { rej(t.error); };
        });
      });
    }

    return { all: all, put: put, del: del, clear: clear, memoryOnly: false, memoryReason: '' };
  })();

  /* ================= app state ================= */

  var app = {
    sets: [],
    quotes: [],
    mappings: {},
    view: 'quote',
    sort: { key: 'price', dir: 1 },
    pending: [],
    mapCtx: null,
    adder: 0,
    dispUnit: 'usd',
    showTerms: CORE_TERMS.slice()
  };

  /* ================= pricing helpers ================= */

  function effective(usdPerKwh) { return usdPerKwh + app.adder / 1000; }

  function rateText(usdPerKwh) {
    var v = effective(usdPerKwh);
    return app.dispUnit === 'cents' ? (v * 100).toFixed(3) : v.toFixed(5);
  }

  function rateUnitLabel() { return app.dispUnit === 'cents' ? '¢/kWh' : '$/kWh'; }

  function bandLabel(min, max) {
    if (min === 0 && (max === Infinity || max === null)) return 'All';
    var lo = num(min);
    var hi = (max === Infinity || max === null) ? '+' : num(max);
    return hi === '+' ? lo + '+' : lo + '–' + hi;
  }

  /* Sweet spot = cheapest term available on a line. If it also undercuts the
   * next shorter and next longer available term it is a true dip in the curve,
   * which is the one worth leading with. */
  function sweetSpot(termMap) {
    var terms = Object.keys(termMap).map(Number).sort(function (a, b) { return a - b; });
    if (!terms.length) return null;
    var best = terms[0];
    terms.forEach(function (t) { if (termMap[t] < termMap[best]) best = t; });
    var i = terms.indexOf(best);
    var isDip = i > 0 && i < terms.length - 1 &&
      termMap[best] < termMap[terms[i - 1]] && termMap[best] < termMap[terms[i + 1]];
    return { term: best, price: termMap[best], isDip: isDip, offCore: CORE_TERMS.indexOf(best) < 0 };
  }

  /* ================= filters ================= */

  function readFilters() {
    var usage = parseFloat($('fUsage').value);
    var maxP = parseFloat($('fMaxPrice').value);
    var sup = [];
    Array.prototype.forEach.call($('fSuppliers').querySelectorAll('input:checked'), function (i) {
      sup.push(i.value);
    });
    return {
      state: $('fState').value,
      utility: $('fUtility').value,
      zone: $('fZone').value,
      rate: $('fRate').value,
      start: $('fStart').value,
      usage: isFinite(usage) ? usage : null,
      maxPrice: isFinite(maxP) ? maxP : null,
      suppliers: sup
    };
  }

  function matches(q, f, skip) {
    if (f.state && q.state !== f.state) return false;
    if (skip !== 'utility' && f.utility && q.utility !== f.utility) return false;
    if (skip !== 'zone' && f.zone && q.zone !== f.zone) return false;
    if (skip !== 'rate' && f.rate && q.rateCode !== f.rate) return false;
    if (skip !== 'start' && f.start && q.startMonth !== f.start) return false;
    if (f.suppliers.length && f.suppliers.indexOf(q.supplier) < 0) return false;
    if (f.usage !== null && !(q.usageMin <= f.usage && f.usage <= q.usageMax)) return false;
    // the cap is typed in whichever unit is on display
    if (f.maxPrice !== null) {
      var cap = app.dispUnit === 'cents' ? f.maxPrice / 100 : f.maxPrice;
      if (effective(q.price) > cap) return false;
    }
    return true;
  }

  function currentRows() {
    var f = readFilters();
    return app.quotes.filter(function (q) { return matches(q, f); });
  }

  function distinctValues(key, f, skip) {
    var seen = Object.create(null);
    app.quotes.forEach(function (q) {
      if (f && !matches(q, f, skip)) return;
      var v = q[key];
      if (v) seen[v] = 1;
    });
    return Object.keys(seen).sort();
  }

  function fillSelect(sel, values, allLabel) {
    var prev = sel.value;
    var html = '<option value="">' + esc(allLabel) + '</option>';
    values.forEach(function (v) { html += '<option value="' + esc(v) + '">' + esc(v) + '</option>'; });
    sel.innerHTML = html;
    if (values.indexOf(prev) >= 0) sel.value = prev;
  }

  function populateFilters() {
    var f = readFilters();
    $('lblMaxPrice').textContent = 'Max rate (' + rateUnitLabel() + ')';
    $('fMaxPrice').step = app.dispUnit === 'cents' ? '0.01' : '0.001';
    fillSelect($('fState'), distinctValues('state', null), 'All states');
    fillSelect($('fUtility'), distinctValues('utility', f, 'utility'), 'All utilities');
    fillSelect($('fZone'), distinctValues('zone', f, 'zone'), 'All zones');
    fillSelect($('fRate'), distinctValues('rateCode', f, 'rate'), 'All rate codes');
    fillSelect($('fStart'), distinctValues('startMonth', f, 'start'), 'All start months');

    // suppliers
    var sups = distinctValues('supplier', null);
    var checked = {};
    Array.prototype.forEach.call($('fSuppliers').querySelectorAll('input:checked'), function (i) {
      checked[i.value] = 1;
    });
    $('fSuppliers').innerHTML = sups.length
      ? sups.map(function (s) {
        return '<label><input type="checkbox" value="' + esc(s) + '"' +
          (checked[s] ? ' checked' : '') + '/> ' + esc(s) + '</label>';
      }).join('')
      : '<div class="hint" style="padding:9px">No suppliers loaded</div>';

    // term chips
    var terms = {};
    app.quotes.forEach(function (q) { terms[q.term] = 1; });
    var list = Object.keys(terms).map(Number).sort(function (a, b) { return a - b; });
    if (!list.length) list = CORE_TERMS.slice();
    $('fTerms').innerHTML = list.map(function (t) {
      var on = app.showTerms.indexOf(t) >= 0;
      return '<button class="chip" data-term="' + t + '" aria-pressed="' + on + '">' + t + '</button>';
    }).join('');
  }

  /* ================= views ================= */

  function groupQuotes(rows) {
    var groups = Object.create(null);
    rows.forEach(function (q) {
      var key = [q.supplier, q.state, q.utility, q.zone, q.rateCode,
        q.usageMin, q.usageMax, q.startMonth, q.product, q.green].join('¦');
      var g = groups[key];
      if (!g) {
        g = groups[key] = { meta: q, terms: Object.create(null) };
      }
      // duplicate term rows can appear across sheets — keep the cheaper
      if (g.terms[q.term] === undefined || q.price < g.terms[q.term]) g.terms[q.term] = q.price;
    });
    return Object.keys(groups).map(function (k) {
      var g = groups[k];
      g.sweet = sweetSpot(g.terms);
      return g;
    });
  }

  function renderQuoteView(rows) {
    var groups = groupQuotes(rows);
    if (!groups.length) return renderEmpty();

    groups.sort(function (a, b) {
      var pa = a.sweet ? a.sweet.price : Infinity;
      var pb = b.sweet ? b.sweet.price : Infinity;
      return pa - pb;
    });

    var shown = app.showTerms.slice().sort(function (a, b) { return a - b; });
    var f = readFilters();

    // best price per term column, for highlighting
    var bestByTerm = {};
    groups.forEach(function (g) {
      shown.forEach(function (t) {
        var p = g.terms[t];
        if (p === undefined) return;
        if (bestByTerm[t] === undefined || p < bestByTerm[t]) bestByTerm[t] = p;
      });
    });

    var head = '<tr><th>Supplier</th><th>Utility / Zone</th><th>Rate code</th>' +
      '<th>Usage band</th><th>Start</th>' +
      shown.map(function (t) { return '<th class="num">' + t + ' mo</th>'; }).join('') +
      '<th class="num">Sweet spot</th></tr>';

    var body = groups.map(function (g) {
      var m = g.meta;
      var cells = shown.map(function (t) {
        var p = g.terms[t];
        if (p === undefined) return '<td class="num muted">—</td>';
        var cls = 'num price' + (bestByTerm[t] === p ? ' best' : '');
        return '<td class="' + cls + '">' + rateText(p) + '</td>';
      }).join('');

      var sweetCell = '<td class="num muted">—</td>';
      if (g.sweet) {
        var badge = '<span class="badge">' + g.sweet.term + ' mo</span>';
        if (g.sweet.isDip) badge += ' <span class="badge dip">dip</span>';
        var sub = '';
        if (f.usage !== null) {
          sub = '<span class="cell-sub">' + money(f.usage * effective(g.sweet.price)) + '/yr</span>';
        }
        sweetCell = '<td class="num"><span class="price">' + rateText(g.sweet.price) + '</span> ' +
          badge + sub + '</td>';
      }

      return '<tr>' +
        '<td>' + esc(m.supplier) + '<span class="cell-sub">' + esc(m.priceDate || '') + '</span></td>' +
        '<td>' + esc(m.utility || '—') + (m.zone ? '<span class="cell-sub">' + esc(m.zone) + '</span>' : '') + '</td>' +
        '<td>' + esc(m.rateCode || '—') + '</td>' +
        '<td>' + esc(bandLabel(m.usageMin, m.usageMax)) + '</td>' +
        '<td>' + esc(m.startMonth || '—') + '</td>' +
        cells + sweetCell + '</tr>';
    }).join('');

    $('count').textContent = groups.length.toLocaleString() + ' quote lines · rates in ' + rateUnitLabel();
    $('view').innerHTML = '<div class="tablewrap"><table><thead>' + head +
      '</thead><tbody>' + body + '</tbody></table></div>';
  }

  var ROW_COLS = [
    { key: 'supplier', label: 'Supplier' },
    { key: 'state', label: 'State' },
    { key: 'utility', label: 'Utility' },
    { key: 'zone', label: 'Zone' },
    { key: 'rateCode', label: 'Rate code' },
    { key: 'band', label: 'Usage band' },
    { key: 'startMonth', label: 'Start' },
    { key: 'term', label: 'Term', num: true },
    { key: 'price', label: 'Rate', num: true }
  ];

  function renderRowsView(rows) {
    if (!rows.length) return renderEmpty();

    var sorted = rows.slice().sort(function (a, b) {
      var k = app.sort.key, d = app.sort.dir;
      var va = k === 'band' ? a.usageMin : a[k];
      var vb = k === 'band' ? b.usageMin : b[k];
      if (typeof va === 'string' || typeof vb === 'string') {
        return String(va).localeCompare(String(vb)) * d;
      }
      return ((va || 0) - (vb || 0)) * d;
    });

    var capped = sorted.slice(0, ROW_RENDER_CAP);
    var f = readFilters();

    var head = '<tr>' + ROW_COLS.map(function (c) {
      var arrow = app.sort.key === c.key ? (app.sort.dir === 1 ? ' ▲' : ' ▼') : '';
      return '<th' + (c.num ? ' class="num"' : '') + ' data-sort="' + c.key +
        '" style="cursor:pointer">' + esc(c.label) + arrow + '</th>';
    }).join('') + (f.usage !== null ? '<th class="num">Annual cost</th>' : '') + '</tr>';

    var body = capped.map(function (q) {
      return '<tr>' +
        '<td>' + esc(q.supplier) + '</td>' +
        '<td>' + esc(q.state || '—') + '</td>' +
        '<td>' + esc(q.utility || '—') + '</td>' +
        '<td>' + esc(q.zone || '—') + '</td>' +
        '<td>' + esc(q.rateCode || '—') + '</td>' +
        '<td>' + esc(bandLabel(q.usageMin, q.usageMax)) + '</td>' +
        '<td>' + esc(q.startMonth || '—') + '</td>' +
        '<td class="num">' + q.term + '</td>' +
        '<td class="num price">' + rateText(q.price) + '</td>' +
        (f.usage !== null ? '<td class="num">' + money(f.usage * effective(q.price)) + '</td>' : '') +
        '</tr>';
    }).join('');

    var note = sorted.length > capped.length
      ? '<div class="hint" style="padding:9px 11px">Showing the first ' + num(capped.length) +
        ' of ' + num(sorted.length) + ' rows — narrow the filters or export CSV for the full set.</div>'
      : '';

    $('count').textContent = sorted.length.toLocaleString() + ' rows · rates in ' + rateUnitLabel();
    $('view').innerHTML = '<div class="tablewrap"><table><thead>' + head +
      '</thead><tbody>' + body + '</tbody></table>' + note + '</div>';
  }

  function renderEmpty() {
    var hasData = app.quotes.length > 0;
    $('count').textContent = '0';
    $('view').innerHTML = '<div class="tablewrap"><div class="empty">' +
      (hasData
        ? '<h3>Nothing matches these filters</h3><div>Loosen a filter, or reset them to start over.</div>'
        : '<h3>No pricing loaded yet</h3><div>Import today&rsquo;s matrix files to begin.</div>') +
      '</div></div>';
  }

  function render() {
    populateFilters();
    var rows = currentRows();
    if (app.view === 'quote') renderQuoteView(rows);
    else renderRowsView(rows);
    renderDatePill();
  }

  function renderDatePill() {
    var pill = $('datePill');
    if (!app.sets.length) {
      pill.className = 'pill';
      pill.textContent = 'No pricing loaded';
      return;
    }
    var dates = app.sets.map(function (s) { return s.priceDate; }).filter(Boolean).sort();
    var latest = dates.length ? dates[dates.length - 1] : '';
    var today = new Date().toISOString().slice(0, 10);
    var files = app.sets.length + (app.sets.length === 1 ? ' file' : ' files');
    if (!latest) {
      pill.className = 'pill';
      pill.textContent = files + ' loaded · no date';
    } else if (latest >= today) {
      pill.className = 'pill ok';
      pill.textContent = files + ' · priced ' + latest;
    } else {
      pill.className = 'pill warn';
      pill.textContent = files + ' · newest is ' + latest + ' — stale';
    }
  }

  /* ================= import ================= */

  function normalizeDates(rows) {
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r) continue;
      for (var j = 0; j < r.length; j++) {
        var v = r[j];
        if (v instanceof Date && !isNaN(v.getTime())) {
          r[j] = v.getFullYear() + '-' + String(v.getMonth() + 1).padStart(2, '0');
        }
      }
    }
    return rows;
  }

  function planFor(rows, sheetName) {
    var plan = P.analyzeSheet(rows, sheetName);
    var saved = plan.signature && app.mappings[plan.signature];
    if (saved && plan.headerRow >= 0) {
      (saved.columns || []).forEach(function (sc) {
        var c = plan.columns[sc.index];
        if (c) { c.role = sc.role; c.term = sc.term; c.band = sc.band; }
      });
      if (saved.priceUnit) plan.priceUnit = saved.priceUnit;
      P.refreshPlan(rows, plan);
      if (saved.layout && saved.layout !== 'unknown') { plan.layout = saved.layout; plan.ok = true; }
      plan.fromSaved = true;
    }
    return plan;
  }

  function readWorkbook(file) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onerror = function () { rej(new Error('could not read file')); };
      fr.onload = function () {
        try {
          var wb = XLSX.read(new Uint8Array(fr.result), { type: 'array', cellDates: true });
          var meta = P.parseFileMeta(file.name);
          if (!meta.supplier) meta.supplier = meta.fallbackName || 'Unknown';
          var sheets = wb.SheetNames.map(function (name) {
            var rows = normalizeDates(
              XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' })
            );
            var plan = planFor(rows, name);
            return { name: name, rows: rows, plan: plan, include: !!plan.ok };
          });
          res({ filename: file.name, meta: meta, sheets: sheets });
        } catch (e) { rej(e); }
      };
      fr.readAsArrayBuffer(file);
    });
  }

  function handleFiles(fileList) {
    var files = Array.prototype.slice.call(fileList);
    if (!files.length) return;
    openModal('importModal');
    $('importSummary').textContent = 'Reading ' + files.length + ' file(s)…';

    var chain = Promise.resolve();
    files.forEach(function (f) {
      chain = chain.then(function () {
        return readWorkbook(f).then(function (entry) {
          app.pending.push(entry);
          renderImportList();
        }).catch(function (e) {
          toast('Could not read ' + f.name + ': ' + e.message, true);
        });
      });
    });
    chain.then(renderImportList);
  }

  function termSummary(plan) {
    if (plan.layout === 'wide') {
      var ts = plan.columns.filter(function (c) { return c.role === 'termPrice' && c.term; })
        .map(function (c) { return c.term; });
      return ts.length ? ts.join(' / ') + ' mo' : '';
    }
    if (plan.layout === 'bandwide') {
      var bs = plan.columns.filter(function (c) { return c.role === 'bandPrice' && c.band; });
      return bs.length + ' usage bands';
    }
    return 'term column';
  }

  function unitLabel(id) {
    for (var i = 0; i < P.PRICE_UNITS.length; i++) {
      if (P.PRICE_UNITS[i].id === id) return P.PRICE_UNITS[i].label;
    }
    return id;
  }

  function renderImportList() {
    var host = $('importList');
    if (!app.pending.length) {
      host.innerHTML = '';
      $('importConfirm').disabled = true;
      $('importSummary').textContent = '';
      return;
    }

    host.innerHTML = app.pending.map(function (entry, fi) {
      var sheets = entry.sheets.map(function (sh, si) {
        var p = sh.plan;
        var info = p.ok
          ? '<span class="status-ok">' + esc(p.layout) + '</span> · header row ' + (p.headerRow + 1) +
            ' · ' + num(p.rowCount) + ' rows · ' + esc(unitLabel(p.priceUnit)) +
            (termSummary(p) ? ' · ' + esc(termSummary(p)) : '') +
            (p.fromSaved ? ' · <span class="status-ok">saved mapping</span>' : '')
          : '<span class="status-bad">' + esc(p.reason || 'not recognised') + '</span>';
        return '<div class="sheetrow">' +
          '<label><input type="checkbox" data-act="include" data-fi="' + fi + '" data-si="' + si + '"' +
          (sh.include ? ' checked' : '') + '/> <span class="sname">' + esc(sh.name) + '</span></label>' +
          '<span class="sinfo">' + info + '</span>' +
          '<button class="btn sm" data-act="map" data-fi="' + fi + '" data-si="' + si + '">Map columns</button>' +
          '</div>';
      }).join('');

      return '<div class="filecard">' +
        '<div class="fc-head">' +
          '<span class="fname">' + esc(entry.filename) + '</span>' +
          '<span class="pill">' + entry.sheets.length + ' sheet(s)</span>' +
          '<div class="spacer"></div>' +
          '<button class="btn ghost sm" data-act="removeFile" data-fi="' + fi + '">Remove</button>' +
        '</div>' +
        '<div class="fc-meta">' +
          '<div><span class="flabel">Supplier</span>' +
            '<input type="text" data-act="supplier" data-fi="' + fi + '" value="' + esc(entry.meta.supplier) +
            '" placeholder="Supplier name" /></div>' +
          '<div><span class="flabel">Price date</span>' +
            '<input type="date" data-act="date" data-fi="' + fi + '" value="' + esc(entry.meta.priceDate) + '" /></div>' +
          '<div><span class="flabel">State (if missing)</span>' +
            '<input type="text" data-act="state" data-fi="' + fi + '" value="' + esc(entry.meta.state) +
            '" placeholder="e.g. TX" maxlength="2" /></div>' +
        '</div>' + sheets + '</div>';
    }).join('');

    var willLoad = 0;
    app.pending.forEach(function (e) {
      e.sheets.forEach(function (s) { if (s.include && s.plan.ok) willLoad++; });
    });
    $('importConfirm').disabled = willLoad === 0;
    $('importSummary').textContent = willLoad
      ? willLoad + ' sheet(s) ready to load'
      : 'No sheets recognised yet — use “Map columns” to set them up.';
  }

  function confirmImport() {
    var ops = [], added = 0, sets = 0;

    app.pending.forEach(function (entry) {
      var rows = [];
      entry.sheets.forEach(function (sh) {
        if (!sh.include || !sh.plan.ok) return;
        rows = rows.concat(P.extractRows(sh.rows, sh.plan, {
          supplier: entry.meta.supplier || 'Unknown',
          state: entry.meta.state || '',
          priceDate: entry.meta.priceDate || ''
        }));
      });
      if (!rows.length) return;

      var id = entry.filename + '::' + (entry.meta.priceDate || 'nodate');
      var set = {
        id: id, filename: entry.filename,
        supplier: entry.meta.supplier || 'Unknown',
        priceDate: entry.meta.priceDate || '',
        importedAt: new Date().toISOString(),
        rowCount: rows.length
      };
      rows.forEach(function (r) { r.setId = id; r.priceDate = set.priceDate; });

      ops.push(Store.put('sets', set));
      ops.push(Store.put('rows', { setId: id, rows: rows }));

      app.sets = app.sets.filter(function (s) { return s.id !== id; }).concat([set]);
      app.quotes = app.quotes.filter(function (q) { return q.setId !== id; }).concat(rows);
      added += rows.length;
      sets++;
    });

    if (!sets) { toast('Nothing to load — no sheets were recognised.', true); return; }

    Promise.all(ops).then(function () {
      app.pending = [];
      renderImportList();
      closeModal('importModal');
      render();
      toast(num(added) + ' prices loaded from ' + sets + ' file(s)');
    }).catch(function (e) {
      toast('Loaded in memory, but saving failed: ' + e.message, true);
      app.pending = [];
      renderImportList();
      closeModal('importModal');
      render();
    });
  }

  /* ================= column mapping ================= */

  function openMapper(fi, si) {
    app.mapCtx = { fi: fi, si: si };
    var sh = app.pending[fi].sheets[si];
    $('mapSheetName').textContent = app.pending[fi].filename + ' → ' + sh.name;
    $('mapHeaderRow').value = (sh.plan.headerRow >= 0 ? sh.plan.headerRow : 0) + 1;
    $('mapUnit').innerHTML = P.PRICE_UNITS.map(function (u) {
      return '<option value="' + u.id + '"' + (u.id === sh.plan.priceUnit ? ' selected' : '') + '>' +
        esc(u.label) + '</option>';
    }).join('');
    $('mapLayout').value = sh.plan.layout === 'unknown' ? 'wide' : sh.plan.layout;
    renderMapTable();
    openModal('mapModal');
  }

  function currentMapSheet() {
    if (!app.mapCtx) return null;
    return app.pending[app.mapCtx.fi].sheets[app.mapCtx.si];
  }

  function renderMapTable() {
    var sh = currentMapSheet();
    if (!sh) return;
    var plan = sh.plan;

    var rowsHtml = plan.columns.map(function (c) {
      var opts = P.ROLES.map(function (r) {
        return '<option value="' + r.id + '"' + (r.id === c.role ? ' selected' : '') + '>' +
          esc(r.label) + '</option>';
      }).join('');
      var extra = '';
      if (c.role === 'termPrice') {
        extra = '<input type="number" min="1" max="72" data-act="colTerm" data-i="' + c.index +
          '" value="' + (c.term || '') + '" style="width:66px" placeholder="mo" />';
      } else if (c.role === 'bandPrice') {
        extra = '<input type="number" data-act="colBandMin" data-i="' + c.index + '" value="' +
          (c.band ? c.band[0] : '') + '" style="width:92px" placeholder="min" /> ' +
          '<input type="number" data-act="colBandMax" data-i="' + c.index + '" value="' +
          (c.band && isFinite(c.band[1]) ? c.band[1] : '') + '" style="width:92px" placeholder="max" />';
      }
      return '<tr><td class="muted">' + c.index + '</td><td>' + esc(c.label || '(blank)') + '</td>' +
        '<td><select data-act="colRole" data-i="' + c.index + '">' + opts + '</select></td>' +
        '<td>' + extra + '</td></tr>';
    }).join('');

    $('mapTable').innerHTML = '<table><thead><tr><th>#</th><th>Header</th><th>Role</th><th></th></tr></thead>' +
      '<tbody>' + rowsHtml + '</tbody></table>';

    // live preview
    var preview = [];
    try { preview = P.extractRows(sh.rows, plan, { supplier: 'preview', state: '', priceDate: '' }); }
    catch (e) { preview = []; }

    $('mapStatus').innerHTML = plan.ok
      ? '<span class="status-ok">' + esc(plan.layout) + '</span> · ' + num(preview.length) + ' prices found'
      : '<span class="status-bad">' + esc(plan.reason || 'not recognised') + '</span>';

    if (preview.length) {
      var sample = preview.slice(0, 6);
      $('mapPreview').innerHTML = '<span class="flabel">Preview</span><div class="tablewrap"><table>' +
        '<thead><tr><th>Utility</th><th>Zone</th><th>Rate</th><th>Band</th>' +
        '<th class="num">Term</th><th class="num">$/kWh</th></tr></thead><tbody>' +
        sample.map(function (r) {
          return '<tr><td>' + esc(r.utility || '—') + '</td><td>' + esc(r.zone || '—') + '</td>' +
            '<td>' + esc(r.rateCode || '—') + '</td><td>' + esc(bandLabel(r.usageMin, r.usageMax)) + '</td>' +
            '<td class="num">' + r.term + '</td><td class="num price">' + r.price.toFixed(5) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    } else {
      $('mapPreview').innerHTML = '<div class="hint">No prices extracted with this mapping yet. ' +
        'Check the header row, then confirm which columns hold prices.</div>';
    }
  }

  function rebuildMapPlan() {
    var sh = currentMapSheet();
    if (!sh) return;
    var hr = Math.max(0, (parseInt($('mapHeaderRow').value, 10) || 1) - 1);
    sh.plan = P.buildPlan(sh.rows, hr, {
      sheetName: sh.name,
      layout: $('mapLayout').value,
      priceUnit: $('mapUnit').value
    });
    renderMapTable();
  }

  function saveMapping() {
    var sh = currentMapSheet();
    if (!sh) return;
    if (!sh.plan.ok) { toast('This mapping does not produce any prices yet.', true); return; }
    var record = {
      k: sh.plan.signature,
      signature: sh.plan.signature,
      headerRow: sh.plan.headerRow,
      layout: sh.plan.layout,
      priceUnit: sh.plan.priceUnit,
      columns: sh.plan.columns.map(function (c) {
        return { index: c.index, role: c.role, term: c.term, band: c.band };
      })
    };
    app.mappings[record.signature] = record;
    sh.include = true;
    Store.put('kv', { k: 'map:' + record.signature, value: record }).catch(function () {});
    closeModal('mapModal');
    renderImportList();
    toast('Mapping saved — matching sheets will parse automatically next time.');
  }

  /* ================= data manager ================= */

  function renderDataList() {
    var host = $('dataList');
    if (!app.sets.length) {
      host.innerHTML = '<div class="hint">Nothing loaded yet.</div>';
    } else {
      var sorted = app.sets.slice().sort(function (a, b) {
        return String(b.priceDate).localeCompare(String(a.priceDate));
      });
      host.innerHTML = '<div class="tablewrap"><table><thead><tr>' +
        '<th>File</th><th>Supplier</th><th>Price date</th><th class="num">Prices</th><th></th>' +
        '</tr></thead><tbody>' + sorted.map(function (s) {
          return '<tr><td>' + esc(s.filename) + '</td><td>' + esc(s.supplier) + '</td>' +
            '<td>' + esc(s.priceDate || '—') + '</td><td class="num">' + num(s.rowCount) + '</td>' +
            '<td><button class="btn sm danger" data-act="delSet" data-id="' + esc(s.id) + '">Delete</button></td></tr>';
        }).join('') + '</tbody></table></div>';
    }

    var note = Store.memoryOnly
      ? 'Browser storage is unavailable here' + (Store.memoryReason ? ' (' + esc(Store.memoryReason) + ')' : '') +
        ', so pricing is held in memory only and will be lost on refresh. Serving this folder over http:// ' +
        'instead of opening the file directly fixes it. Export a backup to keep your work.'
      : 'Pricing is stored in this browser only — nothing is uploaded. Export a backup before clearing site data.';
    $('storageNote').innerHTML = note;
  }

  function deleteSet(id) {
    app.sets = app.sets.filter(function (s) { return s.id !== id; });
    app.quotes = app.quotes.filter(function (q) { return q.setId !== id; });
    Promise.all([Store.del('sets', id), Store.del('rows', id)]).catch(function () {});
    renderDataList();
    render();
    toast('Deleted.');
  }

  function exportBackup() {
    Store.all('rows').then(function (rowRecs) {
      var payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        sets: app.sets,
        rows: rowRecs,
        mappings: app.mappings,
        settings: { adder: app.adder, dispUnit: app.dispUnit }
      };
      download('krova-pricing-backup-' + new Date().toISOString().slice(0, 10) + '.json',
        JSON.stringify(payload), 'application/json');
    });
  }

  function restoreBackup(file) {
    var fr = new FileReader();
    fr.onload = function () {
      var data;
      try { data = JSON.parse(fr.result); }
      catch (e) { toast('That file is not a valid backup.', true); return; }
      if (!data || !Array.isArray(data.sets) || !Array.isArray(data.rows)) {
        toast('That backup is missing its pricing data.', true); return;
      }
      var ops = [];
      data.sets.forEach(function (s) { ops.push(Store.put('sets', s)); });
      data.rows.forEach(function (r) { ops.push(Store.put('rows', r)); });
      if (data.mappings) {
        Object.keys(data.mappings).forEach(function (k) {
          app.mappings[k] = data.mappings[k];
          ops.push(Store.put('kv', { k: 'map:' + k, value: data.mappings[k] }));
        });
      }
      Promise.all(ops).then(loadAll).then(function () {
        renderDataList();
        render();
        toast('Backup restored.');
      }).catch(function (e) { toast('Restore failed: ' + e.message, true); });
    };
    fr.readAsText(file);
  }

  function clearAll() {
    if (!window.confirm('Delete all loaded pricing, saved mappings and settings from this browser?')) return;
    Promise.all([Store.clear('sets'), Store.clear('rows'), Store.clear('kv')]).then(function () {
      app.sets = []; app.quotes = []; app.mappings = {};
      renderDataList();
      render();
      toast('Everything deleted.');
    });
  }

  /* ================= csv ================= */

  function exportCsv() {
    var rows = currentRows();
    if (!rows.length) { toast('Nothing to export with these filters.', true); return; }
    var f = readFilters();

    var lines = [];
    if (app.view === 'quote') {
      var groups = groupQuotes(rows);
      var shown = app.showTerms.slice().sort(function (a, b) { return a - b; });
      lines.push(['Supplier', 'Price date', 'State', 'Utility', 'Zone', 'Rate code', 'Usage band', 'Start']
        .concat(shown.map(function (t) { return t + ' mo'; }))
        .concat(['Sweet spot term', 'Sweet spot rate']).join(','));
      groups.sort(function (a, b) {
        return (a.sweet ? a.sweet.price : Infinity) - (b.sweet ? b.sweet.price : Infinity);
      });
      groups.forEach(function (g) {
        var m = g.meta;
        var cells = [m.supplier, m.priceDate, m.state, m.utility, m.zone, m.rateCode,
          bandLabel(m.usageMin, m.usageMax), m.startMonth]
          .concat(shown.map(function (t) {
            return g.terms[t] === undefined ? '' : rateText(g.terms[t]);
          }))
          .concat([g.sweet ? g.sweet.term : '', g.sweet ? rateText(g.sweet.price) : '']);
        lines.push(cells.map(csvCell).join(','));
      });
    } else {
      var header = ['Supplier', 'Price date', 'State', 'Utility', 'Zone', 'Rate code',
        'Usage min', 'Usage max', 'Start', 'Term', 'Rate (' + rateUnitLabel() + ')'];
      if (f.usage !== null) header.push('Annual cost');
      lines.push(header.join(','));
      rows.forEach(function (q) {
        var cells = [q.supplier, q.priceDate, q.state, q.utility, q.zone, q.rateCode,
          q.usageMin, isFinite(q.usageMax) ? q.usageMax : '', q.startMonth, q.term, rateText(q.price)];
        if (f.usage !== null) cells.push((f.usage * effective(q.price)).toFixed(2));
        lines.push(cells.map(csvCell).join(','));
      });
    }

    download('krova-pricing-' + new Date().toISOString().slice(0, 10) + '.csv',
      lines.join('\r\n'), 'text/csv;charset=utf-8');
  }

  function csvCell(v) {
    var s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /* ================= modals ================= */

  function openModal(id) { $(id).classList.add('open'); }
  function closeModal(id) { $(id).classList.remove('open'); }

  /* ================= boot ================= */

  function loadAll() {
    return Promise.all([Store.all('sets'), Store.all('rows'), Store.all('kv')])
      .then(function (r) {
        app.sets = r[0] || [];
        var byId = {};
        app.sets.forEach(function (s) { byId[s.id] = s; });
        app.quotes = [];
        (r[1] || []).forEach(function (rec) {
          if (!byId[rec.setId]) return;  // orphaned rows
          (rec.rows || []).forEach(function (q) {
            q.setId = rec.setId;
            if (q.usageMax === null) q.usageMax = Infinity;
            app.quotes.push(q);
          });
        });
        (r[2] || []).forEach(function (kv) {
          if (kv.k && kv.k.indexOf('map:') === 0 && kv.value) {
            app.mappings[kv.value.signature] = kv.value;
          }
          if (kv.k === 'settings' && kv.value) {
            app.adder = kv.value.adder || 0;
            app.dispUnit = kv.value.dispUnit || 'usd';
            $('adder').value = app.adder;
            $('dispUnit').value = app.dispUnit;
          }
        });
      });
  }

  function saveSettings() {
    Store.put('kv', { k: 'settings', value: { adder: app.adder, dispUnit: app.dispUnit } })
      .catch(function () {});
  }

  function bind() {
    // top bar
    $('btnImport').onclick = function () { openModal('importModal'); renderImportList(); };
    $('btnData').onclick = function () { renderDataList(); openModal('dataModal'); };
    $('adder').oninput = function () {
      app.adder = parseFloat(this.value) || 0;
      saveSettings(); render();
    };
    $('dispUnit').onchange = function () {
      app.dispUnit = this.value;
      saveSettings(); render();
    };

    // filters
    ['fState', 'fUtility', 'fZone', 'fRate', 'fStart'].forEach(function (id) {
      $(id).onchange = render;
    });
    ['fUsage', 'fMaxPrice'].forEach(function (id) { $(id).oninput = render; });
    $('fSuppliers').onchange = render;
    $('fTerms').onclick = function (e) {
      var b = e.target.closest('[data-term]');
      if (!b) return;
      var t = parseInt(b.getAttribute('data-term'), 10);
      var i = app.showTerms.indexOf(t);
      if (i >= 0) app.showTerms.splice(i, 1); else app.showTerms.push(t);
      render();
    };
    $('btnReset').onclick = function () {
      ['fState', 'fUtility', 'fZone', 'fRate', 'fStart'].forEach(function (id) { $(id).value = ''; });
      $('fUsage').value = ''; $('fMaxPrice').value = '';
      Array.prototype.forEach.call($('fSuppliers').querySelectorAll('input'), function (i) { i.checked = false; });
      app.showTerms = CORE_TERMS.slice();
      render();
    };

    // tabs + export
    $('tabQuote').onclick = function () { setView('quote'); };
    $('tabRows').onclick = function () { setView('rows'); };
    $('btnCsv').onclick = exportCsv;
    $('view').onclick = function (e) {
      var th = e.target.closest('[data-sort]');
      if (!th) return;
      var k = th.getAttribute('data-sort');
      if (app.sort.key === k) app.sort.dir *= -1;
      else { app.sort.key = k; app.sort.dir = 1; }
      render();
    };

    // import modal
    $('pickBtn').onclick = function () { $('fileInput').click(); };
    $('fileInput').onchange = function () { handleFiles(this.files); this.value = ''; };
    $('importClose').onclick = $('importCancel').onclick = function () {
      app.pending = []; renderImportList(); closeModal('importModal');
    };
    $('importConfirm').onclick = confirmImport;

    $('importList').onclick = function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      var act = b.getAttribute('data-act');
      var fi = parseInt(b.getAttribute('data-fi'), 10);
      if (act === 'removeFile') { app.pending.splice(fi, 1); renderImportList(); }
      else if (act === 'map') { openMapper(fi, parseInt(b.getAttribute('data-si'), 10)); }
    };
    $('importList').onchange = function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      var act = b.getAttribute('data-act');
      var fi = parseInt(b.getAttribute('data-fi'), 10);
      var entry = app.pending[fi];
      if (!entry) return;
      if (act === 'include') {
        entry.sheets[parseInt(b.getAttribute('data-si'), 10)].include = b.checked;
        renderImportList();
      } else if (act === 'supplier') { entry.meta.supplier = b.value.trim(); }
      else if (act === 'date') { entry.meta.priceDate = b.value; }
      else if (act === 'state') { entry.meta.state = b.value.trim().toUpperCase(); }
    };

    // drag and drop
    var veil = $('dragveil'), depth = 0;
    window.addEventListener('dragenter', function (e) {
      if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') < 0) return;
      depth++; veil.classList.add('on');
    });
    window.addEventListener('dragleave', function () {
      depth = Math.max(0, depth - 1);
      if (!depth) veil.classList.remove('on');
    });
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) {
      e.preventDefault(); depth = 0; veil.classList.remove('on');
      if (e.dataTransfer && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
    });
    var dz = $('dropzone');
    dz.addEventListener('dragover', function () { dz.classList.add('hot'); });
    dz.addEventListener('dragleave', function () { dz.classList.remove('hot'); });
    dz.addEventListener('drop', function () { dz.classList.remove('hot'); });

    // mapping modal
    $('mapClose').onclick = $('mapCancel').onclick = function () { closeModal('mapModal'); };
    $('mapSave').onclick = saveMapping;
    $('mapHeaderRow').onchange = rebuildMapPlan;
    $('mapUnit').onchange = function () {
      var sh = currentMapSheet();
      if (sh) { sh.plan.priceUnit = this.value; renderMapTable(); }
    };
    $('mapLayout').onchange = function () {
      var sh = currentMapSheet();
      if (sh) { sh.plan.layout = this.value; sh.plan.ok = true; renderMapTable(); }
    };
    $('mapTable').onchange = function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      var sh = currentMapSheet();
      if (!sh) return;
      var i = parseInt(b.getAttribute('data-i'), 10);
      var col = sh.plan.columns[i];
      if (!col) return;
      var act = b.getAttribute('data-act');

      if (act === 'colRole') {
        col.role = b.value;
        if (col.role === 'termPrice' && !col.term) col.term = P.parseTerm(col.label);
        if (col.role === 'bandPrice' && !col.band) col.band = P.parseBandStrict(col.label) || [0, Infinity];
        if (col.role !== 'termPrice') col.term = col.role === 'termPrice' ? col.term : null;
        if (col.role !== 'bandPrice') col.band = null;
      } else if (act === 'colTerm') {
        col.term = parseInt(b.value, 10) || null;
      } else if (act === 'colBandMin' || act === 'colBandMax') {
        var lo = col.band ? col.band[0] : 0;
        var hi = col.band ? col.band[1] : Infinity;
        var v = b.value === '' ? null : parseFloat(b.value);
        if (act === 'colBandMin') lo = v === null ? 0 : v;
        else hi = v === null ? Infinity : v;
        col.band = [lo, hi];
      }
      P.refreshPlan(sh.rows, sh.plan);
      if ($('mapLayout').value) { sh.plan.layout = $('mapLayout').value; sh.plan.ok = true; }
      renderMapTable();
    };

    // data modal
    $('dataClose').onclick = $('dataDone').onclick = function () { closeModal('dataModal'); };
    $('dataList').onclick = function (e) {
      var b = e.target.closest('[data-act="delSet"]');
      if (b) deleteSet(b.getAttribute('data-id'));
    };
    $('btnBackup').onclick = exportBackup;
    $('btnRestore').onclick = function () { $('restoreInput').click(); };
    $('restoreInput').onchange = function () {
      if (this.files[0]) restoreBackup(this.files[0]);
      this.value = '';
    };
    $('btnClearAll').onclick = clearAll;

    // close modals on backdrop click / escape
    ['importModal', 'mapModal', 'dataModal'].forEach(function (id) {
      $(id).addEventListener('mousedown', function (e) {
        if (e.target === this) closeModal(id);
      });
    });
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') ['importModal', 'mapModal', 'dataModal'].forEach(closeModal);
    });
  }

  function setView(v) {
    app.view = v;
    $('tabQuote').setAttribute('aria-selected', String(v === 'quote'));
    $('tabRows').setAttribute('aria-selected', String(v === 'rows'));
    render();
  }

  bind();
  loadAll().then(render).catch(function (e) {
    toast('Could not load saved pricing: ' + e.message, true);
    render();
  });
})();
