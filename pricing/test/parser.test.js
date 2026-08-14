/* Parser tests — run with:  node pricing/test/parser.test.js
 *
 * Fixtures imitate the layout patterns real supplier matrices use: title
 * banners above the header, merged utility cells, usage bands written a
 * dozen different ways, and prices published in four different units.
 */
var path = require('path');
var P = require(path.join(__dirname, '..', 'parser.js'));

var pass = 0, fail = 0, failures = [];

function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; failures.push(name + (detail ? '  → ' + detail : '')); }
}
function eq(name, actual, expected) {
  check(name, actual === expected, 'got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected));
}
function near(name, actual, expected) {
  check(name, actual !== null && Math.abs(actual - expected) < 1e-9,
    'got ' + JSON.stringify(actual) + ', want ' + expected);
}

/* ---------- unit helpers ---------- */

eq('term "12"', P.parseTerm('12'), 12);
eq('term "24 Month"', P.parseTerm('24 Month'), 24);
eq('term "36 Mo"', P.parseTerm('36 Mo'), 36);
eq('term "Term 60"', P.parseTerm('Term 60'), 60);
eq('term "48M"', P.parseTerm('48M'), 48);
eq('year 2026 is not a term', P.parseTerm('2026'), null);
eq('usage 50000 is not a term', P.parseTerm('50000'), null);

near('usage "50k"', P.toUsage('50k'), 50000);
near('usage "1.5M"', P.toUsage('1.5M'), 1500000);
near('usage "100,000 kWh"', P.toUsage('100,000 kWh'), 100000);

function bandEq(name, input, lo, hi) {
  var b = P.parseBand(input);
  check(name, b && b[0] === lo && b[1] === hi, 'got ' + JSON.stringify(b) + ', want [' + lo + ',' + hi + ']');
}
bandEq('band "0-50,000"', '0-50,000', 0, 50000);
bandEq('band "50,001 - 100,000"', '50,001 - 100,000', 50001, 100000);
bandEq('band "100k-250k"', '100k-250k', 100000, 250000);
bandEq('band "Under 100,000"', 'Under 100,000', 0, 100000);
bandEq('band "Over 1,000,000"', 'Over 1,000,000', 1000000, Infinity);
bandEq('band "1,000,001+"', '1,000,001+', 1000001, Infinity);
bandEq('band "0 to 50000"', '0 to 50000', 0, 50000);
bandEq('band "All"', 'All', 0, Infinity);

eq('unit $/kWh', P.inferPriceUnit([0.0689, 0.0712, 0.0671], ''), 'usd_kwh');
eq('unit ¢/kWh', P.inferPriceUnit([6.89, 7.12, 6.71], ''), 'cents');
eq('unit $/MWh', P.inferPriceUnit([68.9, 71.2, 67.1], ''), 'usd_mwh');
eq('unit header hint mills', P.inferPriceUnit([68.9], 'Price (mills/kWh)'), 'mills');
near('convert cents', P.toUsdPerKwh(6.89, 'cents'), 0.0689);
near('convert $/MWh', P.toUsdPerKwh(68.9, 'usd_mwh'), 0.0689);

eq('state from Oncor', P.stateFromUtility('Oncor Electric Delivery'), 'TX');
eq('state from AEP Ohio', P.stateFromUtility('AEP Ohio'), 'OH');

/* ---------- filename metadata ---------- */

var m1 = P.parseFileMeta('TX_MATRIX_2026.08.14.xlsx');
eq('filename date YYYY.MM.DD', m1.priceDate, '2026-08-14');
eq('filename state TX', m1.state, 'TX');

var m2 = P.parseFileMeta('20260814_AEP Energy Matrix 3.0.xlsb');
eq('filename date YYYYMMDD', m2.priceDate, '2026-08-14');
eq('filename supplier AEP Energy', m2.supplier, 'AEP Energy');

var m3 = P.parseFileMeta('08142026_Freepoint_Matrix_Offer_ERCOT_Adj.xlsx');
eq('filename date MMDDYYYY', m3.priceDate, '2026-08-14');
eq('filename supplier Freepoint', m3.supplier, 'Freepoint');
eq('filename ERCOT implies TX', m3.state, 'TX');

/* ---------- fixture A: wide, banner rows, merged utility, $/kWh ---------- */

var fixtureA = [
  ['ACME ENERGY — TEXAS MATRIX PRICING', '', '', '', '', '', ''],
  ['Prices effective 08/14/2026. Indicative only.', '', '', '', '', '', ''],
  [],
  ['Utility', 'Load Zone', 'Rate Class', 'Annual Usage', '12', '24', '36'],
  ['Oncor', 'North', 'Secondary', '0-50,000', 0.07120, 0.06890, 0.06710],
  ['', '', 'Secondary', '50,001-250,000', 0.06980, 0.06750, 0.06600],
  ['', 'North', 'Primary', '250,001-1,000,000', 0.06720, 0.06510, 0.06430],
  ['CenterPoint', 'Houston', 'Secondary', '0-50,000', 0.07340, 0.07010, 0.06880],
  ['', '', '', '', '', '', ''],
  ['Notes: prices exclude TDU charges.', '', '', '', '', '', '']
];

var planA = P.analyzeSheet(fixtureA, 'TX');
eq('A layout wide', planA.layout, 'wide');
eq('A header row index', planA.headerRow, 3);
eq('A price unit', planA.priceUnit, 'usd_kwh');

var rowsA = P.extractRows(fixtureA, planA, P.parseFileMeta('TX_MATRIX_2026.08.14.xlsx'));
eq('A row count (4 data rows x 3 terms)', rowsA.length, 12);
var a0 = rowsA[0];
eq('A utility', a0.utility, 'Oncor');
eq('A zone', a0.zone, 'North');
eq('A state from filename', a0.state, 'TX');
eq('A term', a0.term, 12);
near('A price', a0.price, 0.0712);
near('A usageMax', a0.usageMax, 50000);

// merged-cell forward fill: row 2 has blank utility/zone
var a3 = rowsA[3];
eq('A forward-filled utility', a3.utility, 'Oncor');
eq('A forward-filled zone', a3.zone, 'North');
near('A second band min', a3.usageMin, 50001);

check('A skips the notes/spacer rows',
  rowsA.every(function (r) { return r.utility === 'Oncor' || r.utility === 'CenterPoint'; }),
  'unexpected utilities: ' + JSON.stringify(rowsA.map(function (r) { return r.utility; })));

/* ---------- fixture B: wide, cents, "12 Month" headers, min/max columns ---------- */

var fixtureB = [
  ['Utility', 'Rate Code', 'Min kWh', 'Max kWh', '12 Month', '24 Month', '36 Month', '48 Month', '60 Month'],
  ['AEP Ohio', 'GS-1', 0, 100000, 6.89, 6.71, 6.54, 6.62, 6.70],
  ['AEP Ohio', 'GS-2', 100001, 500000, 6.72, 6.55, 6.40, 6.48, 6.58],
  ['Duke Energy Ohio', 'DM', 0, 100000, 7.01, 6.88, 6.75, 6.82, 6.91]
];

var planB = P.analyzeSheet(fixtureB, 'OH');
eq('B layout wide', planB.layout, 'wide');
eq('B header row index', planB.headerRow, 0);
eq('B price unit cents', planB.priceUnit, 'cents');

var rowsB = P.extractRows(fixtureB, planB, P.parseFileMeta('OH_MATRIX_2026.08.14.xlsx'));
eq('B row count (3 x 5 terms)', rowsB.length, 15);
near('B converts cents to $/kWh', rowsB[0].price, 0.0689);
eq('B rate code', rowsB[0].rateCode, 'GS-1');
eq('B state from filename', rowsB[0].state, 'OH');
// rows are emitted term-major per data row, so GS-2 starts at index 5
var bGs2 = rowsB.filter(function (r) { return r.rateCode === 'GS-2'; })[0];
near('B usage min from Min/Max columns', bGs2.usageMin, 100001);
near('B usage max from Min/Max columns', bGs2.usageMax, 500000);
var b60 = rowsB.filter(function (r) { return r.term === 60 && r.rateCode === 'GS-1'; })[0];
near('B 60-month price', b60.price, 0.0670);

/* ---------- fixture C: long/tidy layout, $/MWh ---------- */

var fixtureC = [
  ['Supplier', 'State', 'Utility', 'Zone', 'Rate Code', 'Usage Band', 'Term', 'Price ($/MWh)'],
  ['Freepoint', 'TX', 'Oncor', 'North', 'Secondary', '0-100k', 12, 71.20],
  ['Freepoint', 'TX', 'Oncor', 'North', 'Secondary', '0-100k', 24, 68.90],
  ['Freepoint', 'TX', 'Oncor', 'North', 'Secondary', '0-100k', 36, 67.10],
  ['Freepoint', 'TX', 'CenterPoint', 'Houston', 'Secondary', '0-100k', 12, 73.40]
];

var planC = P.analyzeSheet(fixtureC, 'Offers');
eq('C layout long', planC.layout, 'long');
eq('C price unit $/MWh', planC.priceUnit, 'usd_mwh');

var rowsC = P.extractRows(fixtureC, planC, P.parseFileMeta('08142026_Freepoint_Matrix_Offer_ERCOT_Adj.xlsx'));
eq('C row count', rowsC.length, 4);
near('C converts $/MWh', rowsC[0].price, 0.0712);
eq('C supplier from column', rowsC[0].supplier, 'Freepoint');
eq('C term', rowsC[1].term, 24);
near('C usage band max', rowsC[0].usageMax, 100000);

/* ---------- fixture D: two-row header ---------- */

var fixtureD = [
  ['', '', '', 'Term (months)', '', ''],
  ['Utility', 'Zone', 'Usage', '12', '24', '36'],
  ['PECO', 'PECO', '0-50,000', 0.0812, 0.0798, 0.0781]
];

var planD = P.analyzeSheet(fixtureD, 'PA');
eq('D finds the real header row', planD.headerRow, 1);
eq('D layout wide', planD.layout, 'wide');
var rowsD = P.extractRows(fixtureD, planD, P.parseFileMeta('PA_MATRIX.xlsx'));
eq('D row count', rowsD.length, 3);
eq('D state inferred from utility', rowsD[0].state, 'PA');

/* ---------- fixture E: junk sheet should be rejected, not guessed ---------- */

var fixtureE = [
  ['Terms and Conditions'],
  ['All prices are indicative and subject to change without notice.'],
  ['Contact your account manager for a firm quote.']
];
var planE = P.analyzeSheet(fixtureE, 'Disclaimer');
eq('E rejects a prose sheet', planE.ok, false);

/* ---------- fixture H: header row must not absorb the first data row ----------
 * Regression: folding the header into the row below produced labels like
 * "Utility AEP Ohio" that still classified as headers. With enough term
 * columns that scored higher than the real header, so row 1 was treated as
 * the header — losing a row of prices and turning "Max kWh" into a band. */

var fixtureH = [
  ['Utility', 'Rate Code', 'Min kWh', 'Max kWh', '12 Month', '18 Month', '24 Month', '30 Month', '36 Month', '48 Month', '60 Month'],
  ['AEP Ohio', 'GS-1', 0, 100000, 6.89, 6.62, 6.71, 6.49, 6.54, 6.62, 6.70],
  ['AEP Ohio', 'GS-2', 100001, 500000, 6.72, 6.48, 6.55, 6.35, 6.40, 6.48, 6.58],
  ['Duke Energy Ohio', 'DM', 0, 100000, 7.01, 6.83, 6.88, 6.79, 6.75, 6.82, 6.91],
  ['Ohio Edison', 'GS', 0, 100000, 7.15, 6.99, 7.02, 6.94, 6.88, 6.95, 7.04],
  ['Cleveland Electric', 'GS', 100001, 500000, 6.95, 6.80, 6.84, 6.76, 6.71, 6.78, 6.86]
];

var planH = P.analyzeSheet(fixtureH, 'Ohio');
eq('H header stays on row 0', planH.headerRow, 0);
eq('H Max kWh stays a bound column', planH.columns[3].role, 'usageMax');
eq('H layout wide', planH.layout, 'wide');

var rowsH = P.extractRows(fixtureH, planH, P.parseFileMeta('OH_MATRIX_2026.08.14.xlsx'));
eq('H keeps every data row (5 rows x 7 terms)', rowsH.length, 35);
var h1 = rowsH.filter(function (r) { return r.rateCode === 'GS-1'; });
near('H first band min', h1[0].usageMin, 0);
near('H first band max', h1[0].usageMax, 100000);
var hBest = h1.reduce(function (a, b) { return b.price < a.price ? b : a; });
eq('H off-core 30 mo is the cheapest term', hBest.term, 30);

/* ---------- fixture G: usage bands as columns, terms down the rows ---------- */

var fixtureG = [
  ['AEP ENERGY — MATRIX 3.0', '', '', '', ''],
  [],
  ['Utility', 'Rate Code', 'Term', '0-100,000', '100,001-500,000', '500,001+'],
  ['AEP Ohio', 'GS-1', 12, 0.0689, 0.0672, 0.0655],
  ['AEP Ohio', 'GS-1', 24, 0.0671, 0.0654, 0.0638],
  ['AEP Ohio', 'GS-1', 36, 0.0654, 0.0639, 0.0622]
];

var planG = P.analyzeSheet(fixtureG, 'Matrix');
eq('G layout bandwide', planG.layout, 'bandwide');
eq('G header row index', planG.headerRow, 2);

var rowsG = P.extractRows(fixtureG, planG, P.parseFileMeta('20260814_AEP Energy Matrix 3.0.xlsb'));
eq('G row count (3 terms x 3 bands)', rowsG.length, 9);
eq('G supplier from filename', rowsG[0].supplier, 'AEP Energy');
eq('G term from term column', rowsG[0].term, 12);
near('G first band min', rowsG[0].usageMin, 0);
near('G first band max', rowsG[0].usageMax, 100000);
near('G second band price', rowsG[1].price, 0.0672);
near('G second band min', rowsG[1].usageMin, 100001);
check('G open-ended top band', rowsG[2].usageMax === Infinity,
  'got ' + rowsG[2].usageMax);
eq('G state inferred from utility', rowsG[0].state, 'OH');

// a year in a header must never be read as a usage band
eq('year header is not a band', P.parseBandStrict('2026'), null);
eq('small range is not a usage band', P.parseBandStrict('1-5'), null);
check('real range is a band', !!P.parseBandStrict('100,001-500,000'));

/* ---------- fixture F: real xlsx round-trip through SheetJS ---------- */

try {
  var XLSX = require(path.join(__dirname, '..', 'vendor', 'xlsx.full.min.js'));
  var wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(fixtureB), 'Matrix');
  var buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  var back = XLSX.read(buf, { type: 'buffer' });
  var aoa = XLSX.utils.sheet_to_json(back.Sheets.Matrix, { header: 1, raw: true, defval: '' });
  var planF = P.analyzeSheet(aoa, 'Matrix');
  var rowsF = P.extractRows(aoa, planF, { supplier: 'Test', state: 'OH', priceDate: '' });
  eq('F xlsx round-trip row count', rowsF.length, 15);
  near('F xlsx round-trip price', rowsF[0].price, 0.0689);
} catch (e) {
  check('F xlsx round-trip', false, e.message);
}

/* ---------- report ---------- */

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (failures.length) {
  console.log('\nFailures:');
  failures.forEach(function (f) { console.log('  ✗ ' + f); });
  process.exit(1);
}
console.log('All parser tests passed.\n');
