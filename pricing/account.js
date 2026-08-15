/* Pinnacle Energy Matrix Tool — accounts, licensing and synced storage.
 *
 * Exposes two things to app.js:
 *
 *   window.PinnacleAccount  session, licence state, and the auth screen
 *   window.PinnacleStore    the same all/put/del/clear interface the portal
 *                        already used for IndexedDB, backed by Supabase
 *
 * Keeping the store interface identical means the portal's own logic did not
 * have to change to become multi-tenant.
 *
 * A matrix file can extract to six figures of quotes, so a price set is stored
 * as one jsonb blob rather than one row per quote. Blobs are cached in
 * IndexedDB and only re-fetched when the server's updated_at moves, so a
 * returning user downloads metadata and nothing else.
 */
(function () {
  'use strict';

  var cfg = window.PINNACLE_CONFIG;
  var sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true }
  });

  var state = {
    user: null,
    profile: null,
    license: null,
    ready: false
  };

  /* ================= local blob cache ================= */

  var Cache = (function () {
    var NAME = 'pinnacle-cache', VER = 1, dbp = null, dead = false;

    function open() {
      if (dead) return Promise.resolve(null);
      if (dbp) return dbp;
      dbp = new Promise(function (res, rej) {
        var req;
        try { req = indexedDB.open(NAME, VER); } catch (e) { return rej(e); }
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'key' });
        };
        req.onsuccess = function () { res(req.result); };
        req.onerror = function () { rej(req.error); };
      }).catch(function () { dead = true; return null; });
      return dbp;
    }

    function key(userId, setId) { return userId + '|' + setId; }

    return {
      get: function (userId, setId) {
        return open().then(function (db) {
          if (!db) return null;
          return new Promise(function (res) {
            var t = db.transaction('blobs', 'readonly');
            var r = t.objectStore('blobs').get(key(userId, setId));
            r.onsuccess = function () { res(r.result || null); };
            r.onerror = function () { res(null); };
          });
        });
      },
      put: function (userId, setId, updatedAt, rows) {
        return open().then(function (db) {
          if (!db) return;
          return new Promise(function (res) {
            var t = db.transaction('blobs', 'readwrite');
            t.objectStore('blobs').put({
              key: key(userId, setId), setId: setId, updatedAt: updatedAt, rows: rows
            });
            t.oncomplete = function () { res(); };
            t.onerror = function () { res(); };
          });
        });
      },
      del: function (userId, setId) {
        return open().then(function (db) {
          if (!db) return;
          return new Promise(function (res) {
            var t = db.transaction('blobs', 'readwrite');
            t.objectStore('blobs').delete(key(userId, setId));
            t.oncomplete = function () { res(); };
            t.onerror = function () { res(); };
          });
        });
      },
      clear: function () {
        return open().then(function (db) {
          if (!db) return;
          return new Promise(function (res) {
            var t = db.transaction('blobs', 'readwrite');
            t.objectStore('blobs').clear();
            t.oncomplete = function () { res(); };
            t.onerror = function () { res(); };
          });
        });
      }
    };
  })();

  /* ================= licence ================= */

  function licenseState() {
    var l = state.license;
    if (!l) return { ok: false, label: 'No licence', detail: 'This account has no licence record.', expired: true };
    var now = Date.now();
    if (l.status === 'suspended') {
      return { ok: false, expired: true, label: 'Suspended', detail: 'This account has been suspended.' };
    }
    if (l.status === 'trial') {
      var ends = l.trial_ends_at ? new Date(l.trial_ends_at).getTime() : 0;
      if (ends > now) {
        var days = Math.max(1, Math.ceil((ends - now) / 86400000));
        return { ok: true, expired: false, trial: true, daysLeft: days,
          label: 'Trial · ' + days + (days === 1 ? ' day left' : ' days left'),
          detail: 'Your trial ends ' + new Date(ends).toLocaleDateString() + '.' };
      }
      return { ok: false, expired: true, label: 'Trial ended',
        detail: 'Your trial ended ' + (l.trial_ends_at ? new Date(ends).toLocaleDateString() : '') +
                '. Existing pricing stays readable and exportable, but new imports are disabled.' };
    }
    if (l.status === 'active') {
      if (!l.expires_at) return { ok: true, expired: false, label: 'Licensed', detail: 'Licence does not expire.' };
      var exp = new Date(l.expires_at).getTime();
      if (exp > now) {
        return { ok: true, expired: false, label: 'Licensed',
          detail: 'Renews ' + new Date(exp).toLocaleDateString() + '.' };
      }
      return { ok: false, expired: true, label: 'Licence expired',
        detail: 'Your licence expired ' + new Date(exp).toLocaleDateString() +
                '. Existing pricing stays readable, but new imports are disabled.' };
    }
    return { ok: false, expired: true, label: 'Expired',
      detail: 'Existing pricing stays readable and exportable, but new imports are disabled.' };
  }

  /* ================= session ================= */

  function loadAccount() {
    return sb.auth.getSession().then(function (r) {
      var session = r.data && r.data.session;
      if (!session) { state.user = null; state.profile = null; state.license = null; return null; }
      state.user = session.user;
      return Promise.all([
        sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle(),
        sb.from('licenses').select('*').eq('user_id', session.user.id).maybeSingle()
      ]).then(function (rows) {
        state.profile = rows[0].data || null;
        state.license = rows[1].data || null;
        return state.user;
      });
    });
  }

  /* ================= store (same shape app.js already used) ================= */

  function uid() { return state.user ? state.user.id : null; }

  function err(e) {
    var m = (e && (e.message || e.error_description)) || String(e);
    if (/row-level security/i.test(m)) {
      return new Error('Your licence does not allow new imports. Existing pricing is still readable.');
    }
    return new Error(m);
  }

  var Store = {
    memoryOnly: false,
    memoryReason: '',

    all: function (name) {
      var id = uid();
      if (!id) return Promise.resolve([]);

      if (name === 'sets') {
        return sb.from('price_sets')
          .select('id, filename, supplier, price_date, row_count, imported_at, updated_at')
          .then(function (r) {
            if (r.error) throw err(r.error);
            return (r.data || []).map(function (s) {
              return {
                id: s.id, filename: s.filename, supplier: s.supplier,
                priceDate: s.price_date || '', rowCount: s.row_count,
                importedAt: s.imported_at, updatedAt: s.updated_at
              };
            });
          });
      }

      if (name === 'rows') {
        // Fetch metadata first, then pull only the blobs the cache lacks or
        // that the server has since changed.
        return sb.from('price_sets').select('id, updated_at').then(function (r) {
          if (r.error) throw err(r.error);
          var sets = r.data || [];
          return Promise.all(sets.map(function (s) {
            return Cache.get(id, s.id).then(function (hit) {
              if (hit && hit.updatedAt === s.updated_at) {
                return { setId: s.id, rows: hit.rows };
              }
              return sb.from('price_set_rows').select('rows, updated_at')
                .eq('set_id', s.id).maybeSingle()
                .then(function (rr) {
                  if (rr.error || !rr.data) return { setId: s.id, rows: [] };
                  var rows = rr.data.rows || [];
                  return Cache.put(id, s.id, s.updated_at, rows).then(function () {
                    return { setId: s.id, rows: rows };
                  });
                });
            });
          }));
        });
      }

      if (name === 'kv') {
        return Promise.all([
          sb.from('column_mappings').select('signature, mapping'),
          sb.from('user_settings').select('adder, disp_unit').maybeSingle()
        ]).then(function (res) {
          var out = [];
          if (!res[0].error) {
            (res[0].data || []).forEach(function (m) {
              out.push({ k: 'map:' + m.signature, value: m.mapping });
            });
          }
          if (!res[1].error && res[1].data) {
            out.push({ k: 'settings', value: {
              adder: Number(res[1].data.adder) || 0,
              dispUnit: res[1].data.disp_unit || 'usd'
            } });
          }
          return out;
        });
      }
      return Promise.resolve([]);
    },

    put: function (name, obj) {
      var id = uid();
      if (!id) return Promise.reject(new Error('Not signed in'));

      if (name === 'sets') {
        return sb.from('price_sets').upsert({
          user_id: id, id: obj.id, filename: obj.filename, supplier: obj.supplier,
          price_date: obj.priceDate || null, row_count: obj.rowCount
        }).then(function (r) { if (r.error) throw err(r.error); });
      }

      if (name === 'rows') {
        return sb.from('price_set_rows').upsert({
          user_id: id, set_id: obj.setId, rows: obj.rows
        }).then(function (r) {
          if (r.error) throw err(r.error);
          // refresh the cache stamp so the next load skips a re-download
          return sb.from('price_sets').select('updated_at').eq('id', obj.setId).maybeSingle()
            .then(function (s) {
              return Cache.put(id, obj.setId, s.data ? s.data.updated_at : null, obj.rows);
            });
        });
      }

      if (name === 'kv') {
        if (obj.k === 'settings') {
          return sb.from('user_settings').upsert({
            user_id: id,
            adder: obj.value.adder || 0,
            disp_unit: obj.value.dispUnit || 'usd'
          }).then(function (r) { if (r.error) throw err(r.error); });
        }
        if (obj.k && obj.k.indexOf('map:') === 0) {
          return sb.from('column_mappings').upsert({
            user_id: id, signature: obj.k.slice(4), mapping: obj.value
          }).then(function (r) { if (r.error) throw err(r.error); });
        }
      }
      return Promise.resolve();
    },

    del: function (name, key) {
      var id = uid();
      if (!id) return Promise.resolve();
      if (name === 'sets' || name === 'rows') {
        // price_set_rows cascades from price_sets, so one delete covers both
        return sb.from('price_sets').delete().eq('id', key).then(function (r) {
          if (r.error) throw err(r.error);
          return Cache.del(id, key);
        });
      }
      return Promise.resolve();
    },

    clear: function (name) {
      var id = uid();
      if (!id) return Promise.resolve();
      if (name === 'sets' || name === 'rows') {
        return sb.from('price_sets').delete().eq('user_id', id).then(function (r) {
          if (r.error) throw err(r.error);
          return Cache.clear();
        });
      }
      if (name === 'kv') {
        return sb.from('column_mappings').delete().eq('user_id', id)
          .then(function () {
            return sb.from('user_settings').upsert({ user_id: id, adder: 0, disp_unit: 'usd' });
          });
      }
      return Promise.resolve();
    }
  };

  /* ================= auth screen ================= */

  function el(id) { return document.getElementById(id); }

  function showAuth(show) {
    el('authGate').classList.toggle('open', !!show);
    document.body.classList.toggle('signed-out', !!show);
  }

  function authError(msg) {
    var e = el('authError');
    e.textContent = msg || '';
    e.style.display = msg ? 'block' : 'none';
  }

  function authBusy(busy, label) {
    el('authSubmit').disabled = !!busy;
    el('authSubmit').textContent = busy ? (label || 'Working…') : (mode === 'signup' ? 'Create account' : 'Sign in');
  }

  var mode = 'signin';
  var pendingEmail = '';

  /* Where the confirmation link should land. Whatever this returns must also be
   * listed under Redirect URLs in the Supabase dashboard, or Auth rejects it. */
  function confirmTarget() {
    return window.location.origin + window.location.pathname + '?confirmed=1';
  }

  function showVerifySent(email) {
    pendingEmail = email;
    el('verifyEmail').textContent = email;
    el('authForm').style.display = 'none';
    el('verifySent').style.display = '';
  }

  function hideVerifySent() {
    el('verifySent').style.display = 'none';
    el('authForm').style.display = '';
  }

  function resendConfirmation() {
    if (!pendingEmail) return;
    var btn = el('verifyResend');
    btn.disabled = true;
    btn.textContent = 'Sending\u2026';
    sb.auth.resend({ type: 'signup', email: pendingEmail,
                     options: { emailRedirectTo: confirmTarget() } })
      .then(function (r) {
        btn.disabled = false;
        btn.textContent = 'Resend the email';
        if (r.error) {
          notice(r.error.message, true);
        } else {
          notice('Sent again to ' + pendingEmail + '.');
        }
      });
  }

  function notice(msg, bad) {
    var n = el('authNotice');
    n.textContent = msg;
    n.className = 'pill ' + (bad ? 'warn' : 'ok');
    n.style.display = msg ? 'block' : 'none';
  }

  /* Coming back from a confirmation link: Supabase appends its own params, and
   * we add ?confirmed=1. Greet them and get them straight into sign-in rather
   * than dropping them on an unexplained blank form. */
  function handleConfirmationReturn() {
    var qs = window.location.search || '';
    var hash = window.location.hash || '';
    var confirmed = /[?&]confirmed=1/.test(qs);
    var errored = /error_description=|error=/.test(qs + hash);

    if (errored) {
      var m = decodeURIComponent(
        ((qs + '&' + hash.replace('#', '&')).match(/error_description=([^&]*)/) || [, ''])[1]
      ).replace(/\+/g, ' ');
      notice(m || 'That confirmation link is no longer valid. Request a new one below.', true);
    } else if (confirmed) {
      notice('Email confirmed. Sign in to start your trial.');
    }

    if (confirmed || errored) {
      // strip the auth noise so a refresh does not replay it
      window.history.replaceState({}, document.title,
        window.location.origin + window.location.pathname);
    }
  }

  function setMode(m) {
    mode = m;
    hideVerifySent();
    el('authTitle').textContent = m === 'signup' ? 'Create your account' : 'Sign in';
    el('authSubmit').textContent = m === 'signup' ? 'Create account' : 'Sign in';
    el('authSwitchText').textContent = m === 'signup' ? 'Already have an account?' : 'No account yet?';
    el('authSwitch').textContent = m === 'signup' ? 'Sign in' : 'Start a free trial';
    el('authCompanyRow').style.display = m === 'signup' ? '' : 'none';
    el('authTrialNote').style.display = m === 'signup' ? '' : 'none';
    authError('');
  }

  function submitAuth() {
    var email = el('authEmail').value.trim();
    var pass = el('authPassword').value;
    var company = el('authCompany').value.trim();
    authError('');

    if (!email || !pass) { authError('Enter your email and password.'); return; }
    if (mode === 'signup' && pass.length < 8) {
      authError('Use a password of at least 8 characters.'); return;
    }

    authBusy(true, mode === 'signup' ? 'Creating…' : 'Signing in…');

    /* Supabase falls back to the project's Site URL when no redirect is named,
     * and that defaults to localhost — which would send every confirmation
     * link somewhere the user cannot reach. Name it explicitly. */
    var p = mode === 'signup'
      ? sb.auth.signUp({
          email: email, password: pass,
          options: { data: { company: company }, emailRedirectTo: confirmTarget() }
        })
      : sb.auth.signInWithPassword({ email: email, password: pass });

    p.then(function (r) {
      authBusy(false);
      if (r.error) { authError(r.error.message); return; }
      if (mode === 'signup' && !(r.data && r.data.session)) {
        // email confirmation is on, so there is no session yet
        showVerifySent(email);
        return;
      }
      return boot().then(function (u) {
        // app.js listens for this to pull the account's pricing
        if (u) window.dispatchEvent(new CustomEvent('pinnacle:signedin'));
      });
    }).catch(function (e) {
      authBusy(false);
      authError(e.message || String(e));
    });
  }

  function signOut() {
    return sb.auth.signOut().then(function () {
      return Cache.clear();
    }).then(function () {
      window.location.reload();
    });
  }

  /* ================= boot ================= */

  function boot() {
    return loadAccount().then(function (user) {
      state.ready = true;
      if (!user) { showAuth(true); return null; }
      showAuth(false);
      return user;
    });
  }

  window.PinnacleAccount = {
    client: sb,
    state: state,
    licenseState: licenseState,
    boot: boot,
    signOut: signOut,
    showAuth: showAuth,
    setMode: setMode,
    submitAuth: submitAuth,
    isSignedIn: function () { return !!state.user; },
    email: function () { return state.user ? state.user.email : ''; },
    company: function () { return state.profile ? (state.profile.company || '') : ''; },
    bindAuthUi: function () {
      el('authSubmit').onclick = submitAuth;
      el('authSwitch').onclick = function () { setMode(mode === 'signup' ? 'signin' : 'signup'); };
      el('authForm').onsubmit = function (e) { e.preventDefault(); submitAuth(); };

      // reveal control — typing a password you cannot read is a real problem,
      // especially on a phone keyboard
      el('pwToggle').onclick = function () {
        var f = el('authPassword');
        var show = f.type === 'password';
        f.type = show ? 'text' : 'password';
        this.textContent = show ? 'Hide' : 'Show';
        this.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
        f.focus();
      };

      el('verifyResend').onclick = resendConfirmation;
      el('verifyBack').onclick = function () { hideVerifySent(); setMode('signin'); };

      setMode('signin');
      handleConfirmationReturn();
    }
  };

  window.PinnacleStore = Store;
})();
