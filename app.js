/* Turbo Desk — écrans (tâche 3.2, lecture seule). Les calculs sont dans calc.js. */
(function () {
  'use strict';
  const C = window.Calc;
  const OWNER = 'guigs69210-eng', BRIEF = OWNER + '/turbo-brief';
  const FRAICHEUR_MAX_MIN = 15;     // au-delà, on relance quotes.yml
  const ATTENTE_MAX_S = 180;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignoré */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignoré */ } },
  };
  let token = store.get('td_token');
  let journal = null, quotes = null, daily = null;
  let tabCourant = 'today';
  let attente = false;

  const num = (v) => { const x = parseFloat(String(v).replace(/\s/g, '').replace(',', '.')); return isFinite(x) ? x : null; };
  const nb = (x, d = 0) => (x == null || !isFinite(x) ? '—' : Number(x).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d }).replace(/ | /g, ' '));
  const pct = (x, signe) => (x == null ? '—' : (signe && x > 0 ? '+' : '') + nb(x, 2) + ' %');
  const jj = (d) => (d ? d.slice(8, 10) + '/' + d.slice(5, 7) : '?');
  const cls = (x) => (x == null ? '' : x >= 0 ? 'up' : 'down');

  /* ---------- GitHub (lecture) : UTF-8 par TextDecoder ---------- */
  async function lire(fichier) {
    const r = await fetch(`https://api.github.com/repos/${BRIEF}/contents/${fichier}?ref=data&t=${Date.now()}`, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github.raw+json' },
      cache: 'no-store',
    });
    if (r.status === 401 || r.status === 403 || r.status === 404) { const e = new Error('acces'); e.status = r.status; throw e; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await r.arrayBuffer()));
  }
  async function lancerCours() {
    const r = await fetch(`https://api.github.com/repos/${BRIEF}/actions/workflows/quotes.yml/dispatches`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main' }),
    });
    return r.status === 204;
  }

  /* ---------- fraîcheur ---------- */
  const ageMin = () => (quotes && quotes.generated_at ? (Date.now() - Date.parse(quotes.generated_at)) / 60000 : null);
  function majFraicheur(msg) {
    const el = $('fresh'), a = ageMin();
    if (msg) { el.textContent = msg; el.className = 'fresh old'; return; }
    if (a == null) { el.textContent = ''; return; }
    el.textContent = 'Cours il y a ' + (a < 1 ? 'moins d\'1 min' : a < 90 ? Math.round(a) + ' min' : Math.round(a / 60) + ' h');
    el.className = 'fresh' + (a > FRAICHEUR_MAX_MIN ? ' old' : '');
  }

  /* ---------- chargement ---------- */
  async function charger() {
    const btn = $('refresh'); btn.classList.add('spin');
    try {
      [journal, quotes, daily] = await Promise.all([lire('journal.json'), lire('quotes/latest.json'), lire('daily/latest.json').catch(() => null)]);
      C.configurer(journal.regles || {});
      majFraicheur(); rendre();
    } catch (e) {
      if (e.status) { deconnecter('Clé refusée ou sans accès à turbo-brief. Collez-en une autre.'); }
      else majFraicheur('Pas de réseau');
    } finally { btn.classList.remove('spin'); }
  }
  async function actualiser() {
    await charger();
    const a = ageMin();
    if (a != null && a > FRAICHEUR_MAX_MIN && !attente) await relancerEtAttendre();
  }
  async function relancerEtAttendre() {
    const dernier = Number(store.get('td_dispatch') || 0);
    if (Date.now() - dernier < 10 * 60000) return;            // une relance par 10 min
    attente = true;
    try {
      if (!(await lancerCours())) { majFraicheur('Relance impossible (droits Actions ?)'); return; }
      store.set('td_dispatch', String(Date.now()));
      const avant = quotes ? quotes.generated_at : null;
      for (let t = 0; t < ATTENTE_MAX_S; t += 15) {
        majFraicheur('Mise à jour des cours… ' + (ATTENTE_MAX_S - t) + ' s');
        await new Promise((r) => setTimeout(r, 15000));
        try { const q = await lire('quotes/latest.json'); if (q.generated_at !== avant) { quotes = q; majFraicheur(); rendre(); return; } } catch (e) { /* on réessaie */ }
      }
      majFraicheur('Cours pas encore à jour');
    } finally { attente = false; }
  }

  /* ---------- données dérivées ---------- */
  const px = (t) => (quotes && quotes.quotes && quotes.quotes[t]) || null;
  function spot(p) {
    const k = C.cleSousJacent(p.sous_jacent), q = k && px(C.SOUS_JACENTS[k].quote);
    return q ? q.price : null;
  }
  const eurusd = () => (px('EURUSD=X') || {}).price;
  const suivis = () => (journal.positions || []).map((p) => ({ p, s: C.suiviPosition(p, { spot: spot(p), eurusd: eurusd(), prixBroker: p.prix_broker }) }));
  const ouvertes = () => suivis().filter((x) => x.s.statut === 'ouverte');

  /* ---------- écrans ---------- */
  function rendreAujourdhui() {
    const ouv = ouvertes();
    const latent = ouv.reduce((t, x) => t + (x.s.pnl_latent || 0), 0);
    const engage = ouv.reduce((t, x) => t + (x.s.cout_restant || 0), 0);
    const cash = C.cash(journal);
    const tk = (nom, t, d = 0) => { const q = px(t); return `<div class="tk"><span class="lbl">${nom}</span><b class="num">${q ? nb(q.price, d) : '—'}</b><small class="num ${cls(q && q.change_pct)}">${q ? pct(q.change_pct, true) : ''}</small></div>`; };
    const trous = (journal.trous || []).map((t) => `<div class="banner">${esc(t.message)}</div>`).join('');
    const pea = [['LVMH', 'MC.PA'], ['Stellantis', 'STLAP.PA'], ['TotalEnergies', 'TTE.PA'], ['Air Liquide', 'AI.PA'], ['Schneider', 'SU.PA'], ['LQQ', 'LQQ.PA']]
      .map(([n, t]) => { const q = px(t); return `<div class="list-row"><span class="t">${n}</span><span class="num">${q ? nb(q.price, 2) + ' € <span class="' + cls(q.change_pct) + '">' + pct(q.change_pct, true) + '</span>' : '—'}</span></div>`; }).join('');
    const inst = daily && daily.instruments ? Object.entries(daily.instruments).map(([n, i]) => `<div class="list-row"><span class="l"><span class="t">${esc(n)}</span><span class="s num">Pivot ${nb(i.pivots.P)} · R1 ${nb(i.pivots.R1)} · S1 ${nb(i.pivots.S1)}</span></span><span class="num s">ATR ${nb(i.atr14_pct, 2)} %</span></div>`).join('') : '';
    $('tab-today').innerHTML = trous +
      `<div class="card hero"><div><div class="lbl">Cash</div><div class="big num">${C.formatEur(cash)}</div></div>
        <div><div class="lbl">Latent (${ouv.length} position${ouv.length > 1 ? 's' : ''})</div><div class="big num ${cls(latent)}">${C.formatEur(latent, { signe: true })}</div></div>
        <div><div class="lbl">Engagé</div><div class="num">${C.formatEur(engage)}</div></div></div>` +
      `<div class="card"><h2>Marchés</h2><div class="ticker">${tk('Nasdaq 100', 'NQ=F')}${tk('CAC 40', '^FCHI')}${tk('S&P 500', '^GSPC')}${tk('VIX', '^VIX', 2)}${tk('EUR/USD', 'EURUSD=X', 4)}</div></div>` +
      (inst ? `<div class="card"><h2>Veille (${esc(daily.date_paris)})</h2>${inst}</div>` : '') +
      `<div class="card"><h2>PEA</h2>${pea}</div>`;
  }

  function rendrePositions() {
    const ouv = ouvertes();
    if (!ouv.length) { $('tab-pos').innerHTML = '<div class="empty">Aucune position ouverte.</div>'; return; }
    $('tab-pos').innerHTML = ouv.map(({ p, s }) => {
      const d = s.distance_barriere_pct;
      const col = d == null ? 'var(--muted)' : d < 1 ? 'var(--red)' : d < 2.5 ? 'var(--amber)' : 'var(--green)';
      const larg = d == null ? 0 : Math.max(0, Math.min(100, d * 10));
      const src = s.source ? `<span class="tag ${s.source === 'BROKER' ? 'broker' : 'theo'}">${s.source}</span>` : '';
      return `<div class="card"><div class="list-row" style="border:0;padding:0"><span class="l"><span class="t">${esc(p.libelle)}</span>${src}</span>
        <b class="num ${cls(s.pnl_latent)}">${C.formatEur(s.pnl_latent, { signe: true })}</b></div>
        <div class="grid4"><div class="lbl">Prix<b class="num">${nb(s.prix, 3)}</b></div><div class="lbl">PRU<b class="num">${nb(s.pru, 3)}</b></div>
          <div class="lbl">Stop<b class="num">${nb(s.stop_prix, 3)}</b></div><div class="lbl">Levier<b class="num">${s.levier == null ? '—' : '×' + nb(s.levier, 1)}</b></div></div>
        <div class="lbl">Marge avant barrière : <span class="num">${pct(d)}</span> · risque au stop <span class="num">${C.formatEur(s.risque_stop_eur)}</span></div>
        <div class="bar" role="img" aria-label="Marge avant barrière"><i style="width:${larg}%;background:${col}"></i></div></div>`;
    }).join('');
  }

  function rendreJournal() {
    const fermees = suivis().filter((x) => x.s.statut === 'fermee')
      .sort((a, b) => String(b.s.date_sortie || '').localeCompare(String(a.s.date_sortie || '')));
    const trous = (journal.trous || []).map((t) => `<div class="banner">${esc(t.message)}</div>`).join('');
    $('tab-journal').innerHTML = trous + (fermees.length ? '<div class="card">' + fermees.map(({ p, s }) =>
      `<div class="list-row"><span class="l"><span class="t">${esc(p.libelle)}${s.doublon_probable ? '<span class="tag">doublon ?</span>' : ''}${s.incomplet ? '<span class="tag">incomplet</span>' : ''}</span>
        <span class="s">${jj(s.date_entree)} → ${jj(s.date_sortie)}</span></span>
        <b class="num ${cls(s.pnl_realise)}">${C.formatEur(s.pnl_realise, { signe: true })}</b></div>`).join('') + '</div>'
      : '<div class="empty">Journal vide.</div>');
  }

  function rendreStats() {
    const s = C.stats(journal), h = C.stats(journal, { sansDoublons: true });
    const c = (n, v, k) => `<div class="stat"><span class="lbl">${n}</span><b class="num ${k || ''}">${v}</b></div>`;
    $('tab-stats').innerHTML = `<div class="stats">
      ${c('P&L réalisé', C.formatEur(s.pnl_total, { signe: true }), cls(s.pnl_total))}
      ${c('Hors doublons', C.formatEur(h.pnl_total, { signe: true }), cls(h.pnl_total))}
      ${c('Réussite', s.taux_reussite_pct == null ? '—' : nb(s.taux_reussite_pct, 0) + ' %')}
      ${c('Positions fermées', s.positions_fermees)}
      ${c('Gain moyen', C.formatEur(s.gain_moyen, { signe: true }), 'up')}
      ${c('Perte moyenne', C.formatEur(s.perte_moyenne), 'down')}
      ${c('Profit factor', s.profit_factor == null ? '—' : nb(s.profit_factor, 2))}
      ${c('Creux maximal', C.formatEur(s.creux_max), 'down')}</div>` +
      (s.trous.length ? '<p class="muted" style="margin-top:12px">' + s.trous.map(esc).join('<br>') + '</p>' : '');
  }

  function rendre() {
    if (!journal) return;
    rendreAujourdhui(); rendrePositions(); rendreJournal(); rendreStats();
  }

  /* ---------- onglets, connexion ---------- */
  function afficherOnglet(t) {
    tabCourant = t;
    document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.id !== 'tab-' + t || !token; });
    document.querySelectorAll('#tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
    window.scrollTo(0, 0);
  }
  function deconnecter(msg) {
    token = ''; store.del('td_token'); journal = quotes = daily = null;
    $('login').hidden = false; $('tabs').hidden = true; $('fab').hidden = true;
    document.querySelectorAll('.tab').forEach((s) => { s.hidden = true; });
    $('login-err').textContent = msg || '';
  }
  function connecte() {
    $('login').hidden = true; $('tabs').hidden = false; $('fab').hidden = false;
    afficherOnglet(tabCourant); actualiser();
  }
  $('token-save').onclick = () => {
    const v = $('token-in').value.trim();
    if (!/^(github_pat_|ghp_)[A-Za-z0-9_]+$/.test(v)) { $('login-err').textContent = 'Cette clé n\'a pas la bonne forme.'; return; }
    token = v; store.set('td_token', v); $('token-in').value = ''; $('login-err').textContent = ''; connecte();
  };
  $('tabs').onclick = (e) => { const b = e.target.closest('button'); if (b) afficherOnglet(b.dataset.tab); };
  $('refresh').onclick = () => { store.del('td_dispatch'); actualiser(); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden && token) actualiser(); });

  /* ---------- « + Trade » : calculette ---------- */
  function calculette() {
    const prix = num($('n-prix').value), mise = num($('n-mise').value) ?? C.REGLES.mise_defaut_eur, stop = num($('n-stop').value);
    const d = C.dimensionner({ prixTurbo: prix, mise: mise == null ? NaN : mise, stopPct: stop == null ? C.REGLES.stop_pct : stop });
    const rr = C.ratioGainRisque(num($('n-entree').value), num($('n-ssl').value), num($('n-cible').value));
    const ligne = (k, v) => `<dt>${k}</dt><dd class="num">${v}</dd>`;
    $('n-out').innerHTML = d ? ligne('Quantité', nb(d.quantite)) + ligne('Engagé', C.formatEur(d.engage)) + ligne('Perte au stop', C.formatEur(-d.perte_stop))
      + (d.perte_stop_pct_poche != null ? ligne('Part de la poche', pct(d.perte_stop_pct_poche)) : '') + (rr != null ? ligne('Gain / risque', nb(rr, 2)) : '') : `<dt>${prix == null ? 'Entrez le prix du turbo.' : 'Entrez la mise.'}</dt><dd></dd>`;
  }
  $('fab').onclick = () => { $('n-mise').placeholder = C.REGLES.mise_defaut_eur ? String(C.REGLES.mise_defaut_eur) : ''; $('sheet').hidden = false; calculette(); };
  $('sheet-close').onclick = () => { $('sheet').hidden = true; };
  $('sheet').addEventListener('input', calculette);
  $('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) $('sheet').hidden = true; });

  /* ---------- démarrage ---------- */
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (token) connecte(); else deconnecter('');
})();
