/* Pinnacle Pricing Portal — matrix parser
 *
 * Supplier matrix sheets have no common standard, so this parses by shape
 * rather than by supplier. Two layouts cover almost everything:
 *
 *   WIDE  one row per (utility, zone, rate code, usage band) with a column
 *         per term:            Utility | Zone | RateCode | 12 | 24 | 36
 *   LONG  one row per quote with explicit term and price columns:
 *                              Utility | Zone | Term | Price
 *
 * Anything the detector gets wrong is fixable in the mapping UI, and the
 * correction is saved against the sheet's column signature so the next daily
 * drop of the same report parses on its own.
 */
(function (root) {
  'use strict';

  var VALID_TERMS = [];
  for (var t = 1; t <= 72; t++) VALID_TERMS.push(t);

  /* ---------- column role vocabulary ---------- */

  var ROLES = [
    { id: 'ignore', label: 'Ignore' },
    { id: 'supplier', label: 'Supplier' },
    { id: 'state', label: 'State' },
    { id: 'utility', label: 'Utility' },
    { id: 'zone', label: 'Zone / Load Zone' },
    { id: 'rateCode', label: 'Rate Code / Class' },
    { id: 'product', label: 'Product' },
    { id: 'usageBand', label: 'Usage Band (combined)' },
    { id: 'usageMin', label: 'Usage Min' },
    { id: 'usageMax', label: 'Usage Max' },
    { id: 'term', label: 'Term (months)' },
    { id: 'price', label: 'Price' },
    { id: 'startMonth', label: 'Start / Flow Month' },
    { id: 'green', label: 'Green %' },
    { id: 'termPrice', label: 'Price for term…' },
    { id: 'bandPrice', label: 'Price for usage band…' }
  ];

  /* Anchored bound-column headers. Checked before the usage-range test so a
   * column headed "Max kWh" stays a bound column instead of being mistaken
   * for a column of prices covering the band 0–max. */
  var BOUND_PATTERNS = [
    { role: 'usageMin', re: /^(min|from|low)[\s_.-]*(annual\s*)?(usage|kwh|volume|vol|load)?$/i },
    { role: 'usageMax', re: /^(max|to|thru|through|high)[\s_.-]*(annual\s*)?(usage|kwh|volume|vol|load)?$/i },
    { role: 'usageMin', re: /^(usage|kwh|volume|vol|annual\s*usage)[\s_.-]*(min|from|low|start)$/i },
    { role: 'usageMax', re: /^(usage|kwh|volume|vol|annual\s*usage)[\s_.-]*(max|to|high|end)$/i }
  ];

  // Ordered most-specific first; first match wins.
  var HEADER_PATTERNS = [
    { role: 'usageBand', re: /(usage|kwh|volume|annual\s*use|load\s*size|size|tier|band|bucket|stratum|strata)/i },
    { role: 'rateCode', re: /(rate\s*(code|class|schedule)|rate\s*cd|service\s*class|sc\b|tariff|profile|class\b|code\b|rc\b)/i },
    { role: 'utility', re: /(utility|edc|ldc|lde|distribution|utility\s*name|company)/i },
    { role: 'zone', re: /(zone|load\s*zone|congestion|hub|region|territory|district)/i },
    { role: 'state', re: /^(state|st|jurisdiction)$/i },
    { role: 'supplier', re: /(supplier|provider|rep\b|esco|counterparty)/i },
    { role: 'startMonth', re: /(start|flow|begin|effective|delivery|commence)/i },
    { role: 'green', re: /(green|renew|rec\b|wind|solar)/i },
    { role: 'product', re: /(product|offer|type|structure|plan)/i },
    { role: 'term', re: /(term|months|month|duration|length|tenor)/i },
    { role: 'price', re: /(price|rate|cost|\$|¢|cents|mills|energy\s*charge|all\s*in|all-in)/i }
  ];

  var UTILITY_STATE = {
    // ERCOT / Texas
    'oncor': 'TX', 'centerpoint': 'TX', 'aep texas central': 'TX', 'aep texas north': 'TX',
    'aep central': 'TX', 'aep north': 'TX', 'tnmp': 'TX', 'texas new mexico': 'TX', 'sharyland': 'TX',
    // Ohio
    'aep ohio': 'OH', 'ohio power': 'OH', 'columbus southern': 'OH', 'duke energy ohio': 'OH',
    'dayton power': 'OH', 'aes ohio': 'OH', 'dp&l': 'OH', 'ohio edison': 'OH',
    'toledo edison': 'OH', 'cleveland electric': 'OH', 'cei': 'OH',
    // Pennsylvania
    'peco': 'PA', 'ppl': 'PA', 'duquesne': 'PA', 'met-ed': 'PA', 'met ed': 'PA',
    'penelec': 'PA', 'penn power': 'PA', 'west penn': 'PA',
    // Illinois
    'comed': 'IL', 'ameren': 'IL',
    // New Jersey
    'pse&g': 'NJ', 'pseg': 'NJ', 'jcp&l': 'NJ', 'jcpl': 'NJ', 'atlantic city electric': 'NJ',
    // New York
    'coned': 'NY', 'con edison': 'NY', 'consolidated edison': 'NY', 'nyseg': 'NY',
    'rg&e': 'NY', 'central hudson': 'NY', 'orange & rockland': 'NY', 'national grid': 'NY',
    // Maryland / DC / DE
    'bge': 'MD', 'baltimore gas': 'MD', 'pepco': 'MD', 'delmarva': 'DE', 'potomac edison': 'MD',
    // New England
    'eversource': 'MA', 'unitil': 'MA', 'united illuminating': 'CT',
    'cmp': 'ME', 'central maine': 'ME', 'versant': 'ME', 'rhode island energy': 'RI',
    // Michigan / California
    'dte': 'MI', 'consumers energy': 'MI', 'pg&e': 'CA', 'sce': 'CA', 'sdg&e': 'CA'
  };

  var KNOWN_SUPPLIERS = [
    'AEP Energy', 'Freepoint', 'Constellation', 'NRG', 'Direct Energy', 'Shell Energy',
    'Engie', 'Gexa', 'TXU', 'Reliant', 'Vistra', 'Calpine', 'WGL', 'Spark Energy',
    'Clearview', 'Titan', 'Verde', 'Symmetry', 'MP2', 'Cirro', 'Champion', 'APG&E',
    'Hudson', 'Liberty Power', 'Think Energy', 'Talen', 'IGS', 'Santanna', 'Just Energy',
    'Energy Harbor', 'Dynegy', 'Tomorrow Energy', 'South Star', 'Crius', 'Nordic'
  ];

  /* ---------- small helpers ---------- */

  function norm(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/\s+/g, ' ').trim();
  }

  function isBlank(v) { return norm(v) === ''; }

  function toNumber(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var s = norm(v);
    if (!s) return null;
    // strip currency, percent, cents markers, thousands separators, and
    // accounting-style negatives
    var neg = /^\(.*\)$/.test(s);
    s = s.replace(/[()]/g, '').replace(/[$¢,\s]/g, '').replace(/%$/, '');
    if (!/^-?\d*\.?\d+(e-?\d+)?$/i.test(s)) return null;
    var n = parseFloat(s);
    if (!isFinite(n)) return null;
    return neg ? -n : n;
  }

  // "50k" -> 50000, "1.5M" -> 1500000, "100,000" -> 100000
  function toUsage(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var s = norm(v).toLowerCase().replace(/kwh|kw\b/g, '').replace(/[,$\s]/g, '');
    if (!s) return null;
    var m = s.match(/^(-?\d*\.?\d+)(k|m|mm)?$/);
    if (!m) return null;
    var n = parseFloat(m[1]);
    if (!isFinite(n)) return null;
    if (m[2] === 'k') n *= 1000;
    else if (m[2] === 'm' || m[2] === 'mm') n *= 1000000;
    return n;
  }

  /* Parse a term out of a header label. Guards against year-like values
   * (2026) and usage-like values so "2026" or "50000" never become terms. */
  function parseTerm(label) {
    var s = norm(label);
    if (!s) return null;
    if (/^\d{4}$/.test(s)) return null;               // a year
    var m = s.match(/(\d{1,2})\s*(mo|mos|month|months|m)\b/i);
    if (m) { var a = parseInt(m[1], 10); return VALID_TERMS.indexOf(a) >= 0 ? a : null; }
    m = s.match(/^(?:term\s*)?(\d{1,2})$/i);
    if (m) { var b = parseInt(m[1], 10); return VALID_TERMS.indexOf(b) >= 0 ? b : null; }
    m = s.match(/^(\d{1,2})\s*[-–]\s*(?:mo|month)/i);
    if (m) { var c = parseInt(m[1], 10); return VALID_TERMS.indexOf(c) >= 0 ? c : null; }
    return null;
  }

  /* Parse a usage band string into [min, max]. */
  function parseBand(v) {
    var s = norm(v);
    if (!s) return null;
    var low = s.toLowerCase();
    if (/^(all|any|n\/?a|-)$/.test(low)) return [0, Infinity];

    // "over 1,000,000" / "1,000,001+" / ">1M"
    var m = low.match(/^(?:over|above|greater\s*than|more\s*than|>=?|\+)?\s*([\d.,]+\s*(?:k|m|mm)?)\s*\+?$/);
    if (/^(over|above|greater|more|>)/.test(low) || /\+\s*$/.test(low)) {
      var only = low.replace(/^(over|above|greater\s*than|more\s*than|>=?)\s*/, '').replace(/\s*\+$/, '');
      var nOver = toUsage(only);
      if (nOver !== null) return [nOver, Infinity];
    }
    // "under 100,000" / "<100k" / "up to 100000"
    if (/^(under|below|less\s*than|up\s*to|<=?|max)/.test(low)) {
      var onlyU = low.replace(/^(under|below|less\s*than|up\s*to|<=?|max)\s*/, '');
      var nU = toUsage(onlyU);
      if (nU !== null) return [0, nU];
    }
    // "0-50,000" / "50k - 100k" / "0 to 50000"
    var parts = low.split(/\s*(?:-|–|—|to|thru|through)\s*/).filter(function (p) { return p !== ''; });
    if (parts.length === 2) {
      var lo = toUsage(parts[0]), hi = toUsage(parts[1]);
      if (lo !== null && hi !== null) return [lo, hi];
    }
    // bare single number = exact tier floor
    var single = toUsage(low);
    if (single !== null && m) return [single, single];
    return null;
  }

  /* ---------- price unit inference ----------
   * Canonical storage is $/kWh. Matrix sheets publish in $/kWh, ¢/kWh,
   * mills/kWh or $/MWh; magnitude plus header hints disambiguate. */
  function inferPriceUnit(samples, headerHint) {
    var hint = norm(headerHint).toLowerCase();
    if (/mwh/.test(hint)) return 'usd_mwh';
    if (/mill/.test(hint)) return 'mills';
    if (/¢|cent/.test(hint)) return 'cents';
    if (/\$\s*\/?\s*kwh|usd\s*\/?\s*kwh/.test(hint)) return 'usd_kwh';

    var nums = samples.filter(function (n) { return typeof n === 'number' && isFinite(n) && n > 0; })
      .sort(function (a, b) { return a - b; });
    if (!nums.length) return 'usd_kwh';
    var med = nums[Math.floor(nums.length / 2)];

    if (med < 1) return 'usd_kwh';        // 0.0689
    if (med < 30) return 'cents';         // 6.89
    if (med < 1000) return 'usd_mwh';     // 68.9  (mills/kWh is numerically identical)
    return 'usd_kwh';
  }

  function toUsdPerKwh(value, unit) {
    if (value === null || !isFinite(value)) return null;
    switch (unit) {
      case 'cents': return value / 100;
      case 'mills': return value / 1000;
      case 'usd_mwh': return value / 1000;
      default: return value;
    }
  }

  var PRICE_UNITS = [
    { id: 'usd_kwh', label: '$/kWh  (0.0689)' },
    { id: 'cents', label: '¢/kWh  (6.89)' },
    { id: 'mills', label: 'mills/kWh  (68.9)' },
    { id: 'usd_mwh', label: '$/MWh  (68.90)' }
  ];

  /* ---------- filename metadata ---------- */

  function parseFileMeta(filename) {
    var base = String(filename || '').replace(/\.(xlsx|xlsm|xlsb|xls|csv)$/i, '');
    var meta = { supplier: '', state: '', priceDate: '', fallbackName: '' };

    /* Two different reports with no recognisable supplier must not collapse
     * into one bucket, so the filename stem (minus its date) becomes the
     * default label. It is editable at import. */
    meta.fallbackName = base
      .replace(/\d{1,4}[.\-_/]\d{1,2}[.\-_/]\d{1,4}/g, ' ')
      .replace(/(^|\D)\d{8}(\D|$)/g, '$1 $2')
      .replace(/[_\-.]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Date formats seen in the wild: 2026.08.14, 20260814, 08142026, 2026-08-14.
    // Underscores are word characters, so \b cannot delimit "20260814_AEP" —
    // these use explicit non-digit boundaries instead.
    var d = null, m;
    if ((m = base.match(/(20\d{2})[.\-_/](\d{1,2})[.\-_/](\d{1,2})/))) {
      d = [m[1], m[2], m[3]];
    } else if ((m = base.match(/(\d{1,2})[.\-_/](\d{1,2})[.\-_/](20\d{2})/))) {
      d = [m[3], m[1], m[2]];
    } else if ((m = base.match(/(?:^|[^\d])(20\d{2})(\d{2})(\d{2})(?:[^\d]|$)/))) {
      d = [m[1], m[2], m[3]];
    } else if ((m = base.match(/(?:^|[^\d])(\d{2})(\d{2})(20\d{2})(?:[^\d]|$)/))) {
      d = [m[3], m[1], m[2]];
    }
    if (d) {
      var mo = parseInt(d[1], 10), dy = parseInt(d[2], 10);
      if (mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31) {
        meta.priceDate = d[0] + '-' + String(mo).padStart(2, '0') + '-' + String(dy).padStart(2, '0');
      }
    }

    for (var i = 0; i < KNOWN_SUPPLIERS.length; i++) {
      var key = KNOWN_SUPPLIERS[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s_-]*');
      if (new RegExp(key, 'i').test(base)) { meta.supplier = KNOWN_SUPPLIERS[i]; break; }
    }

    var FULL_STATES = {
      texas: 'TX', ohio: 'OH', pennsylvania: 'PA', illinois: 'IL', 'new jersey': 'NJ',
      maryland: 'MD', michigan: 'MI', massachusetts: 'MA', connecticut: 'CT',
      delaware: 'DE', maine: 'ME', california: 'CA', virginia: 'VA', georgia: 'GA'
    };
    var lowBase = base.toLowerCase();
    var fullKeys = Object.keys(FULL_STATES);
    for (var f = 0; f < fullKeys.length; f++) {
      if (lowBase.indexOf(fullKeys[f]) >= 0) { meta.state = FULL_STATES[fullKeys[f]]; break; }
    }
    if (!meta.state) {
      var st = base.match(/(?:^|[^A-Za-z])(TX|OH|PA|IL|NJ|NY|MA|MD|DC|CT|ME|NH|RI|DE|MI|CA|VA|GA)(?:[^A-Za-z]|$)/i);
      if (st) meta.state = st[1].toUpperCase();
      else if (/ercot/i.test(base)) meta.state = 'TX';
    }

    return meta;
  }

  function stateFromUtility(u) {
    var s = norm(u).toLowerCase();
    if (!s) return '';
    var keys = Object.keys(UTILITY_STATE);
    for (var i = 0; i < keys.length; i++) {
      if (s.indexOf(keys[i]) >= 0) return UTILITY_STATE[keys[i]];
    }
    return '';
  }

  /* ---------- header detection ---------- */

  /* A header that is itself a usage range ("50,001-100,000") marks a column of
   * prices for that band. Kept strict — a bare number like "2026" is a year,
   * not a band, so only true ranges and open-ended bounds qualify. */
  function parseBandStrict(label) {
    var b = parseBand(label);
    if (!b) return null;
    if (b[1] === Infinity) return b[0] >= 1000 ? b : null;
    if (b[1] <= b[0]) return null;      // single value, not a range
    if (b[1] < 1000) return null;       // too small to be annual kWh
    return b;
  }

  function classifyHeader(label) {
    var s = norm(label);
    if (!s) return 'ignore';
    for (var b = 0; b < BOUND_PATTERNS.length; b++) {
      if (BOUND_PATTERNS[b].re.test(s)) return BOUND_PATTERNS[b].role;
    }
    if (parseTerm(s) !== null) return 'termPrice';
    if (parseBandStrict(s)) return 'bandPrice';
    for (var i = 0; i < HEADER_PATTERNS.length; i++) {
      if (HEADER_PATTERNS[i].re.test(s)) return HEADER_PATTERNS[i].role;
    }
    return 'ignore';
  }

  /* Build candidate header labels for row i. Folding only fills cells the row
   * leaves blank, which is what a merged label spanning a second header row
   * looks like. It must never concatenate over a cell that already has a
   * value, or the first data row ("AEP Ohio" under "Utility") would read as a
   * header and swallow a row of real prices. */
  function headerLabelsAt(rows, i, fold) {
    var row = rows[i] || [];
    var above = fold && i > 0 ? (rows[i - 1] || []) : [];
    var width = Math.max(row.length, above.length);
    var out = [];
    for (var c = 0; c < width; c++) {
      out.push(norm(row[c]) || norm(above[c]));
    }
    return out;
  }

  function scoreHeaderRow(labels, rows, rowIndex) {
    var roles = labels.map(classifyHeader);
    var named = 0, terms = 0;
    roles.forEach(function (r) {
      if (r === 'termPrice' || r === 'bandPrice') terms++;
      else if (r !== 'ignore') named++;
    });
    if (named === 0 && terms === 0) return -1;

    // A header row should be followed by data, not more blanks.
    var below = 0;
    for (var k = rowIndex + 1; k < Math.min(rows.length, rowIndex + 4); k++) {
      var filled = (rows[k] || []).filter(function (c) { return !isBlank(c); }).length;
      if (filled >= 2) below++;
    }
    if (below === 0) return -1;

    // Terms are the strongest signal that this is a matrix header.
    return named * 2 + terms * 3 + below;
  }

  function detectHeader(rows) {
    var best = { score: -1, index: -1, fold: false, labels: [] };
    var limit = Math.min(rows.length, 40);
    for (var i = 0; i < limit; i++) {
      [false, true].forEach(function (fold) {
        var labels = headerLabelsAt(rows, i, fold);
        var score = scoreHeaderRow(labels, rows, i);
        if (score > best.score) best = { score: score, index: i, fold: fold, labels: labels };
      });
    }
    return best;
  }

  /* ---------- sheet analysis ---------- */

  function signatureOf(labels) {
    return labels.map(function (l) { return norm(l).toLowerCase(); }).join('|');
  }

  /* Produce a mapping proposal for one sheet without committing to it, so the
   * UI can show what was detected and let the user correct it. */
  function inferLayout(columns) {
    var termCols = columns.filter(function (c) { return c.role === 'termPrice' && c.term; });
    var bandCols = columns.filter(function (c) { return c.role === 'bandPrice' && c.band; });
    var hasTermCol = columns.some(function (c) { return c.role === 'term'; });
    var hasPriceCol = columns.some(function (c) { return c.role === 'price'; });
    if (termCols.length >= 2) return 'wide';
    if (bandCols.length >= 2 && hasTermCol) return 'bandwide';
    if (hasTermCol && hasPriceCol) return 'long';
    if (termCols.length === 1) return 'wide';
    return 'unknown';
  }

  function samplePrices(rows, headerRow, columns, layout) {
    var cols = [];
    if (layout === 'wide') cols = columns.filter(function (c) { return c.role === 'termPrice' && c.term; });
    else if (layout === 'bandwide') cols = columns.filter(function (c) { return c.role === 'bandPrice' && c.band; });
    else if (layout === 'long') cols = columns.filter(function (c) { return c.role === 'price'; });

    var samples = [];
    var limit = Math.min(rows.length, headerRow + 401);
    for (var r = headerRow + 1; r < limit; r++) {
      for (var i = 0; i < cols.length; i++) {
        var n = toNumber((rows[r] || [])[cols[i].index]);
        if (n !== null && n > 0) samples.push(n);
      }
    }
    return { samples: samples, hint: cols.length ? cols[0].label : '' };
  }

  /* Build a parse plan for a known header row. The mapping UI calls this
   * directly when the user moves the header row or forces a layout. */
  function buildPlan(rows, headerRow, opts) {
    opts = opts || {};
    var labels = headerLabelsAt(rows, headerRow, !!opts.fold);
    var columns = labels.map(function (label, idx) {
      var role = classifyHeader(label);
      return {
        index: idx, label: label, role: role,
        term: role === 'termPrice' ? parseTerm(label) : null,
        band: role === 'bandPrice' ? parseBandStrict(label) : null
      };
    });
    var layout = opts.layout || inferLayout(columns);
    var sp = samplePrices(rows, headerRow, columns, layout);
    return {
      ok: layout !== 'unknown',
      reason: layout === 'unknown' ? 'Could not find term or price columns' : '',
      sheetName: opts.sheetName || '',
      headerRow: headerRow,
      fold: !!opts.fold,
      labels: labels,
      columns: columns,
      layout: layout,
      priceUnit: opts.priceUnit || inferPriceUnit(sp.samples, sp.hint),
      signature: signatureOf(labels),
      rowCount: Math.max(0, rows.length - headerRow - 1),
      sampleCount: sp.samples.length
    };
  }

  /* Recompute layout and unit after the user edits column roles by hand. */
  function refreshPlan(rows, plan) {
    plan.layout = inferLayout(plan.columns);
    plan.ok = plan.layout !== 'unknown';
    plan.reason = plan.ok ? '' : 'Could not find term or price columns';
    return plan;
  }

  function analyzeSheet(rows, sheetName) {
    var header = detectHeader(rows);
    if (header.index < 0) {
      return {
        ok: false, reason: 'No header row found', sheetName: sheetName,
        headerRow: -1, labels: [], columns: [], layout: 'unknown',
        priceUnit: 'usd_kwh', signature: '', rowCount: 0, sampleCount: 0
      };
    }
    return buildPlan(rows, header.index, { fold: header.fold, sheetName: sheetName });
  }

  /* ---------- extraction ---------- */

  /* Merged cells arrive as blanks in every non-anchor position, so key
   * columns inherit the last non-blank value above them. */
  function buildForwardFill(columns) {
    var fillRoles = { state: 1, utility: 1, zone: 1, rateCode: 1, product: 1, startMonth: 1, supplier: 1, usageBand: 1, usageMin: 1, usageMax: 1 };
    return columns.filter(function (c) { return fillRoles[c.role]; }).map(function (c) { return c.index; });
  }

  function extractRows(rows, plan, fileMeta) {
    var out = [];
    var columns = plan.columns;
    var byRole = {};
    columns.forEach(function (c) {
      if (c.role === 'termPrice' || c.role === 'bandPrice') return;
      if (!byRole[c.role]) byRole[c.role] = c;
    });
    var termCols = columns.filter(function (c) { return c.role === 'termPrice' && c.term; });
    var bandCols = columns.filter(function (c) { return c.role === 'bandPrice' && c.band; });
    var fillIdx = buildForwardFill(columns);
    var carry = {};
    var unit = plan.priceUnit;

    function cell(row, role) {
      var c = byRole[role];
      if (!c) return '';
      var v = (row || [])[c.index];
      return isBlank(v) ? '' : v;
    }

    for (var r = plan.headerRow + 1; r < rows.length; r++) {
      var row = rows[r] || [];
      var filled = row.filter(function (c) { return !isBlank(c); }).length;
      if (filled === 0) continue;

      // apply forward fill
      fillIdx.forEach(function (i) {
        if (isBlank(row[i])) { if (carry[i] !== undefined) row[i] = carry[i]; }
        else carry[i] = row[i];
      });

      var utility = norm(cell(row, 'utility'));
      var zone = norm(cell(row, 'zone'));
      var rateCode = norm(cell(row, 'rateCode'));
      var product = norm(cell(row, 'product'));
      var startMonth = norm(cell(row, 'startMonth'));
      var green = norm(cell(row, 'green'));
      var state = norm(cell(row, 'state')).toUpperCase() ||
        fileMeta.state || stateFromUtility(utility) || '';
      var supplier = norm(cell(row, 'supplier')) || fileMeta.supplier || 'Unknown';

      // usage band
      var uMin = null, uMax = null;
      if (byRole.usageMin || byRole.usageMax) {
        uMin = toUsage(cell(row, 'usageMin'));
        uMax = toUsage(cell(row, 'usageMax'));
      }
      if (uMin === null && uMax === null && byRole.usageBand) {
        var band = parseBand(cell(row, 'usageBand'));
        if (band) { uMin = band[0]; uMax = band[1]; }
      }
      if (uMin === null) uMin = 0;
      if (uMax === null || !isFinite(uMax)) uMax = Infinity;

      // A row with no identity at all is a spacer/legend line.
      if (!utility && !zone && !rateCode && !state) continue;

      function push(term, rawPrice, bandOverride) {
        var n = toNumber(rawPrice);
        if (n === null || n <= 0) return;
        var usd = toUsdPerKwh(n, unit);
        if (usd === null || usd <= 0 || usd > 5) return; // sanity guard
        out.push({
          supplier: supplier, state: state, utility: utility, zone: zone,
          rateCode: rateCode, product: product, startMonth: startMonth,
          green: green,
          usageMin: bandOverride ? bandOverride[0] : uMin,
          usageMax: bandOverride ? bandOverride[1] : uMax,
          term: term, price: usd
        });
      }

      function rowTerm() {
        var t = parseTerm(cell(row, 'term'));
        if (t === null) t = toNumber(cell(row, 'term'));
        return t && VALID_TERMS.indexOf(Math.round(t)) >= 0 ? Math.round(t) : null;
      }

      if (plan.layout === 'wide') {
        termCols.forEach(function (tc) { push(tc.term, row[tc.index]); });
      } else if (plan.layout === 'bandwide') {
        var bt = rowTerm();
        if (bt) bandCols.forEach(function (bc) { push(bt, row[bc.index], bc.band); });
      } else {
        var term = rowTerm();
        if (term) push(term, cell(row, 'price'));
      }
    }
    return out;
  }

  root.MatrixParser = {
    ROLES: ROLES,
    PRICE_UNITS: PRICE_UNITS,
    KNOWN_SUPPLIERS: KNOWN_SUPPLIERS,
    analyzeSheet: analyzeSheet,
    buildPlan: buildPlan,
    refreshPlan: refreshPlan,
    inferLayout: inferLayout,
    samplePrices: samplePrices,
    extractRows: extractRows,
    parseFileMeta: parseFileMeta,
    parseTerm: parseTerm,
    parseBand: parseBand,
    parseBandStrict: parseBandStrict,
    toUsage: toUsage,
    toNumber: toNumber,
    toUsdPerKwh: toUsdPerKwh,
    inferPriceUnit: inferPriceUnit,
    stateFromUtility: stateFromUtility,
    signatureOf: signatureOf,
    classifyHeader: classifyHeader,
    detectHeader: detectHeader
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = root.MatrixParser;
})(typeof window !== 'undefined' ? window : globalThis);
