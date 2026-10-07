/* Turbo Desk — écrans et écriture du journal. Les calculs sont dans calc.js. */
(function () {
  'use strict';
  const C = window.Calc;
  const OWNER = 'guigs69210-eng', BRIEF = OWNER + '/turbo-brief';
  const FRAICHEUR_MAX_MIN = 15;     // âge du relevé au-delà duquel on relance quotes.yml
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
    const exp = r.headers.get('github-authentication-token-expiration');
    if (exp) store.set('td_exp', exp);
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

  /* ---------- fraîcheur : âge réel des cours ---------- */
  const ageMin = () => (quotes && quotes.generated_at ? (Date.now() - Date.parse(quotes.generated_at)) / 60000 : null);
  const ageCours = (t) => { const q = quotes && quotes.quotes && quotes.quotes[t]; return q && q.quote_time ? Math.max(0, Math.round((Date.now() - Date.parse(q.quote_time)) / 60000)) : null; };
  function majFraicheur(msg) {
    const el = $('fresh');
    if (msg) { el.textContent = msg; el.className = 'fresh old'; return; }
    if (!quotes) { el.textContent = ''; return; }
    if (!C.marcheOuvert(Date.now())) { el.textContent = 'Marché fermé · dernier cours ' + C.heureParis(Date.parse(quotes.generated_at)); el.className = 'fresh'; return; }
    const ages = ['NQ=F', '^FCHI', '^GSPC'].map(ageCours).filter((x) => x != null), pire = ages.length ? Math.max(...ages) : null;
    el.textContent = pire == null ? '' : 'Cours en retard de ' + (pire < 90 ? pire + ' min' : Math.round(pire / 60) + ' h');
    el.className = 'fresh' + (pire > 20 ? ' old' : '');
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
  const marche = (p) => ({ spot: spot(p), eurusd: eurusd(), prixBroker: p.prix_broker });
  const suivis = () => (journal.positions || []).map((p) => ({ p, s: C.suiviPosition(p, marche(p)) }));
  const ouvertes = () => suivis().filter((x) => x.s.statut === 'ouverte');
  const calendrier = () => (daily && daily.calendrier) || [];
  const auj = () => C.jourParis(Date.now());
  const maintenantHM = () => C.heureParis(Date.now());
  const trouver = (j, id) => j.positions.find((p) => p.id === id);
  const eur = (x, o) => C.formatEur(x, o);
  const jourLong = (d) => (d ? d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4) : '?');
  const SJ_NOM = { NQ: 'Nasdaq 100', CAC40: 'CAC 40', SP500: 'S&P 500' };

  // Expiration de la clé : la date saisie dans Réglages fait foi ; sinon l'en-tête GitHub, quand le navigateur le laisse lire.
  function dateExp() {
    const u = /^\d{4}-\d{2}-\d{2}$/.test(store.get('td_exp_user')) ? Date.parse(store.get('td_exp_user') + 'T23:59:00') : NaN;
    if (isFinite(u)) return u;
    const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ?([+-]\d{2})(\d{2})$/.exec(store.get('td_exp') || '');
    return m ? Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`) : NaN;
  }

  /* ---------- écrans ---------- */
  function rendreAujourdhui() {
    const sv = suivis(), ouv = sv.filter((x) => x.s.statut === 'ouverte'), now = Date.now();
    const latent = ouv.reduce((t, x) => t + (x.s.pnl_latent || 0), 0);
    const engage = ouv.reduce((t, x) => t + (x.s.cout_restant || 0), 0);
    const realise = C.realiseDuJour(journal, auj());
    const al = C.alertes({ suivis: sv, quotes, calendrier: calendrier(), maintenant: now });
    const exp = dateExp();
    if (isFinite(exp) && exp - now < 7 * 86400000) al.push({ niveau: exp < now ? 'rouge' : 'orange', texte: exp < now ? 'Votre clé a expiré : créez-en une autre dans Réglages.' : 'Votre clé expire le ' + jourLong(new Date(exp).toISOString().slice(0, 10)) + '.' });
    const alertesHtml = al.map((a) => `<div class="alerte ${a.niveau}" role="alert">${esc(a.texte)}</div>`).join('');
    const tk = (nom, t, d = 0) => { const q = px(t); return `<div class="tk"><span class="lbl">${nom}</span><b class="num">${q ? nb(q.price, d) : '—'}</b><small class="num ${cls(q && q.change_pct)}">${q ? pct(q.change_pct, true) : ''}</small></div>`; };
    const pea = [['LVMH', 'MC.PA'], ['Stellantis', 'STLAP.PA'], ['TotalEnergies', 'TTE.PA'], ['Air Liquide', 'AI.PA'], ['Schneider', 'SU.PA'], ['LQQ', 'LQQ.PA']]
      .map(([n, t]) => { const q = px(t); return `<div class="list-row"><span class="t">${n}</span><span class="num">${q ? nb(q.price, 2) + ' € <span class="' + cls(q.change_pct) + '">' + pct(q.change_pct, true) + '</span>' : '—'}</span></div>`; }).join('');
    const inst = daily && daily.instruments ? Object.entries(daily.instruments).map(([n, i]) => `<div class="list-row"><span class="l"><span class="t">${esc(n)}</span><span class="s num">Pivot ${nb(i.pivots.P)} · R1 ${nb(i.pivots.R1)} · S1 ${nb(i.pivots.S1)}</span></span><span class="num s">ATR ${nb(i.atr14_pct, 2)} %</span></div>`).join('') : '';
    const prochaines = C.annoncesProches(calendrier(), now, 24 * 14).slice(0, 4);
    const agenda = prochaines.length ? prochaines.map((e) => {
      const jour = C.jourParis(e.ms), quand = jour === auj() ? 'Aujourd\'hui' : jj(jour);
      return `<div class="list-row"><span class="l"><span class="t">${esc(e.nom)}</span><span class="s">${esc(e.regle || '')}</span></span><span class="num ${jour === auj() ? 'warn' : ''}">${quand} ${e.heure_paris}</span></div>`;
    }).join('') : '<p class="muted">Rien dans les 14 prochains jours.</p>';
    const posHtml = ouv.length ? ouv.map(({ p, s }) => cartePosition(p, s, true)).join('') : '<div class="card"><p class="muted">Aucune position ouverte.</p></div>';
    const trou = (journal.trous || [])[0];
    $('tab-today').innerHTML = alertesHtml +
      `<div class="card hero"><div class="span2"><div class="lbl">Valeur totale (caisse + positions)</div><div class="big num">${eur(C.valeurTotale(journal, sv))}</div></div>
        <div><div class="lbl">Caisse</div><div class="num val">${eur(C.cash(journal))}</div></div>
        <div><div class="lbl">Engagé</div><div class="num val">${eur(engage)}</div></div>
        <div><div class="lbl">Réalisé aujourd'hui</div><div class="num val ${cls(realise)}">${eur(realise, { signe: true })}</div></div>
        <div><div class="lbl">Latent (${ouv.length})</div><div class="num val ${cls(latent)}">${eur(latent, { signe: true })}</div></div>
        <div class="span2"><button class="btn ghost small" data-act="caisse">Caisse : dépôt, retrait, comparer</button></div></div>` +
      `<h2 class="sect">Positions ouvertes</h2>${posHtml}` +
      `<div class="card"><h2>Annonces</h2>${agenda}</div>` +
      `<div class="card"><h2>Marchés</h2><div class="ticker">${tk('Nasdaq 100', 'NQ=F')}${tk('CAC 40', '^FCHI')}${tk('S&P 500', '^GSPC')}${tk('VIX', '^VIX', 2)}${tk('EUR/USD', 'EURUSD=X', 4)}</div></div>` +
      (inst ? `<div class="card"><h2>Veille (${jj(daily.date_paris)})</h2>${inst}</div>` : '') +
      `<div class="card"><h2>PEA</h2>${pea}</div>` +
      (trou ? `<p class="trou">Journal incomplet du ${jj(trou.du)} au ${jj(trou.au)} (trades non saisis).</p>` : '');
  }

  // Carte d'une position ouverte. `courte` : version de l'écran Aujourd'hui.
  function cartePosition(p, s, courte) {
    const d = s.distance_barriere_pct;
    const col = d == null ? 'var(--muted)' : d < 1 ? 'var(--red)' : d < 2.5 ? 'var(--amber)' : 'var(--green)';
    const larg = d == null ? 0 : Math.max(0, Math.min(100, d * 10));
    const src = s.source ? `<span class="tag ${s.source === 'BROKER' ? 'broker' : 'theo'}">${s.source === 'BROKER' ? 'Courtier' : 'Estimé'}</span>` : '';
    const entete = `<div class="list-row" style="border:0;padding:0"><button class="lien" data-act="fiche" data-id="${esc(p.id)}"><span class="t">${esc(p.libelle)}</span>${src}</button>
      <b class="num ${cls(s.pnl_latent)}">${eur(s.pnl_latent, { signe: true })}</b></div>`;
    const barre = `<div class="lbl">Marge avant barrière : <span class="num">${pct(d)}</span></div>
      <div class="bar" role="img" aria-label="Marge avant barrière"><i style="width:${larg}%;background:${col}"></i></div>`;
    if (courte) return `<div class="card compact">${entete}<div class="lbl" style="margin-top:6px">Sous-jacent <b class="num">${nb(s.spot, 0)}</b> · Stop <b class="num">${nb(s.niveau_stop, 0)}</b> · KO <b class="num">${nb(s.niveau_ko, 0)}</b> · ×${nb(s.levier, 1)}</div>${barre}</div>`;
    return `<div class="card">${entete}
      <div class="grid4"><div class="lbl">Sous-jacent<b class="num">${nb(s.spot, 0)}</b></div><div class="lbl">KO<b class="num">${nb(s.niveau_ko, 0)}</b></div>
        <div class="lbl">Stop (sous-jacent)<b class="num">${nb(s.niveau_stop, 0)}</b></div><div class="lbl">Levier<b class="num">${s.levier == null ? '—' : '×' + nb(s.levier, 1)}</b></div></div>
      <div class="grid4"><div class="lbl">Prix turbo<b class="num">${nb(s.prix, 3)}</b></div><div class="lbl">Prix moyen<b class="num">${nb(s.pru, 3)}</b></div>
        <div class="lbl">Stop turbo<b class="num">${nb(s.stop_prix, 3)}</b></div><div class="lbl">Quantité<b class="num">${nb(s.quantite_restante)}</b></div></div>
      ${barre}
      <div class="lbl" style="margin-top:6px">Risque au stop <b class="num">${eur(s.risque_stop_eur)}</b> · en position depuis <b class="num">${s.jours_en_position == null ? '?' : s.jours_en_position + ' j'}</b></div>
      <div class="actions"><button class="btn ghost" data-act="prix" data-id="${esc(p.id)}">Prix courtier</button>
        <button class="btn ghost" data-act="strike" data-id="${esc(p.id)}">Vrai strike</button>
        <button class="btn" data-act="vente" data-id="${esc(p.id)}">Vendre</button></div></div>`;
  }

  function rendrePositions() {
    const ouv = ouvertes();
    if (!ouv.length) { $('tab-pos').innerHTML = '<div class="empty">Aucune position ouverte.</div>'; return; }
    const risque = ouv.reduce((t, x) => t + (x.s.risque_stop_eur || 0), 0), R = C.REGLES;
    $('tab-pos').innerHTML = `<div class="card"><div class="lbl">Risque total si tous les stops sont touchés</div>
      <div class="big num down">${eur(-risque)}</div>${R.poche_eur ? `<div class="lbl">${pct((risque / R.poche_eur) * 100)} de la poche</div>` : ''}</div>` +
      ouv.map(({ p, s }) => cartePosition(p, s, false)).join('');
  }

  let jMois = '', jSj = '';
  function rendreJournal() {
    const tous = suivis().filter((x) => x.s.statut === 'fermee');
    const mois = [...new Set(tous.map((x) => (x.s.date_sortie || '').slice(0, 7)).filter(Boolean))].sort().reverse();
    const fermees = tous.filter((x) => (!jMois || (x.s.date_sortie || '').startsWith(jMois)) && (!jSj || C.cleSousJacent(x.p.sous_jacent) === jSj))
      .sort((a, b) => String(b.s.date_sortie || '').localeCompare(String(a.s.date_sortie || '')));
    const total = fermees.reduce((t, x) => t + x.s.pnl_realise, 0);
    const lignes = ((journal.cash && journal.cash.lignes) || []).slice().reverse().slice(0, 8);
    const filtres = `<div class="grid2"><label>Mois<select id="j-mois"><option value="">Tous</option>${mois.map((m) => `<option value="${m}" ${m === jMois ? 'selected' : ''}>${m.slice(5)}/${m.slice(0, 4)}</option>`).join('')}</select></label>
      <label>Sous-jacent<select id="j-sj"><option value="">Tous</option>${Object.entries(SJ_NOM).map(([k, n]) => `<option value="${k}" ${k === jSj ? 'selected' : ''}>${n}</option>`).join('')}</select></label></div>`;
    $('tab-journal').innerHTML = filtres +
      (fermees.length ? `<div class="card"><div class="list-row" style="border:0"><span class="lbl">${fermees.length} trade${fermees.length > 1 ? 's' : ''}</span><b class="num ${cls(total)}">${eur(total, { signe: true })}</b></div>` + fermees.map(({ p, s }) =>
        `<button class="list-row ligne-btn" data-act="fiche" data-id="${esc(p.id)}"><span class="l"><span class="t">${esc(p.libelle)}${s.doublon_probable ? '<span class="tag">doublon ?</span>' : ''}${s.incomplet ? '<span class="tag">incomplet</span>' : ''}</span>
          <span class="s">${jj(s.date_entree)} → ${jj(s.date_sortie)}</span></span>
          <b class="num ${cls(s.pnl_realise)}">${eur(s.pnl_realise, { signe: true })}</b></button>`).join('') + '</div>' : '<div class="empty">Aucun trade pour ce choix.</div>') +
      `<div class="card"><h2>Mouvements de caisse</h2>${lignes.map((l) => `<div class="list-row"><span class="l"><span class="t">${esc({ depot: 'Dépôt', retrait: 'Retrait', ajustement: 'Ajustement' }[l.type] || l.type)}</span><span class="s">${jj(l.date)}${l.note ? ' · ' + esc(l.note) : ''}</span></span><b class="num ${cls(l.montant_eur)}">${eur(l.montant_eur, { signe: true })}</b></div>`).join('') || '<p class="muted">Aucun.</p>'}</div>`;
  }

  function rendreStats() {
    const s = C.stats(journal), h = C.stats(journal, { sansDoublons: true });
    const c = (n, v, k) => `<div class="stat"><span class="lbl">${n}</span><b class="num ${k || ''}">${v}</b></div>`;
    $('tab-stats').innerHTML = `<div class="stats">
      ${c('Résultat réalisé', eur(s.pnl_total, { signe: true }), cls(s.pnl_total))}
      ${c('Sans les doublons', eur(h.pnl_total, { signe: true }), cls(h.pnl_total))}
      ${c('Trades gagnants', s.taux_reussite_pct == null ? '—' : nb(s.taux_reussite_pct, 0) + ' %')}
      ${c('Trades fermés', s.positions_fermees)}
      ${c('Gain moyen', eur(s.gain_moyen, { signe: true }), 'up')}
      ${c('Perte moyenne', eur(s.perte_moyenne), 'down')}
      ${c('Gains ÷ pertes', s.profit_factor == null ? '—' : nb(s.profit_factor, 2))}
      ${c('Pire série', eur(s.creux_max), 'down')}</div>` +
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
    token = ''; store.del('td_token'); store.del('td_exp'); store.del('td_exp_user'); journal = quotes = daily = null;
    $('login').hidden = false; $('tabs').hidden = true; $('fab').hidden = true; $('settings').hidden = true;
    document.querySelectorAll('.tab').forEach((s) => { s.hidden = true; });
    $('login-err').textContent = msg || '';
  }
  function connecte() {
    $('login').hidden = true; $('tabs').hidden = false; $('fab').hidden = false; $('settings').hidden = false;
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
  document.addEventListener('change', (e) => { if (e.target.id === 'j-mois') { jMois = e.target.value; rendreJournal(); } if (e.target.id === 'j-sj') { jSj = e.target.value; rendreJournal(); } });

  /* ---------- feuilles : saisie → confirmation (totaux) → écriture ---------- */
  const champ = (id, lib, val, mode) => `<label>${lib}<input id="${id}" ${mode === 'date' ? 'type="date"' : mode === 'time' ? 'type="time"' : 'inputmode="' + (mode || 'decimal') + '"'} value="${esc(val == null ? '' : val)}"></label>`;
  const choix = (id, lib, options, sel) => `<label>${lib}<select id="${id}">${options.map((o) => { const [v, t] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(t)}</option>`; }).join('')}</select></label>`;
  const ligne = (k, v, c) => `<dt>${k}</dt><dd class="num ${c || ''}">${v}</dd>`;
  const val = (id) => { const e = $(id); return e ? e.value.trim() : ''; };
  const dateOk = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d);
  function toast(msg, kind) { const t = $('toast'); t.textContent = msg; t.className = 'toast show ' + (kind || ''); clearTimeout(t._h); t._h = setTimeout(() => { t.className = 'toast'; }, 3500); }

  let focusAvant = null;
  function ouvrir(html) {
    const ancien = $('sheet-body'), neuf = ancien.cloneNode(false);
    if ($('sheet').hidden) focusAvant = document.activeElement;
    ancien.replaceWith(neuf); neuf.innerHTML = html; $('sheet').hidden = false;
    neuf.scrollTop = 0;
    const premier = neuf.querySelector('input:not([type=checkbox]),select,button'); if (premier) premier.focus({ preventScroll: true });
  }
  function fermer() { $('sheet').hidden = true; $('sheet-body').innerHTML = ''; if (focusAvant && focusAvant.focus) focusAvant.focus({ preventScroll: true }); }
  $('sheet').addEventListener('click', (e) => { if (e.target === $('sheet') || e.target.closest('[data-fermer]')) fermer(); });
  document.addEventListener('keydown', (e) => {
    if ($('sheet').hidden) return;
    if (e.key === 'Escape') { fermer(); return; }
    if (e.key === 'Tab') {   // le focus reste dans la feuille
      const f = [...$('sheet-body').querySelectorAll('input,select,button,summary,a[href]')].filter((x) => !x.disabled && x.offsetParent);
      if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    }
  });

  // Étape 2 commune : récapitulatif chiffré, puis écriture seulement après « Valider ».
  // `avertissements` : liste de règles non respectées ; il faut cocher « je confirme » pour valider.
  function confirmer(titre, recap, appliquer, message, avertissements) {
    const av = avertissements && avertissements.length ? `<div class="alerte orange">${avertissements.map((w) => '<div>' + esc(w) + '</div>').join('')}</div>
      <label class="check"><input type="checkbox" id="w-conf"> Je confirme malgré ces avertissements</label>` : '';
    ouvrir(`<h2 id="sheet-t">${titre}</h2><p>Vérifiez avant d'écrire dans le journal.</p>
      <div class="recap"><dl class="calc">${recap}</dl></div>${av}<p class="err" id="w-err" role="alert"></p>
      <div class="row"><button class="btn ghost" data-fermer>Annuler</button><button class="btn" id="w-ok" ${av ? 'disabled' : ''}>Valider</button></div>`);
    if (av) $('w-conf').onchange = () => { $('w-ok').disabled = !$('w-conf').checked; };
    $('w-ok').onclick = async () => {
      $('w-ok').disabled = true; $('w-ok').textContent = 'Écriture…';
      const copie = JSON.parse(JSON.stringify(journal));
      try {
        appliquer(copie);
        await ecrireJournal(copie, message);
        C.configurer(journal.regles || {});
        fermer(); rendre(); toast('Enregistré dans le journal.', 'ok');
      } catch (e) {
        if (e.conflit) { fermer(); await charger(); toast('Le journal a changé ailleurs. Rien n\'est écrit. Recommencez.', 'ko'); return; }
        $('w-err').textContent = e.status === 403 || e.status === 404 ? 'Écriture refusée : la clé doit avoir Contenu en écriture sur turbo-brief.' : 'Écriture impossible (' + e.message + '). Rien n\'est écrit.';
        $('w-ok').disabled = false; $('w-ok').textContent = 'Valider';
      }
    };
  }
  function nouvelId(j) {
    const n = Math.max(0, ...j.positions.map((p) => parseInt(String(p.id).replace(/\D/g, ''), 10) || 0)) + 1;
    return 'p' + String(n).padStart(2, '0');
  }
  const fraisDefaut = () => (isFinite(C.REGLES.frais_eur) ? C.REGLES.frais_eur : 0);

  /* 1) + Trade : achat d'une nouvelle position (5 champs, le reste sous « Plus ») */
  function feuilleTrade() {
    const R = C.REGLES;
    ouvrir(`<h2 id="sheet-t">Nouveau trade</h2>
      <div class="grid2">${choix('t-sj', 'Sous-jacent', Object.entries(SJ_NOM))}${choix('t-sens', 'Sens', ['CALL', 'PUT'])}</div>
      <div class="grid2">${champ('t-strike', 'Strike', '')}${champ('t-prix', 'Prix du turbo (€)', '')}</div>
      <div class="grid2">${choix('t-mode', 'Taille selon', [['mise', 'La mise'], ['risque', 'La perte maximale']], 'mise')}${champ('t-mise', 'Mise (€)', R.mise_defaut_eur)}</div>
      <details><summary>Plus de réglages</summary>
        <div class="grid2">${champ('t-barr', 'Barrière (vide = strike)', '')}${champ('t-parite', 'Parité', 100)}</div>
        <div class="grid2">${champ('t-em', 'Émetteur', 'SG', 'text')}${champ('t-isin', 'ISIN', '', 'text')}</div>
        <div class="grid2">${champ('t-q', 'Quantité (auto)', '', 'numeric')}${champ('t-frais', 'Frais (€)', fraisDefaut())}</div>
        <div class="grid2">${champ('t-date', 'Date', auj(), 'date')}${champ('t-heure', 'Heure', maintenantHM(), 'time')}</div>
        <div class="grid2">${champ('t-stop', 'Stop (% du turbo)', R.stop_pct)}${champ('t-conv', 'Conviction /10', '', 'numeric')}</div>
        <div class="grid2">${champ('t-ssl', 'Stop sous-jacent', '')}${champ('t-cible', 'Cible sous-jacent', '')}</div>
        ${champ('t-note', 'Note', '', 'text')}
      </details>
      <div id="t-av"></div><p class="err" id="t-err" role="alert"></p>
      <div class="stickybar"><dl class="calc" id="t-out"></dl>
        <div class="row"><button class="btn ghost" data-fermer>Fermer</button><button class="btn" id="t-go">Vérifier</button></div></div>`);
    let qAuto = true;
    $('t-q').addEventListener('input', () => { qAuto = $('t-q').value === ''; });
    const lire = () => {
      const sj = val('t-sj'), sens = val('t-sens'), strike = num(val('t-strike')), prix = num(val('t-prix')), stop = num(val('t-stop')), parite = num(val('t-parite'));
      const sp = px(C.SOUS_JACENTS[sj].quote), spotNow = sp && sp.price, devise = C.SOUS_JACENTS[sj].devise, stopPct = stop == null ? R.stop_pct : stop;
      let mise = num(val('t-mise'));
      if (val('t-mode') === 'risque' && mise != null && stopPct < 0) mise = mise / (-stopPct / 100);   // « mise » = perte maximale voulue
      const d = C.dimensionner({ prixTurbo: prix, mise: mise == null ? NaN : mise, stopPct });
      const q = qAuto ? (d ? d.quantite : null) : num(val('t-q'));
      return { sj, sens, strike, prix, stopPct, parite, spotNow, devise, mise, q, d, barr: num(val('t-barr')) };
    };
    const maj = () => {
      const x = lire(); if (qAuto && x.q) $('t-q').value = ''; $('t-q').placeholder = x.q ? String(x.q) : '';
      let h = '';
      const frais = num(val('t-frais')) || 0;
      if (x.prix != null && x.q) {
        const eng = x.q * x.prix + frais, perte = x.q * x.prix * (-x.stopPct / 100);
        h += ligne('Quantité', nb(x.q)) + ligne('Engagé', eur(eng)) + ligne('Perte au stop', eur(-perte), 'down') + (R.poche_eur ? ligne('Part de la poche', pct((perte / R.poche_eur) * 100)) : '');
      }
      const lev = x.spotNow && x.strike ? C.levier(x.spotNow, x.strike, x.sens) : null;
      if (x.strike != null && x.prix != null && x.parite > 0 && x.stopPct < 0) {
        const conv = x.devise === 'USD' && eurusd() ? eurusd() : 1, sgn = x.sens === 'PUT' ? -1 : 1;
        if (x.devise !== 'USD' || eurusd()) h += ligne('Stop (sous-jacent)', nb(x.strike + sgn * x.prix * (1 + x.stopPct / 100) * x.parite * conv, 0)) + ligne('Barrière (sous-jacent)', nb(x.barr ?? x.strike, 0));
      }
      if (lev) h += ligne('Levier', '×' + nb(lev, 1)) + ligne('Marge avant barrière', pct(C.distanceBarriere(x.spotNow, x.barr ?? x.strike, x.sens)));
      const rr = C.ratioGainRisque(x.spotNow, num(val('t-ssl')), num(val('t-cible'))); if (rr != null) h += ligne('Gain / risque', nb(rr, 2));
      $('t-out').innerHTML = h;
      const w = C.verifierRegles({ journal, sens: x.sens, sousJacent: x.sj, prix: x.prix, levierTurbo: lev, stopPct: x.stopPct, mise: x.q && x.prix ? x.q * x.prix : null, calendrier: calendrier(), maintenant: Date.now() });
      $('t-av').innerHTML = w.length ? `<div class="alerte orange">${w.map((t) => '<div>' + esc(t) + '</div>').join('')}</div>` : '';
    };
    $('sheet-body').addEventListener('input', maj); $('sheet-body').addEventListener('change', maj); maj();
    $('t-go').onclick = () => {
      const x = lire(), frais = num(val('t-frais')) ?? 0, conv = num(val('t-conv'));
      const err = !(x.strike > 0) ? 'Entrez le strike.' : !(x.parite > 0) ? 'Entrez la parité (Plus de réglages).' : !(x.prix > 0) ? 'Entrez le prix du turbo.'
        : !(x.q > 0 && Number.isInteger(x.q)) ? 'Entrez la mise ou une quantité entière.' : frais < 0 ? 'Frais négatifs ?' : !(x.stopPct < 0 && x.stopPct > -100) ? 'Stop entre −1 et −99 %.'
        : !dateOk(val('t-date')) ? 'Entrez la date.' : '';
      if (err) { $('t-err').textContent = err; return; }
      const barriere = x.barr ?? x.strike, em = val('t-em') || null, sjNom = x.sj;
      const lev = x.spotNow ? C.levier(x.spotNow, x.strike, x.sens) : null;
      const w = C.verifierRegles({ journal, sens: x.sens, sousJacent: x.sj, prix: x.prix, levierTurbo: lev, stopPct: x.stopPct, mise: x.q * x.prix, calendrier: calendrier(), maintenant: Date.now() });
      const pos = {
        id: nouvelId(journal), libelle: `${x.sens} ${sjNom} ${x.strike} Turbo${barriere === x.strike ? ' BEST' : ''}${em ? ' (' + em + ')' : ''}`,
        sous_jacent: sjNom, sens: x.sens, emetteur: em, isin: val('t-isin') || null, reference_courtier: null,
        strike: x.strike, barriere, parite: x.parite, devise: x.devise,
        executions: [{ date: val('t-date'), heure: val('t-heure') || null, type: 'achat', quantite: x.q, prix: x.prix, frais }],
        plan: { stop_pct: x.stopPct, stop_prix: null, cibles: num(val('t-cible')) != null ? [num(val('t-cible'))] : [], invalidation: num(val('t-ssl')) },
        conviction: conv, setup: null, reco_liee: null, regle_respectee: w.length === 0, note: val('t-note') || null,
      };
      if (w.length) pos.avertissements = w;
      const montant = C.montantExecution(pos.executions[0]), avant = C.cash(journal);
      confirmer('Confirmer l\'achat',
        ligne('Position', esc(pos.libelle)) + ligne('Achat', `${nb(x.q)} × ${nb(x.prix, 3)} €`) + ligne('Frais', eur(frais))
        + ligne('Engagé', eur(montant)) + ligne('Caisse', `${eur(avant)} → ${eur(avant - montant)}`, avant - montant < 0 ? 'down' : '')
        + ligne('Stop turbo', nb(x.prix * (1 + x.stopPct / 100), 3) + ' €') + ligne('Perte au stop', eur(-(x.q * x.prix * -x.stopPct / 100)), 'down'),
        (j) => { pos.id = nouvelId(j); j.positions.push(pos); },
        `journal: achat ${pos.libelle} (${x.q} × ${x.prix})`, w);
    };
  }

  /* 2) Vendre tout ou partie : prix prérempli, motif, règle respectée */
  const MOTIFS = [['cible', 'Cible atteinte'], ['stop', 'Stop touché'], ['time-stop', 'Fin de séance (time-stop)'], ['annonce', 'Avant une annonce'], ['manuel', 'Décision à la main'], ['autre', 'Autre']];
  function feuilleVente(id) {
    const p = trouver(journal, id), b = C.bilanPosition(p), s = C.suiviPosition(p, marche(p));
    ouvrir(`<h2 id="sheet-t">Vendre</h2><p>${esc(p.libelle)} · reste ${nb(b.quantite_restante)} · prix moyen ${nb(b.pru, 3)} €</p>
      <div class="grid2">${champ('v-q', 'Quantité', b.quantite_restante, 'numeric')}${champ('v-prix', 'Prix de vente (€)', s.prix != null ? Math.round(s.prix * 1000) / 1000 : '')}</div>
      <p class="muted" style="margin:-6px 0 10px">Prix proposé : ${s.source === 'BROKER' ? 'courtier' : 'estimé'}. Remplacez-le par le prix réel de l'exécution.</p>
      <div class="grid2">${champ('v-frais', 'Frais (€)', fraisDefaut())}${champ('v-date', 'Date', auj(), 'date')}</div>
      <div class="grid2">${champ('v-heure', 'Heure', maintenantHM(), 'time')}${choix('v-motif', 'Motif', MOTIFS, s.stop_touche ? 'stop' : 'cible')}</div>
      ${choix('v-regle', 'Règles respectées ?', [['oui', 'Oui'], ['non', 'Non'], ['', 'Je ne sais pas']], 'oui')}
      ${champ('v-note', 'Note (facultatif)', '', 'text')}
      <p class="err" id="v-err" role="alert"></p>
      <div class="row"><button class="btn ghost" data-fermer>Fermer</button><button class="btn" id="v-go">Vérifier</button></div>`);
    $('v-go').onclick = () => {
      const q = num(val('v-q')), prix = num(val('v-prix')), frais = num(val('v-frais')) ?? 0;
      const err = !(q > 0 && Number.isInteger(q) && q <= b.quantite_restante) ? `Quantité entière entre 1 et ${b.quantite_restante}.` : !(prix >= 0) ? 'Entrez le prix de vente.'
        : frais < 0 ? 'Frais négatifs ?' : !dateOk(val('v-date')) ? 'Entrez la date.' : '';
      if (err) { $('v-err').textContent = err; return; }
      const ex = { date: val('v-date'), heure: val('v-heure') || null, type: 'vente', quantite: q, prix, frais, motif: val('v-motif') };
      if (val('v-regle')) ex.regle_respectee = val('v-regle') === 'oui';
      if (val('v-note')) ex.note = val('v-note');
      const apres = C.bilanPosition({ ...p, executions: [...p.executions, ex] });
      const m = C.montantExecution(ex), pnl = m - b.pru * q, avant = C.cash(journal);
      confirmer('Confirmer la vente',
        ligne('Vente', `${nb(q)} × ${nb(prix, 3)} €`) + ligne('Frais', eur(frais)) + ligne('Reçu', eur(m))
        + ligne('Gain / perte de cette vente', eur(pnl, { signe: true }), cls(pnl))
        + ligne('Caisse', `${eur(avant)} → ${eur(avant + m)}`) + ligne('Motif', esc((MOTIFS.find((x) => x[0] === ex.motif) || [0, ''])[1]))
        + ligne('Position après', apres.statut === 'fermee' ? 'fermée, ' + eur(apres.pnl_realise, { signe: true }) : 'ouverte, reste ' + nb(apres.quantite_restante)),
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
      let ms = C.parisVersMs(auj(), hm);
      if (ms > Date.now() + 5 * 60000) ms -= 86400000;   // heure de la veille si elle est dans le futur
      const heure = new Date(Math.round(ms / 60000) * 60000).toISOString();
      const latent = (prix - b.pru) * b.quantite_restante;
      const stopPrix = b.pru * (1 + ((p.plan && p.plan.stop_pct) ?? C.REGLES.stop_pct) / 100);
      confirmer('Confirmer le prix',
        ligne('Prix', nb(prix, 3) + ' € à ' + esc(hm)) + ligne('Prix moyen', nb(b.pru, 3) + ' €') + ligne('Latent avec ce prix', eur(latent, { signe: true }), cls(latent))
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
      if (!(k > 0) || !dateOk(d)) { $('k-err').textContent = 'Entrez le strike et la date.'; return; }
      const sp = spot(p), theo = C.valeurTheorique({ spot: sp, strike: k, sens: p.sens, parite: p.parite, devise: C.devisePosition(p), eurusd: eurusd() });
      const ecart = estime ? ((k - estime) / estime) * 100 : null;
      confirmer('Confirmer le strike',
        ligne('Strike estimé → saisi', `${nb(estime, 2)} → ${nb(k, 2)}`) + (ecart != null ? ligne('Écart', pct(ecart, true), Math.abs(ecart) > 1 ? 'warn' : '') : '')
        + ligne('Prix théorique', theo == null ? '—' : nb(theo, 3) + ' €') + ligne('Marge avant barrière', pct(C.distanceBarriere(sp, k, p.sens))),
        (j) => { const x = trouver(j, id); x.strike_ref = k; x.date_ref = d; },
        `journal: strike ${p.libelle} ${k} au ${d}`);
    };
  }

  /* 5) Fiche d'un trade : détail, exécutions, corrections */
  function feuilleFiche(id) {
    const p = trouver(journal, id), b = C.bilanPosition(p), s = C.suiviPosition(p, marche(p));
    const exs = (p.executions || []).map((e, i) => {
      const m = C.montantExecution(e);
      const detail = isFinite(e.quantite) && isFinite(e.prix) ? `${nb(e.quantite)} × ${nb(e.prix, 3)} €` : eur(m);
      const motif = e.motif ? ' · ' + esc((MOTIFS.find((x) => x[0] === e.motif) || [0, e.motif])[1]) : '';
      return `<div class="list-row ${e.annulee ? 'annulee' : ''}"><span class="l"><span class="t">${e.type === 'achat' ? 'Achat' : 'Vente'} ${detail}${e.annulee ? '<span class="tag">annulée</span>' : ''}</span>
        <span class="s">${jj(e.date)}${e.heure ? ' ' + esc(e.heure) : ''}${e.frais ? ' · frais ' + eur(e.frais) : ''}${motif}${e.note ? ' · ' + esc(e.note) : ''}</span></span>
        ${e.annulee ? '' : `<button class="btn ghost small" data-act="corriger" data-id="${esc(p.id)}" data-i="${i}">Corriger</button>`}</div>`;
    }).join('');
    const infos = [['Strike', nb(p.strike, 0)], ['Barrière', nb(p.barriere, 0)], ['Parité', nb(p.parite)], ['Stop', (p.plan && p.plan.stop_pct != null ? p.plan.stop_pct : C.REGLES.stop_pct) + ' %'], ['Conviction', p.conviction != null ? p.conviction + '/10' : '—'], ['Règles respectées', p.regle_respectee == null ? '—' : p.regle_respectee ? 'oui' : 'non']];
    ouvrir(`<h2 id="sheet-t">${esc(p.libelle)}</h2>
      <div class="recap"><dl class="calc">
        ${ligne('État', b.statut === 'ouverte' ? 'ouverte' : 'fermée')}${ligne('Investi', eur(b.investi))}${ligne('Récupéré', eur(b.recupere))}
        ${ligne(b.statut === 'ouverte' ? 'Réalisé' : 'Résultat', eur(b.pnl_realise, { signe: true }), cls(b.pnl_realise))}
        ${b.statut === 'ouverte' ? ligne('Latent', eur(s.pnl_latent, { signe: true }), cls(s.pnl_latent)) : ''}
        ${b.pnl_realise_pct != null ? ligne('En %', pct(b.pnl_realise_pct, true), cls(b.pnl_realise)) : ''}</dl></div>
      <div class="grid3">${infos.map(([k, v]) => `<div class="lbl">${k}<b class="num">${v}</b></div>`).join('')}</div>
      ${p.avertissements ? `<div class="alerte orange">${p.avertissements.map((w) => '<div>' + esc(w) + '</div>').join('')}</div>` : ''}
      ${p.note ? `<p class="muted">${esc(p.note)}</p>` : ''}
      <h2 class="sect">Exécutions</h2>${exs}
      <div class="row" style="margin-top:12px"><button class="btn ghost" data-fermer>Fermer</button>${b.statut === 'ouverte' ? `<button class="btn" data-act="vente" data-id="${esc(p.id)}">Vendre</button>` : ''}</div>`);
  }

  /* 6) Corriger une exécution : l'ancienne est marquée annulée (jamais effacée), la nouvelle la remplace */
  function feuilleCorrection(id, i) {
    const p = trouver(journal, id), e = p.executions[i], avecQte = isFinite(e.quantite) && isFinite(e.prix);
    ouvrir(`<h2 id="sheet-t">Corriger ${e.type === 'achat' ? 'l\'achat' : 'la vente'}</h2><p>${esc(p.libelle)}</p>
      <p class="muted">L'ancienne ligne reste visible, marquée « annulée ». Elle ne compte plus dans les calculs.</p>
      ${avecQte ? `<div class="grid2">${champ('c-q', 'Quantité', e.quantite, 'numeric')}${champ('c-prix', 'Prix (€)', e.prix)}</div>${champ('c-frais', 'Frais (€)', e.frais || 0)}`
      : `${champ('c-montant', 'Montant (€)', C.montantExecution(e))}`}
      <div class="grid2">${champ('c-date', 'Date', e.date || auj(), 'date')}${champ('c-heure', 'Heure', e.heure || '', 'time')}</div>
      <p class="err" id="c-err" role="alert"></p>
      <div class="row"><button class="btn ghost" data-fermer>Fermer</button><button class="btn" id="c-go">Vérifier</button></div>
      <div class="row" style="margin-top:8px"><button class="btn ghost" id="c-sans">Annuler cette ligne sans la remplacer</button></div>`);
    const verifier = (nouvelle) => {
      const cp = JSON.parse(JSON.stringify(p)); cp.executions[i].annulee = true; if (nouvelle) cp.executions.push(nouvelle);
      const avant = C.bilanPosition(p), apres = C.bilanPosition(cp);
      if (apres.quantite_restante != null && apres.quantite_restante < 0) return { err: 'Les ventes dépasseraient les achats.' };
      const jc = JSON.parse(JSON.stringify(journal)); jc.positions[jc.positions.findIndex((x) => x.id === id)] = cp;
      const cAvant = C.cash(journal), cApres = C.cash(jc);
      const lib = (x) => (isFinite(x.quantite) && isFinite(x.prix) ? `${nb(x.quantite)} × ${nb(x.prix, 3)} €` : eur(C.montantExecution(x)));
      confirmer('Confirmer la correction',
        ligne('Ligne annulée', `${lib(e)} · ${jj(e.date)}`) + (nouvelle ? ligne('Nouvelle ligne', `${lib(nouvelle)} · ${jj(nouvelle.date)}`) : ligne('Remplacée par', 'rien'))
        + ligne('Résultat de la position', `${eur(avant.pnl_realise, { signe: true })} → ${eur(apres.pnl_realise, { signe: true })}`)
        + ligne('Caisse', `${eur(cAvant)} → ${eur(cApres)}`, cApres < 0 ? 'down' : ''),
        (j) => { const x = trouver(j, id); x.executions[i].annulee = true; x.executions[i].annulee_le = auj(); if (nouvelle) x.executions.push(nouvelle); },
        `journal: correction ${p.libelle} (ligne ${i + 1})`);
      return {};
    };
    $('c-go').onclick = () => {
      const date = val('c-date'), frais = num(val('c-frais')) ?? 0;
      const base = { date, heure: val('c-heure') || null, type: e.type, corrige_de: i, corrige_le: auj() };
      if (e.note) base.note = e.note; if (e.motif) base.motif = e.motif;
      let nouvelle;
      if (avecQte) {
        const q = num(val('c-q')), prix = num(val('c-prix'));
        const err = !(q > 0 && Number.isInteger(q)) ? 'Quantité entière.' : !(prix >= 0) ? 'Entrez le prix.' : frais < 0 ? 'Frais négatifs ?' : !dateOk(date) ? 'Entrez la date.' : '';
        if (err) { $('c-err').textContent = err; return; }
        nouvelle = { ...base, quantite: q, prix, frais };
      } else {
        const m = num(val('c-montant')); if (!(m >= 0) || !dateOk(date)) { $('c-err').textContent = 'Entrez le montant et la date.'; return; }
        nouvelle = { ...base, montant_eur: m, frais: 0 };
      }
      const r = verifier(nouvelle); if (r.err) $('c-err').textContent = r.err;
    };
    $('c-sans').onclick = () => { const r = verifier(null); if (r.err) $('c-err').textContent = r.err; };
  }

  /* 7) Caisse : dépôt, retrait, comparaison avec le courtier */
  function feuilleCaisse() {
    ouvrir(`<h2 id="sheet-t">Caisse</h2><p>Caisse calculée par l'app : <b class="num">${eur(C.cash(journal))}</b></p>
      <div class="actions"><button class="btn ghost" data-act="depot">Dépôt</button><button class="btn ghost" data-act="retrait">Retrait</button>
        <button class="btn" data-act="comparer">Comparer avec mon courtier</button></div>
      <div class="row" style="margin-top:12px"><button class="btn ghost" data-fermer>Fermer</button></div>`);
  }
  function feuilleMouvement(type) {
    const nom = type === 'depot' ? 'Dépôt' : 'Retrait';
    ouvrir(`<h2 id="sheet-t">${nom}</h2>
      <div class="grid2">${champ('m-montant', 'Montant (€)', '')}${champ('m-date', 'Date', auj(), 'date')}</div>${champ('m-note', 'Note (facultatif)', '', 'text')}
      <p class="err" id="m-err" role="alert"></p>
      <div class="row"><button class="btn ghost" data-fermer>Fermer</button><button class="btn" id="m-go">Vérifier</button></div>`);
    $('m-go').onclick = () => {
      const m = num(val('m-montant')), d = val('m-date');
      if (!(m > 0) || !dateOk(d)) { $('m-err').textContent = 'Entrez un montant positif et la date.'; return; }
      const montant = Math.round((type === 'depot' ? m : -m) * 100) / 100, avant = C.cash(journal);
      const l = { date: d, type, montant_eur: montant }; if (val('m-note')) l.note = val('m-note');
      confirmer('Confirmer le ' + nom.toLowerCase(), ligne(nom, eur(montant, { signe: true })) + ligne('Date', jourLong(d)) + ligne('Caisse', `${eur(avant)} → ${eur(avant + montant)}`, avant + montant < 0 ? 'down' : ''),
        (j) => { j.cash.lignes.push(l); }, `journal: ${type} ${montant} €`, avant + montant < 0 ? ['La caisse deviendrait négative.'] : null);
    };
  }
  function feuilleComparer() {
    ouvrir(`<h2 id="sheet-t">Comparer avec mon courtier</h2><p>Caisse de l'app : <b class="num">${eur(C.cash(journal))}</b></p>
      ${champ('k-cash', 'Espèces affichées chez le courtier (€)', '')}
      <p class="err" id="k-err" role="alert"></p>
      <div class="row"><button class="btn ghost" data-fermer>Fermer</button><button class="btn" id="k-go">Comparer</button></div>`);
    $('k-go').onclick = () => {
      const cible = num(val('k-cash')); if (cible == null) { $('k-err').textContent = 'Entrez le montant du courtier.'; return; }
      const avant = C.cash(journal), ecart = Math.round((cible - avant) * 100) / 100;
      if (Math.abs(ecart) < 0.005) { ouvrir(`<h2 id="sheet-t">Identique</h2><p>La caisse de l'app et celle du courtier sont les mêmes : ${eur(avant)}.</p><div class="row"><button class="btn" data-fermer>Fermer</button></div>`); return; }
      confirmer('Caler la caisse sur le courtier',
        ligne('Caisse de l\'app', eur(avant)) + ligne('Courtier', eur(cible)) + ligne('Écart', eur(ecart, { signe: true }), cls(ecart)) + ligne('Nouvelle caisse', eur(cible)),
        (j) => { j.cash.lignes.push({ date: auj(), type: 'ajustement', montant_eur: ecart, cible_cash_eur: cible, note: 'Calage sur la caisse du courtier' }); },
        `journal: ajustement de caisse ${ecart} €`, Math.abs(ecart) > 50 ? ['Écart important : cherchez d\'abord un trade ou des frais non saisis.'] : null);
    };
  }

  /* 8) Réglages : clé, règles, frais, taux de financement */
  function feuilleReglages() {
    const R = C.REGLES, F = C.FINANCEMENT, exp = dateExp();
    const pc = (x) => nb(x * 100, 2);
    ouvrir(`<h2 id="sheet-t">Réglages</h2>
      <div class="recap"><dl class="calc">${ligne('Clé GitHub', token ? 'enregistrée sur ce téléphone' : 'absente')}${ligne('Expire le', isFinite(exp) ? jourLong(new Date(exp).toISOString().slice(0, 10)) : 'inconnu')}</dl></div>
      ${champ('r-exp', 'Date d\'expiration de ma clé', store.get('td_exp_user') || (isFinite(exp) ? new Date(exp).toISOString().slice(0, 10) : ''), 'date')}
      <div class="actions"><button class="btn ghost" data-act="cle">Changer la clé</button><button class="btn ghost" data-act="effacer">Effacer la clé</button></div>
      <h2 class="sect">Mes règles</h2>
      <div class="grid2">${champ('r-poche', 'Poche (€)', R.poche_eur)}${champ('r-mise', 'Mise par défaut (€)', R.mise_defaut_eur)}</div>
      <div class="grid2">${champ('r-stop', 'Stop (%)', R.stop_pct)}${champ('r-frais', 'Frais par ordre (€)', fraisDefaut())}</div>
      <details><summary>Taux de financement des BEST (% par an)</summary>
        <p class="muted">Servent à estimer le strike du jour. Corrigez-les si le « vrai strike » s'écarte souvent.</p>
        <div class="grid2">${champ('r-usd-c', 'USD, CALL', pc(F.USD.CALL))}${champ('r-usd-p', 'USD, PUT', pc(F.USD.PUT))}</div>
        <div class="grid2">${champ('r-eur-c', 'EUR, CALL', pc(F.EUR.CALL))}${champ('r-eur-p', 'EUR, PUT', pc(F.EUR.PUT))}</div></details>
      <p class="err" id="r-err" role="alert"></p>
      <div class="row"><button class="btn ghost" data-fermer>Fermer</button><button class="btn" id="r-go">Vérifier</button></div>
      <p class="muted" style="margin-top:12px">Turbo Desk v3 · données privées dans turbo-brief</p>`);
    $('r-go').onclick = () => {
      if (dateOk(val('r-exp'))) { store.set('td_exp_user', val('r-exp')); rendre(); }
      const poche = num(val('r-poche')), mise = num(val('r-mise')), stop = num(val('r-stop')), frais = num(val('r-frais'));
      const f = ['r-usd-c', 'r-usd-p', 'r-eur-c', 'r-eur-p'].map((k) => num(val(k)));
      const err = !(poche > 0) ? 'Poche : un montant positif.' : !(mise > 0 && mise <= poche) ? 'Mise : positive et sous la poche.' : !(stop < 0 && stop > -100) ? 'Stop entre −1 et −99 %.'
        : !(frais >= 0) ? 'Frais : zéro ou plus.' : f.some((x) => x == null || Math.abs(x) > 30) ? 'Taux : entre −30 et 30 %.' : '';
      if (err) { $('r-err').textContent = err; return; }
      const reg = { ...(journal.regles || {}), poche_eur: poche, mise_defaut_eur: mise, stop_pct: stop, frais_eur: frais,
        financement: { USD: { CALL: f[0] / 100, PUT: f[1] / 100 }, EUR: { CALL: f[2] / 100, PUT: f[3] / 100 } } };
      confirmer('Confirmer les règles',
        ligne('Poche', `${eur(R.poche_eur)} → ${eur(poche)}`) + ligne('Mise par défaut', `${eur(R.mise_defaut_eur)} → ${eur(mise)}`) + ligne('Stop', `${nb(R.stop_pct)} % → ${nb(stop)} %`)
        + ligne('Frais par ordre', `${eur(fraisDefaut())} → ${eur(frais)}`) + ligne('Financement USD CALL / PUT', `${nb(f[0], 2)} % / ${nb(f[1], 2)} %`) + ligne('Financement EUR CALL / PUT', `${nb(f[2], 2)} % / ${nb(f[3], 2)} %`),
        (j) => { j.regles = reg; }, 'journal: règles et réglages');
    };
  }

  /* ---------- actions des boutons (écrans et feuilles) ---------- */
  const ACTIONS = { vente: feuilleVente, prix: feuillePrix, strike: feuilleStrike, fiche: feuilleFiche, corriger: (id, i) => feuilleCorrection(id, Number(i)),
    caisse: feuilleCaisse, depot: () => feuilleMouvement('depot'), retrait: () => feuilleMouvement('retrait'), comparer: feuilleComparer,
    cle: () => { fermer(); deconnecter(''); }, effacer: () => { fermer(); deconnecter('Clé effacée de ce téléphone.'); } };
  document.addEventListener('click', (e) => {
    const bt = e.target.closest('button[data-act]'); if (!bt || !journal && !['cle', 'effacer'].includes(bt.dataset.act)) return;
    const f = ACTIONS[bt.dataset.act]; if (f) f(bt.dataset.id, bt.dataset.i);
  });
  $('fab').onclick = () => { if (journal) feuilleTrade(); };
  $('settings').onclick = () => { if (journal) feuilleReglages(); };

  /* ---------- démarrage ---------- */
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (token) connecte(); else deconnecter('');
})();
