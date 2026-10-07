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
  let journal = null, journalSha = null, quotes = null, daily = null;
  let tabCourant = 'today';
  let attente = false;

  const num = (v) => { const x = parseFloat(String(v).replace(/\s/g, '').replace(',', '.')); return isFinite(x) ? x : null; };
  const nb = (x, d = 0) => (x == null || !isFinite(x) ? '—' : Number(x).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d }).replace(/ | /g, ' '));
  const pct = (x, signe) => (x == null ? '—' : (signe && x > 0 ? '+' : '') + nb(x, 2) + ' %');
  const jj = (d) => (d ? d.slice(8, 10) + '/' + d.slice(5, 7) : '?');
  const cls = (x) => (x == null ? '' : x >= 0 ? 'up' : 'down');

  /* ---------- GitHub : UTF-8 par TextDecoder/TextEncoder, base64 sans atob/btoa ---------- */
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function b64Encode(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
      s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? B64[n & 63] : '=');
    }
    return s;
  }
  function b64Decode(str) {
    const c = str.replace(/[^A-Za-z0-9+/]/g, ''), out = new Uint8Array(Math.floor((c.length * 3) / 4));
    let o = 0;
    for (let i = 0; i < c.length; i += 4) {
      const n = (B64.indexOf(c[i]) << 18) | (B64.indexOf(c[i + 1]) << 12) | ((B64.indexOf(c[i + 2]) & 63) << 6) | (B64.indexOf(c[i + 3]) & 63);
      out[o++] = (n >> 16) & 255; if (i + 2 < c.length) out[o++] = (n >> 8) & 255; if (i + 3 < c.length) out[o++] = n & 255;
    }
    return out.subarray(0, o);
  }
  const utf8 = (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const enTete = (extra) => Object.assign({ Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' }, extra || {});
  async function lireMeta(fichier) {
    const r = await fetch(`https://api.github.com/repos/${BRIEF}/contents/${fichier}?ref=data&t=${Date.now()}`, { headers: enTete(), cache: 'no-store' });
    if (r.status === 401 || r.status === 403 || r.status === 404) { const e = new Error('acces'); e.status = r.status; throw e; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const m = await r.json();
    return { data: JSON.parse(utf8(b64Decode(m.content))), sha: m.sha };
  }
  const lire = async (f) => (await lireMeta(f)).data;
  // Écrit journal.json sur data. Conflit (modifié ailleurs) → erreur 'conflit', rien n'est écrasé.
  async function ecrireJournal(nouveau, message) {
    const texte = JSON.stringify(nouveau, null, 2) + '\n';
    const r = await fetch(`https://api.github.com/repos/${BRIEF}/contents/journal.json`, {
      method: 'PUT', headers: enTete({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ message, content: b64Encode(new TextEncoder().encode(texte)), sha: journalSha, branch: 'data' }),
    });
    if (r.status === 409 || r.status === 422) { const e = new Error('conflit'); e.conflit = true; throw e; }
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
    const out = await r.json();
    journal = nouveau; journalSha = out.content.sha;
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
      let jm;
      [jm, quotes, daily] = await Promise.all([lireMeta('journal.json'), lire('quotes/latest.json'), lire('daily/latest.json').catch(() => null)]);
      journal = jm.data; journalSha = jm.sha;
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
        <div class="bar" role="img" aria-label="Marge avant barrière"><i style="width:${larg}%;background:${col}"></i></div>
        <div class="actions"><button class="btn ghost" data-act="prix" data-id="${esc(p.id)}">Prix courtier</button>
          <button class="btn ghost" data-act="strike" data-id="${esc(p.id)}">Vrai strike</button>
          <button class="btn" data-act="vente" data-id="${esc(p.id)}">Vendre</button></div></div>`;
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

  /* ---------- feuilles : saisie → confirmation (totaux) → écriture ---------- */
  const auj = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
  const maintenantHM = () => new Date().toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
  const champ = (id, lib, val, mode) => `<label>${lib}<input id="${id}" ${mode === 'date' ? 'type="date"' : mode === 'time' ? 'type="time"' : 'inputmode="' + (mode || 'decimal') + '"'} value="${esc(val == null ? '' : val)}"></label>`;
  const ligne = (k, v, c) => `<dt>${k}</dt><dd class="num ${c || ''}">${v}</dd>`;
  const val = (id) => { const e = $(id); return e ? e.value.trim() : ''; };
  function toast(msg, kind) { const t = $('toast'); t.textContent = msg; t.className = 'toast show ' + (kind || ''); clearTimeout(t._h); t._h = setTimeout(() => { t.className = 'toast'; }, 3500); }
  // Nouveau nœud à chaque feuille : les écouteurs de la feuille précédente disparaissent avec l'ancien.
  function ouvrir(html) {
    const ancien = $('sheet-body'), neuf = ancien.cloneNode(false);
    ancien.replaceWith(neuf); neuf.innerHTML = html; $('sheet').hidden = false;
  }
  function fermer() { $('sheet').hidden = true; $('sheet-body').innerHTML = ''; }
  $('sheet').addEventListener('click', (e) => { if (e.target === $('sheet') || e.target.dataset.fermer != null) fermer(); });

  // Étape 2 commune : récapitulatif chiffré, puis écriture seulement après « Valider ».
  function confirmer(titre, recap, appliquer, message) {
    ouvrir(`<h2 id="sheet-t">${titre}</h2><p>Vérifiez avant d'écrire dans le journal.</p>
      <div class="recap"><dl class="calc">${recap}</dl></div><p class="err" id="w-err" role="alert"></p>
      <div class="row"><button class="btn ghost" data-fermer>Annuler</button><button class="btn" id="w-ok">Valider</button></div>`);
    $('w-ok').onclick = async () => {
      $('w-ok').disabled = true; $('w-ok').textContent = 'Écriture…';
      const copie = JSON.parse(JSON.stringify(journal));
      try {
        appliquer(copie);
        await ecrireJournal(copie, message);
        fermer(); rendre(); toast('Enregistré dans le journal.', 'ok');
      } catch (e) {
        if (e.conflit) { fermer(); await charger(); toast('Le journal a changé ailleurs. Rien n\'est écrit. Recommencez.', 'ko'); return; }
        $('w-err').textContent = e.status === 403 || e.status === 404 ? 'Écriture refusée : la clé doit avoir Contenu en écriture sur turbo-brief.' : 'Écriture impossible (' + e.message + '). Rien n\'est écrit.';
        $('w-ok').disabled = false; $('w-ok').textContent = 'Valider';
      }
    };
  }
  const trouver = (j, id) => j.positions.find((p) => p.id === id);
  function nouvelId(j) {
    const n = Math.max(0, ...j.positions.map((p) => parseInt(String(p.id).replace(/\D/g, ''), 10) || 0)) + 1;
    return 'p' + String(n).padStart(2, '0');
  }

  /* 1) + Trade : achat d'une nouvelle position */
  function feuilleTrade() {
    const R = C.REGLES;
    ouvrir(`<h2 id="sheet-t">Nouveau trade</h2>
      <div class="grid2"><label>Sous-jacent<select id="t-sj"><option value="NQ">Nasdaq 100</option><option value="CAC40">CAC 40</option><option value="SP500">S&amp;P 500</option></select></label>
        <label>Sens<select id="t-sens"><option>CALL</option><option>PUT</option></select></label></div>
      <div class="grid2">${champ('t-strike', 'Strike', '')}${champ('t-barr', 'Barrière (vide = strike)', '')}</div>
      <div class="grid2">${champ('t-parite', 'Parité', 100)}${champ('t-em', 'Émetteur', 'SG', 'text')}</div>
      ${champ('t-isin', 'ISIN (facultatif)', '', 'text')}
      <div class="grid2">${champ('t-prix', 'Prix du turbo (€)', '')}${champ('t-mise', 'Mise (€)', R.mise_defaut_eur)}</div>
      <div class="grid2">${champ('t-q', 'Quantité', '', 'numeric')}${champ('t-frais', 'Frais (€)', 0)}</div>
      <div class="grid2">${champ('t-date', 'Date', auj(), 'date')}${champ('t-heure', 'Heure', maintenantHM(), 'time')}</div>
      <div class="grid2">${champ('t-stop', 'Stop (%)', R.stop_pct)}${champ('t-conv', 'Conviction /10', '', 'numeric')}</div>
      <div class="grid2">${champ('t-ssl', 'Stop sous-jacent', '')}${champ('t-cible', 'Cible sous-jacent', '')}</div>
      ${champ('t-note', 'Note (facultatif)', '', 'text')}
      <dl class="calc" id="t-out"></dl><p class="err" id="t-err" role="alert"></p>
      <div class="row"><button class="btn ghost" data-fermer>Fermer</button><button class="btn" id="t-go">Vérifier</button></div>`);
    let qAuto = true;
    $('t-q').addEventListener('input', () => { qAuto = false; });
    const maj = () => {
      const prix = num(val('t-prix')), mise = num(val('t-mise')), stop = num(val('t-stop'));
      const d = C.dimensionner({ prixTurbo: prix, mise: mise == null ? NaN : mise, stopPct: stop == null ? R.stop_pct : stop });
      if (d && qAuto) $('t-q').value = d.quantite;
      const q = num(val('t-q')), sj = val('t-sj'), qt = px(C.SOUS_JACENTS[sj].quote), spotNow = qt && qt.price;
      const rr = C.ratioGainRisque(spotNow, num(val('t-ssl')), num(val('t-cible')));
      const strike = num(val('t-strike'));
      const theo = C.valeurTheorique({ spot: spotNow, strike, sens: val('t-sens'), parite: num(val('t-parite')), devise: C.SOUS_JACENTS[sj].devise, eurusd: eurusd() });
      let h = '';
      if (prix != null && q) {
        const eng = q * prix + (num(val('t-frais')) || 0), perte = q * prix * (-(stop == null ? R.stop_pct : stop) / 100);
        h += ligne('Engagé', C.formatEur(eng)) + ligne('Perte au stop', C.formatEur(-perte), 'down')
          + (R.poche_eur ? ligne('Part de la poche', pct((perte / R.poche_eur) * 100)) : '');
      }
      if (theo != null) h += ligne('Prix théorique', nb(theo, 3) + ' €');
      if (strike != null && spotNow) h += ligne('Levier', '×' + nb(C.levier(spotNow, strike, val('t-sens')), 1)) + ligne('Marge avant barrière', pct(C.distanceBarriere(spotNow, num(val('t-barr')) ?? strike, val('t-sens'))));
      if (rr != null) h += ligne('Gain / risque', nb(rr, 2));
      $('t-out').innerHTML = h;
    };
    $('sheet-body').addEventListener('input', maj); $('sheet-body').addEventListener('change', maj); maj();
    $('t-go').onclick = () => {
      const sj = val('t-sj'), sens = val('t-sens'), strike = num(val('t-strike')), parite = num(val('t-parite'));
      const prix = num(val('t-prix')), q = num(val('t-q')), frais = num(val('t-frais')) ?? 0, stop = num(val('t-stop'));
      const err = !(strike > 0) ? 'Entrez le strike.' : !(parite > 0) ? 'Entrez la parité.' : !(prix > 0) ? 'Entrez le prix du turbo.'
        : !(q > 0 && Number.isInteger(q)) ? 'Entrez une quantité entière.' : frais < 0 ? 'Frais négatifs ?' : !(stop < 0 && stop > -100) ? 'Stop entre −1 et −99 %.'
        : !/^\d{4}-\d{2}-\d{2}$/.test(val('t-date')) ? 'Entrez la date.' : '';
      if (err) { $('t-err').textContent = err; return; }
      const barriere = num(val('t-barr')) ?? strike, conv = num(val('t-conv'));
      const em = val('t-em') || null, sjNom = { NQ: 'NQ', CAC40: 'CAC40', SP500: 'SP500' }[sj];
      const pos = {
        id: nouvelId(journal), libelle: `${sens} ${sjNom} ${strike} Turbo${barriere === strike ? ' BEST' : ''}${em ? ' (' + em + ')' : ''}`,
        sous_jacent: sjNom, sens, emetteur: em, isin: val('t-isin') || null, reference_courtier: null,
        strike, barriere, parite, devise: C.SOUS_JACENTS[sj].devise,
        executions: [{ date: val('t-date'), heure: val('t-heure') || null, type: 'achat', quantite: q, prix, frais }],
        plan: { stop_pct: stop, stop_prix: null, cibles: num(val('t-cible')) != null ? [num(val('t-cible'))] : [], invalidation: num(val('t-ssl')) },
        conviction: conv, setup: null, reco_liee: null, regle_respectee: null, note: val('t-note') || null,
      };
      const montant = C.montantExecution(pos.executions[0]), avant = C.cash(journal);
      confirmer('Confirmer l\'achat',
        ligne('Position', esc(pos.libelle)) + ligne('Achat', `${nb(q)} × ${nb(prix, 3)} €`) + ligne('Frais', C.formatEur(frais))
        + ligne('Engagé', C.formatEur(montant)) + ligne('Caisse', `${C.formatEur(avant)} → ${C.formatEur(avant - montant)}`, avant - montant < 0 ? 'down' : '')
        + ligne('Stop turbo', nb(prix * (1 + stop / 100), 3) + ' €') + ligne('Perte au stop', C.formatEur(-(q * prix * -stop / 100)), 'down'),
        (j) => { pos.id = nouvelId(j); j.positions.push(pos); },
        `journal: achat ${pos.libelle} (${q} × ${prix})`);
    };
  }

  /* 2) Vendre tout ou partie */
  function feuilleVente(id) {
    const p = trouver(journal, id), b = C.bilanPosition(p);
    ouvrir(`<h2 id="sheet-t">Vendre</h2><p>${esc(p.libelle)} · reste ${nb(b.quantite_restante)} · PRU ${nb(b.pru, 3)} €</p>
      <div class="grid2">${champ('v-q', 'Quantité', b.quantite_restante, 'numeric')}${champ('v-prix', 'Prix de vente (€)', '')}</div>
      <div class="grid2">${champ('v-frais', 'Frais (€)', 0)}${champ('v-date', 'Date', auj(), 'date')}</div>
      ${champ('v-heure', 'Heure', maintenantHM(), 'time')}${champ('v-note', 'Note (facultatif)', '', 'text')}
      <p class="err" id="v-err" role="alert"></p>
      <div class="row"><button class="btn ghost" data-fermer>Fermer</button><button class="btn" id="v-go">Vérifier</button></div>`);
    $('v-go').onclick = () => {
      const q = num(val('v-q')), prix = num(val('v-prix')), frais = num(val('v-frais')) ?? 0;
      const err = !(q > 0 && Number.isInteger(q) && q <= b.quantite_restante) ? `Quantité entière entre 1 et ${b.quantite_restante}.` : !(prix >= 0) ? 'Entrez le prix de vente.'
        : frais < 0 ? 'Frais négatifs ?' : !/^\d{4}-\d{2}-\d{2}$/.test(val('v-date')) ? 'Entrez la date.' : '';
      if (err) { $('v-err').textContent = err; return; }
      const ex = { date: val('v-date'), heure: val('v-heure') || null, type: 'vente', quantite: q, prix, frais };
      if (val('v-note')) ex.note = val('v-note');
      const apres = C.bilanPosition({ ...p, executions: [...p.executions, ex] });
      const m = C.montantExecution(ex), pnl = m - b.pru * q, avant = C.cash(journal);
      confirmer('Confirmer la vente',
        ligne('Vente', `${nb(q)} × ${nb(prix, 3)} €`) + ligne('Frais', C.formatEur(frais)) + ligne('Reçu', C.formatEur(m))
        + ligne('Gain / perte de cette vente', C.formatEur(pnl, { signe: true }), cls(pnl))
        + ligne('Caisse', `${C.formatEur(avant)} → ${C.formatEur(avant + m)}`)
        + ligne('Position après', apres.statut === 'fermee' ? 'fermée, ' + C.formatEur(apres.pnl_realise, { signe: true }) : 'ouverte, reste ' + nb(apres.quantite_restante)),
        (j) => { trouver(j, id).executions.push(ex); },
        `journal: vente ${p.libelle} (${q} × ${prix})`);
    };
  }

  /* 3) Prix courtier, avec l'heure (fait foi 30 min) */
  function feuillePrix(id) {
    const p = trouver(journal, id), b = C.bilanPosition(p);
    ouvrir(`<h2 id="sheet-t">Prix courtier</h2><p>${esc(p.libelle)}</p>
      <div class="grid2">${champ('b-prix', 'Prix vu chez le courtier (€)', '')}${champ('b-heure', 'Heure', maintenantHM(), 'time')}</div>
      <p class="err" id="b-err" role="alert"></p>
      <div class="row"><button class="btn ghost" data-fermer>Fermer</button><button class="btn" id="b-go">Vérifier</button></div>`);
    $('b-go').onclick = () => {
      const prix = num(val('b-prix')), hm = val('b-heure');
      if (!(prix >= 0) || !/^\d{2}:\d{2}$/.test(hm)) { $('b-err').textContent = 'Entrez le prix et l\'heure.'; return; }
      // heure de Paris → instant UTC (décalage du moment)
      const d = new Date(), local = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
      const [hh, mm] = hm.split(':').map(Number); local.setHours(hh, mm, 0, 0);
      const decalage = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Paris' })) - d;
      const heure = new Date(Math.round((local.getTime() - decalage) / 60000) * 60000).toISOString();
      const latent = (prix - b.pru) * b.quantite_restante;
      const stopPrix = b.pru * (1 + ((p.plan && p.plan.stop_pct) ?? C.REGLES.stop_pct) / 100);
      confirmer('Confirmer le prix',
        ligne('Prix', nb(prix, 3) + ' € à ' + esc(hm)) + ligne('PRU', nb(b.pru, 3) + ' €') + ligne('Latent avec ce prix', C.formatEur(latent, { signe: true }), cls(latent))
        + ligne('Stop touché ?', prix <= stopPrix ? 'OUI' : 'non', prix <= stopPrix ? 'down' : ''),
        (j) => { trouver(j, id).prix_broker = { prix, heure }; },
        `journal: prix courtier ${p.libelle} ${prix}`);
    };
  }

  /* 4) Vrai strike d'un BEST (nouveau point de départ de l'estimation) */
  function feuilleStrike(id) {
    const p = trouver(journal, id), estime = C.strikeDuJour(p, auj());
    ouvrir(`<h2 id="sheet-t">Vrai strike</h2><p>${esc(p.libelle)} · estimé aujourd'hui ${nb(estime, 2)}</p>
      <div class="grid2">${champ('k-strike', 'Strike vu chez l\'émetteur', '')}${champ('k-date', 'Date', auj(), 'date')}</div>
      <p class="err" id="k-err" role="alert"></p>
      <div class="row"><button class="btn ghost" data-fermer>Fermer</button><button class="btn" id="k-go">Vérifier</button></div>`);
    $('k-go').onclick = () => {
      const k = num(val('k-strike')), d = val('k-date');
      if (!(k > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(d)) { $('k-err').textContent = 'Entrez le strike et la date.'; return; }
      const sp = spot(p), theo = C.valeurTheorique({ spot: sp, strike: k, sens: p.sens, parite: p.parite, devise: C.devisePosition(p), eurusd: eurusd() });
      const ecart = estime ? ((k - estime) / estime) * 100 : null;
      confirmer('Confirmer le strike',
        ligne('Strike estimé → saisi', `${nb(estime, 2)} → ${nb(k, 2)}`) + (ecart != null ? ligne('Écart', pct(ecart, true), Math.abs(ecart) > 1 ? 'warn' : '') : '')
        + ligne('Prix théorique', theo == null ? '—' : nb(theo, 3) + ' €') + ligne('Marge avant barrière', pct(C.distanceBarriere(sp, k, p.sens))),
        (j) => { const x = trouver(j, id); x.strike_ref = k; x.date_ref = d; },
        `journal: strike ${p.libelle} ${k} au ${d}`);
    };
  }

  $('fab').onclick = () => { if (journal) feuilleTrade(); };
  $('tab-pos').addEventListener('click', (e) => {
    const bt = e.target.closest('button[data-act]'); if (!bt) return;
    ({ vente: feuilleVente, prix: feuillePrix, strike: feuilleStrike })[bt.dataset.act](bt.dataset.id);
  });

  /* ---------- démarrage ---------- */
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (token) connecte(); else deconnecter('');
})();
