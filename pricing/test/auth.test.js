/* End-to-end account, licensing and isolation tests.
 *
 *   node pricing/test/auth.test.js
 *
 * These go through PostgREST with real signed-in user JWTs — the same path the
 * browser takes — rather than privileged SQL, so what passes here is what an
 * actual account can and cannot do.
 *
 * Requires network access to the Supabase project and two seeded users.
 */
var path = require('path');
var fs = require('fs');

// config.js and the vendored client are browser globals, so load them the way
// a <script> tag would. The client bundle is an IIFE assigning `var supabase`,
// which require() cannot see — indirect eval runs it in global scope instead.
global.window = global.window || {};
global.self = global.window;
eval(fs.readFileSync(path.join(__dirname, '..', 'config.js'), 'utf8'));
var cfg = global.window.PINNACLE_CONFIG;

(0, eval)(fs.readFileSync(path.join(__dirname, '..', 'vendor', 'supabase.js'), 'utf8'));
var createClient = globalThis.supabase.createClient;

var A = { email: 'e2e-alpha@energymatrixtool.com', password: 'AlphaPass!2026' };
var B = { email: 'e2e-beta@energymatrixtool.com', password: 'BetaPass!2026' };

var pass = 0, fail = 0, problems = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; problems.push(name + (detail ? ' → ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' → ' + detail : '')); }
}

function client() {
  return createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

async function signIn(who) {
  var sb = client();
  var r = await sb.auth.signInWithPassword({ email: who.email, password: who.password });
  if (r.error) throw new Error('sign in failed for ' + who.email + ': ' + r.error.message);
  return { sb: sb, userId: r.data.user.id };
}

var SET_ID = 'E2E_TX_MATRIX.xlsx::2026-08-14';
var QUOTES = [
  { supplier: 'E2E TX', state: 'TX', utility: 'Oncor', zone: 'North', rateCode: 'Secondary',
    usageMin: 0, usageMax: 100000, term: 12, price: 0.0712 },
  { supplier: 'E2E TX', state: 'TX', utility: 'Oncor', zone: 'North', rateCode: 'Secondary',
    usageMin: 0, usageMax: 100000, term: 36, price: 0.0671 }
];

(async () => {
  // ---------- anonymous access ----------
  var anon = client();
  var anonSets = await anon.from('price_sets').select('*');
  check('signed-out cannot read pricing',
    (anonSets.data || []).length === 0, JSON.stringify(anonSets.data));

  var anonWrite = await anon.from('price_sets').insert({
    user_id: '00000000-0000-0000-0000-000000000000', id: 'anon', filename: 'x', supplier: 'x'
  });
  check('signed-out cannot write pricing', !!anonWrite.error,
    anonWrite.error ? '' : 'insert unexpectedly succeeded');

  var anonLic = await anon.rpc('has_active_license');
  check('signed-out cannot call has_active_license', !!anonLic.error,
    anonLic.error ? '' : 'rpc unexpectedly succeeded');

  // ---------- user A ----------
  var a = await signIn(A);
  check('A can sign in', !!a.userId);

  var aLic = await a.sb.rpc('has_active_license');
  check('A has a live trial licence', aLic.data === true, JSON.stringify(aLic));

  var aProfile = await a.sb.from('profiles').select('*');
  check('A sees exactly one profile — their own',
    (aProfile.data || []).length === 1 && aProfile.data[0].id === a.userId);
  check('company captured from signup metadata',
    aProfile.data && aProfile.data[0].company === 'Alpha Brokerage',
    aProfile.data && aProfile.data[0].company);

  // write a price set the way the portal does
  var putSet = await a.sb.from('price_sets').upsert({
    user_id: a.userId, id: SET_ID, filename: 'E2E_TX_MATRIX.xlsx',
    supplier: 'E2E TX', price_date: '2026-08-14', row_count: QUOTES.length
  });
  check('A can write a price set', !putSet.error, putSet.error && putSet.error.message);

  var putRows = await a.sb.from('price_set_rows').upsert({
    user_id: a.userId, set_id: SET_ID, rows: QUOTES
  });
  check('A can write the quote blob', !putRows.error, putRows.error && putRows.error.message);

  var aRead = await a.sb.from('price_set_rows').select('rows').eq('set_id', SET_ID).maybeSingle();
  check('A reads their quotes back intact',
    aRead.data && aRead.data.rows.length === 2 && aRead.data.rows[1].price === 0.0671,
    JSON.stringify(aRead.data && aRead.data.rows));

  // settings + mappings round trip
  await a.sb.from('user_settings').upsert({ user_id: a.userId, adder: 5, disp_unit: 'cents' });
  var aSet = await a.sb.from('user_settings').select('adder, disp_unit').maybeSingle();
  check('A settings round trip',
    aSet.data && Number(aSet.data.adder) === 5 && aSet.data.disp_unit === 'cents',
    JSON.stringify(aSet.data));

  await a.sb.from('column_mappings').upsert({
    user_id: a.userId, signature: 'utility|zone|12|24', mapping: { layout: 'wide', headerRow: 0 }
  });
  var aMap = await a.sb.from('column_mappings').select('*');
  check('A mapping round trip',
    (aMap.data || []).length === 1 && aMap.data[0].mapping.layout === 'wide',
    JSON.stringify(aMap.data));

  // A must not be able to touch their own licence
  var selfExtend = await a.sb.from('licenses')
    .update({ status: 'active', expires_at: '2099-01-01' }).eq('user_id', a.userId).select();
  check('A cannot extend their own licence',
    (selfExtend.data || []).length === 0,
    'rows changed: ' + JSON.stringify(selfExtend.data));

  // ---------- user B: isolation ----------
  var b = await signIn(B);
  check('B can sign in', !!b.userId);

  var bSets = await b.sb.from('price_sets').select('*');
  check('B cannot see A price sets', (bSets.data || []).length === 0, JSON.stringify(bSets.data));

  var bRows = await b.sb.from('price_set_rows').select('*');
  check('B cannot see A quote blobs', (bRows.data || []).length === 0, JSON.stringify(bRows.data));

  var bProfiles = await b.sb.from('profiles').select('*');
  check('B cannot see A profile',
    (bProfiles.data || []).length === 1 && bProfiles.data[0].id === b.userId,
    JSON.stringify(bProfiles.data));

  var bMaps = await b.sb.from('column_mappings').select('*');
  check('B cannot see A saved mappings', (bMaps.data || []).length === 0, JSON.stringify(bMaps.data));

  // B tries to read A's row directly by primary key
  var bTargeted = await b.sb.from('price_set_rows').select('rows').eq('set_id', SET_ID);
  check('B cannot read A blob even by exact key',
    (bTargeted.data || []).length === 0, JSON.stringify(bTargeted.data));

  // B tries to overwrite A's data
  var bOverwrite = await b.sb.from('price_set_rows')
    .update({ rows: [{ hacked: true }] }).eq('set_id', SET_ID).select();
  check('B cannot overwrite A data',
    (bOverwrite.data || []).length === 0, JSON.stringify(bOverwrite.data));

  // B tries to write a row belonging to A
  var bImpersonate = await b.sb.from('price_sets').insert({
    user_id: a.userId, id: 'IMPERSONATED', filename: 'x.xlsx', supplier: 'x'
  });
  check('B cannot insert rows owned by A', !!bImpersonate.error,
    bImpersonate.error ? '' : 'insert unexpectedly succeeded');

  // confirm A's data survived every attempt
  var aStill = await a.sb.from('price_set_rows').select('rows').eq('set_id', SET_ID).maybeSingle();
  check('A data unchanged after B attempts',
    aStill.data && aStill.data.rows.length === 2 && aStill.data.rows[0].price === 0.0712,
    JSON.stringify(aStill.data && aStill.data.rows));

  // ---------- cleanup ----------
  await a.sb.from('price_sets').delete().eq('id', SET_ID);
  await a.sb.from('column_mappings').delete().eq('user_id', a.userId);
  var gone = await a.sb.from('price_set_rows').select('*').eq('set_id', SET_ID);
  check('deleting a set cascades to its blob', (gone.data || []).length === 0, JSON.stringify(gone.data));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (problems.length) { console.log('\nProblems:'); problems.forEach(p => console.log('  ✗ ' + p)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e.message); process.exit(2); });
