/* Turbo Desk — calculs (tâche 3.1).
 * Fonctions pures : aucune donnée de trade ici, tout vient du journal privé (turbo-brief, branche data).
 * Navigateur : window.Calc ; Node : require('./calc.js').
 * Règles : statut et P&L toujours calculés, jamais saisis ; aucun montant saisi n'est modifié.
 */
(function (root) {
  'use strict';

  const REGLES = {
    poche_eur: null,        // montants privés : fournis par configurer() depuis turbo-brief
    mise_defaut_eur: null,
    stop_pct: -40,          // stop par défaut, en % du prix d'achat du turbo
    broker_max_min: 30,     // un prix courtier de moins de 30 min fait foi (badge BROKER)
  };

  // Financement des BEST : estimation annuelle (base 360 j) du glissement du strike.
  // Ce ne sont pas les taux de l'émetteur : la saisie du vrai strike (strike_ref + date_ref) corrige.
  const FINANCEMENT = {
    USD: { CALL: 0.065, PUT: 0.015 },
    EUR: { CALL: 0.045, PUT: -0.005 },
  };

  const SOUS_JACENTS = {
    NQ:     { devise: 'USD', quote: 'NQ=F' },
    SP500:  { devise: 'USD', quote: '^GSPC' },
    CAC40:  { devise: 'EUR', quote: '^FCHI' },
  };

  // Règles privées (poche, mise) lues dans turbo-brief au démarrage de l'app.
  function configurer(regles) {
    Object.assign(REGLES, regles || {});
    const f = regles && regles.financement;
    if (f) for (const d of ['USD', 'EUR']) if (f[d]) Object.assign(FINANCEMENT[d], f[d]);
    return REGLES;
  }

  const sgn = (sens) => (String(sens).toUpperCase() === 'PUT' ? -1 : 1);
  const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
  const isNum = (x) => typeof x === 'number' && isFinite(x);

  function cleSousJacent(s) {
    const k = String(s || '').toUpperCase().replace(/[\s&-]/g, '');
    if (k.includes('NQ') || k.includes('NASDAQ')) return 'NQ';
    if (k.includes('SP500') || k.includes('S&P') || k === 'SPX') return 'SP500';
    if (k.includes('CAC')) return 'CAC40';
    return null;
  }

  function devisePosition(p) {
    if (p.devise) return p.devise;
    const k = cleSousJacent(p.sous_jacent);
    return k ? SOUS_JACENTS[k].devise : 'EUR';
  }

  /* ---------------- exécutions ---------------- */

  // Montant d'une exécution en euros, frais inclus : achat = débit, vente = crédit (positif dans les deux cas).
  function montantExecution(e) {
    if (isNum(e.montant_eur)) return e.montant_eur;
    if (!isNum(e.quantite) || !isNum(e.prix)) return null;
    const brut = e.quantite * e.prix;
    const frais = isNum(e.frais) ? e.frais : 0;
    return e.type === 'achat' ? brut + frais : brut - frais;
  }

  // Une exécution corrigée n'est jamais effacée : elle est marquée `annulee` et le calcul l'ignore.
  const actives = (p) => (p.executions || []).filter((e) => !e.annulee);

  // Bilan d'une position à partir de ses exécutions (PRU pondéré, P&L réalisé, quantité restante).
  function bilanPosition(p) {
    let qAchat = 0, coutAchat = 0, qVente = 0, investi = 0, recupere = 0, realise = 0;
    let qteConnue = true;
    const exs = actives(p).slice().sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
    // achats d'abord pour le PRU (les fiches sans date d'achat sont antérieures aux ventes)
    for (const e of exs.filter((x) => x.type === 'achat')) {
      const m = montantExecution(e);
      if (m == null) continue;
      investi += m;
      if (isNum(e.quantite)) { qAchat += e.quantite; coutAchat += m; } else qteConnue = false;
    }
    const pru = qteConnue && qAchat > 0 ? coutAchat / qAchat : null;
    for (const e of exs.filter((x) => x.type === 'vente')) {
      const m = montantExecution(e);
      if (m == null) continue;
      recupere += m;
      if (pru != null && isNum(e.quantite)) { qVente += e.quantite; realise += m - pru * e.quantite; }
      else qteConnue = false;
    }
    const clotureSansDetail = !!p.cloture_sans_detail;
    let qRestante = qteConnue ? qAchat - qVente : null;
    if (clotureSansDetail) qRestante = 0;
    if (!qteConnue) realise = recupere - investi;       // fiches en montants seuls : tout est vendu
    let statut;
    if (!exs.length) statut = 'annulee';            // toutes les lignes annulées : hors journal et hors stats
    else if (qteConnue) statut = qRestante > 1e-9 ? 'ouverte' : 'fermee';
    else statut = recupere > 0 || exs.some((e) => e.type === 'vente') ? 'fermee' : 'ouverte';
    const coutRestant = pru != null && qRestante > 0 ? pru * qRestante : 0;
    return {
      id: p.id,
      statut,
      investi: r2(investi),
      recupere: r2(recupere),
      pru,
      quantite_achetee: qteConnue ? qAchat : null,
      quantite_restante: qRestante,
      cout_restant: r2(coutRestant),
      pnl_realise: r2(realise),
      pnl_realise_pct: investi > 0 && statut === 'fermee' && !clotureSansDetail ? r2((realise / investi) * 100) : null,
      incomplet: clotureSansDetail,
      doublon_probable: !!p.doublon_probable,
      date_entree: (exs.find((e) => e.type === 'achat' && e.date) || {}).date || null,
      date_sortie: statut === 'fermee' ? (p.cloture && p.cloture.date) || ([...exs].reverse().find((e) => e.type === 'vente' && e.date) || {}).date || null : null,
    };
  }

  /* ---------------- turbo BEST ---------------- */

  // Strike du jour : on part du dernier strike connu (saisi ou d'origine) et on applique le financement estimé.
  function strikeDuJour(p, dateISO, taux) {
    const ref = isNum(p.strike_ref) ? p.strike_ref : p.strike;
    if (!isNum(ref)) return null;
    const dRef = p.date_ref || (bilanPosition(p).date_entree);
    if (!dRef || !dateISO) return ref;
    const jours = Math.max(0, (Date.parse(dateISO) - Date.parse(dRef)) / 86400000);
    const t = isNum(taux) ? taux : (FINANCEMENT[devisePosition(p)] || FINANCEMENT.EUR)[String(p.sens).toUpperCase() === 'PUT' ? 'PUT' : 'CALL'];
    return ref * (1 + t * jours / 360);
  }

  // Valeur théorique d'un turbo en euros : (spot − strike) × sens / parité, convertie depuis l'USD si besoin.
  function valeurTheorique({ spot, strike, sens, parite, devise, eurusd }) {
    if (!isNum(spot) || !isNum(strike) || !isNum(parite) || parite <= 0) return null;
    let v = ((spot - strike) * sgn(sens)) / parite;
    if (devise === 'USD') { if (!isNum(eurusd) || eurusd <= 0) return null; v /= eurusd; }
    return Math.max(0, v);
  }

  // Levier (élasticité) : variation % du turbo pour 1 % du sous-jacent.
  function levier(spot, strike, sens) {
    if (!isNum(spot) || !isNum(strike)) return null;
    const intrinseque = (spot - strike) * sgn(sens);
    return intrinseque > 0 ? spot / intrinseque : null;
  }

  // Distance à la barrière en % du spot (positive tant que la barrière n'est pas touchée).
  function distanceBarriere(spot, barriere, sens) {
    if (!isNum(spot) || !isNum(barriere) || spot <= 0) return null;
    return ((spot - barriere) * sgn(sens) / spot) * 100;
  }

  // Prix du turbo à retenir : prix courtier s'il a moins de 30 min, sinon valeur théorique. Le prix saisi n'est jamais écrasé.
  function prixCourant(p, { spot, eurusd, maintenant, prixBroker } = {}) {
    const now = maintenant ? Date.parse(maintenant) : Date.now();
    if (prixBroker && isNum(prixBroker.prix) && prixBroker.heure) {
      const age = (now - Date.parse(prixBroker.heure)) / 60000;
      if (age >= 0 && age < REGLES.broker_max_min) return { prix: prixBroker.prix, source: 'BROKER', age_min: Math.round(age) };
    }
    const dateISO = jourParis(now);
    const strike = strikeDuJour(p, dateISO);
    const prix = valeurTheorique({ spot, strike, sens: p.sens, parite: p.parite, devise: devisePosition(p), eurusd });
    return { prix, source: prix == null ? null : 'THEO', strike };
  }

  /* ---------------- position ouverte : P&L latent, stop, risque ---------------- */

  function suiviPosition(p, marche = {}) {
    const b = bilanPosition(p);
    const out = { ...b, prix: null, source: null, pnl_latent: null, pnl_latent_pct: null, levier: null,
      distance_barriere_pct: null, stop_prix: null, stop_touche: false, risque_stop_eur: null, risque_stop_pct_poche: null };
    if (b.statut !== 'ouverte' || b.pru == null) return out;
    const pc = prixCourant(p, marche);
    const stopPct = p.plan && isNum(p.plan.stop_pct) ? p.plan.stop_pct : REGLES.stop_pct;
    const stopPrix = isNum(p.plan && p.plan.stop_prix) ? p.plan.stop_prix : b.pru * (1 + stopPct / 100);
    const q = b.quantite_restante;
    out.prix = pc.prix; out.source = pc.source;
    out.stop_prix = stopPrix;
    out.risque_stop_eur = r2(Math.max(0, (b.pru - stopPrix) * q));
    out.risque_stop_pct_poche = REGLES.poche_eur ? r2((out.risque_stop_eur / REGLES.poche_eur) * 100) : null;
    if (isNum(pc.prix)) {
      out.pnl_latent = r2((pc.prix - b.pru) * q);
      out.pnl_latent_pct = r2(((pc.prix - b.pru) / b.pru) * 100);
      out.stop_touche = pc.prix <= stopPrix;
    }
    const jour = jourParis(marche.maintenant ? Date.parse(marche.maintenant) : Date.now());
    const strike = pc.strike != null ? pc.strike : strikeDuJour(p, jour);
    out.levier = r2(levier(marche.spot, strike, p.sens));
    const dev = devisePosition(p), conv = dev === 'USD' && isNum(marche.eurusd) ? marche.eurusd : 1;
    if (isNum(strike) && isNum(p.parite)) {
      out.niveau_stop = r2(strike + sgn(p.sens) * stopPrix * p.parite * conv);
      out.niveau_ko = r2(p.barriere == null || p.barriere === p.strike ? strike : p.barriere);
    }
    const t0 = out.date_entree ? Date.parse(out.date_entree) : null;
    out.jours_en_position = t0 ? Math.max(0, Math.round((Date.parse(jour) - t0) / 86400000)) : null;
    out.spot = isNum(marche.spot) ? marche.spot : null;
    // BEST : barrière = strike du jour ; sinon la barrière enregistrée
    const barriere = p.barriere == null || p.barriere === p.strike ? strike : p.barriere;
    out.distance_barriere_pct = r2(distanceBarriere(marche.spot, barriere, p.sens));
    return out;
  }

  // Taille conseillée pour une nouvelle position : nombre de turbos pour la mise donnée, et perte au stop.
  function dimensionner({ prixTurbo, mise = REGLES.mise_defaut_eur, stopPct = REGLES.stop_pct }) {
    if (!isNum(prixTurbo) || prixTurbo <= 0 || !isNum(mise) || mise <= 0) return null;
    const quantite = Math.floor(mise / prixTurbo);
    const engage = quantite * prixTurbo;
    const perteStop = engage * (-stopPct / 100);
    return { quantite, engage: r2(engage), perte_stop: r2(perteStop), perte_stop_pct_poche: REGLES.poche_eur ? r2((perteStop / REGLES.poche_eur) * 100) : null };
  }

  // Ratio gain/risque sur le sous-jacent (entrée, stop, cible).
  function ratioGainRisque(entree, stop, cible) {
    if (![entree, stop, cible].every(isNum)) return null;
    const risque = Math.abs(entree - stop);
    return risque > 0 ? Math.abs(cible - entree) / risque : null;
  }

  /* ---------------- cash ---------------- */

  function cash(journal) {
    const c = journal.cash || {};
    let total = isNum(c.depot_initial_eur) ? c.depot_initial_eur : 0;
    for (const p of journal.positions || []) {
      for (const e of actives(p)) {
        const m = montantExecution(e);
        if (m == null) continue;
        total += e.type === 'achat' ? -m : m;
      }
    }
    for (const l of c.lignes || []) if (isNum(l.montant_eur)) total += l.montant_eur;
    return total;
  }

  /* ---------------- stats ---------------- */

  function stats(journal, { sansDoublons = false } = {}) {
    const bilans = (journal.positions || []).map(bilanPosition)
      .filter((b) => b.statut === 'fermee' && (!sansDoublons || !b.doublon_probable));
    const pnls = bilans.map((b) => b.pnl_realise);
    const gains = pnls.filter((x) => x > 0), pertes = pnls.filter((x) => x <= 0);
    const somme = (a) => a.reduce((s, x) => s + x, 0);
    const sg = somme(gains), sp = somme(pertes);
    // creux maximal du P&L cumulé, dans l'ordre des sorties
    let cumul = 0, sommet = 0, creux = 0;
    for (const b of bilans.slice().sort((x, y) => String(x.date_sortie || '').localeCompare(String(y.date_sortie || '')))) {
      cumul += b.pnl_realise; sommet = Math.max(sommet, cumul); creux = Math.min(creux, cumul - sommet);
    }
    return {
      positions_fermees: bilans.length,
      gagnantes: gains.length,
      perdantes: pertes.length,
      taux_reussite_pct: bilans.length ? r2((gains.length / bilans.length) * 100) : null,
      pnl_total: r2(somme(pnls)),
      gain_moyen: gains.length ? r2(sg / gains.length) : null,
      perte_moyenne: pertes.length ? r2(sp / pertes.length) : null,
      profit_factor: sp < 0 ? r2(sg / -sp) : null,
      meilleur: pnls.length ? r2(Math.max(...pnls)) : null,
      pire: pnls.length ? r2(Math.min(...pnls)) : null,
      creux_max: r2(creux),
      incompletes: bilans.filter((b) => b.incomplet).length,
      trous: (journal.trous || []).map((t) => t.message),
    };
  }

  /* ---------------- calendrier, alertes, règles ---------------- */

  // « 2026-10-28 » + « 19:00 » (heure de Paris) → millisecondes UTC.
  function parisVersMs(dateISO, hhmm) {
    const [y, m, d] = dateISO.split('-').map(Number), [hh, mm] = (hhmm || '00:00').split(':').map(Number);
    let t = Date.UTC(y, m - 1, d, hh, mm);
    for (let i = 0; i < 2; i++) {
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(t));
      const g = (k) => Number(parts.find((x) => x.type === k).value);
      t += Date.UTC(y, m - 1, d, hh, mm) - Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'));
    }
    return t;
  }
  function jourParis(ms) { return new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' }); }
  const heureParis = (ms) => new Date(ms).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });

  // Annonces à venir (dans `heures` heures), triées.
  function annoncesProches(calendrier, maintenant, heures) {
    const now = maintenant, lim = now + heures * 3600000;
    // Une ligne « toute la journée » (sans heure) reste visible jusqu'au soir.
    return (calendrier || []).map((e) => ({ ...e, ms: parisVersMs(e.date, e.heure_paris || '23:59') })).filter((e) => e.ms >= now - 15 * 60000 && e.ms <= lim).sort((a, b) => a.ms - b.ms);
  }
  const estFOMC = (e) => /FOMC décision/i.test(e.nom || '') || (/FOMC/i.test(e.nom || '') && e.majeure);
  // Annonce majeure (FOMC, CPI, emploi, PCE, BCE) : être à plat. Ancien format sans champ : majeure.
  const estMajeure = (e) => e.majeure !== false && (!e.type || e.type === 'macro');
  const estForte = (e) => e.impact === 'fort' && e.type === 'macro' && !estMajeure(e);
  // Période FOMC : de la veille de la réunion (2 jours) jusqu'à la décision.
  function enPeriodeFOMC(calendrier, maintenant) {
    const j = Date.parse(jourParis(maintenant));
    return (calendrier || []).some((e) => estFOMC(e) && j >= Date.parse(e.date) - 2 * 86400000 && j <= Date.parse(e.date));
  }
  // Séance de chaque cours, en heure de Paris (lundi-vendredi). Hors séance, un vieux cours est normal.
  const SEANCES = { '^FCHI': [9, 17.6], '^GSPC': [15.5, 22], '^VIX': [15.5, 22], 'NQ=F': [0, 23], 'EURUSD=X': [0, 23] };
  function seanceOuverte(ticker, maintenant) {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', weekday: 'short', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(maintenant));
    const wd = p.find((x) => x.type === 'weekday').value, h = Number(p.find((x) => x.type === 'hour').value) + Number(p.find((x) => x.type === 'minute').value) / 60;
    const [a, b] = SEANCES[ticker] || (/\.PA$/.test(ticker) ? [9, 17.6] : [9, 22]);
    return !['Sat', 'Sun'].includes(wd) && h >= a && h < b;
  }
  function marcheOuvert(maintenant) {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', weekday: 'short', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(maintenant));
    const wd = p.find((x) => x.type === 'weekday').value, h = Number(p.find((x) => x.type === 'hour').value) + Number(p.find((x) => x.type === 'minute').value) / 60;
    return !['Sat', 'Sun'].includes(wd) && h >= 9 && h < 22;
  }

  // Alertes de la journée : { niveau: 'rouge'|'orange', texte }.
  function alertes({ suivis, quotes, calendrier, maintenant }) {
    const a = [];
    for (const { p, s } of suivis.filter((x) => x.s.statut === 'ouverte')) {
      if (s.stop_touche) a.push({ niveau: 'rouge', texte: `Stop touché : ${p.libelle}` });
      // alertes de barrière retirées à la demande de Guillaume (08/10) : la marge reste affichée sur les cartes
      const k = cleSousJacent(p.sous_jacent), q = k && quotes && quotes.quotes && quotes.quotes[SOUS_JACENTS[k].quote];
      if (q && q.quote_time && seanceOuverte(SOUS_JACENTS[k].quote, maintenant)) {
        const age = Math.round((maintenant - Date.parse(q.quote_time)) / 60000);
        if (age > 20) a.push({ niveau: 'orange', texte: `Cours ${k} vieux de ${age} min : le prix du turbo est une estimation douteuse` });
      }
    }
    const ouvert = suivis.some((x) => x.s.statut === 'ouverte');
    for (const e of annoncesProches(calendrier, maintenant, 2)) {
      if (estMajeure(e)) a.push({ niveau: ouvert ? 'rouge' : 'orange', texte: `${e.nom} à ${e.heure_paris}${ouvert ? ' : être à plat avant' : ''}` });
      else if (estForte(e)) a.push({ niveau: 'orange', texte: `${e.nom} à ${e.heure_paris} : prudence` });
    }
    return a;
  }
  const nb2 = (x) => Math.round(x * 100) / 100;

  // Règles du PLAN, avant un achat. Renvoie une liste d'avertissements (jamais bloquants).
  // `prixActuels` : { id de position: prix actuel du turbo } pour repérer une position déjà en perte.
  function verifierRegles({ journal, sens, sousJacent, strike, prix, levierTurbo, stopPct, mise, calendrier, maintenant, prixActuels }) {
    const w = [], R = REGLES;
    const k = cleSousJacent(sousJacent);
    if (isNum(levierTurbo) && levierTurbo > 20 && enPeriodeFOMC(calendrier, maintenant)) w.push(`Levier ×${Math.round(levierTurbo * 10) / 10} : le maximum est ×20 en période FOMC.`);
    if (isNum(stopPct) && stopPct < (isNum(R.stop_pct) ? R.stop_pct : -40)) w.push(`Stop à ${stopPct} % : la règle est ${R.stop_pct} %.`);
    for (const p of journal.positions || []) {
      const b = bilanPosition(p);
      if (b.statut !== 'ouverte' || b.pru == null) continue;
      if (cleSousJacent(p.sous_jacent) !== k || String(p.sens).toUpperCase() !== String(sens).toUpperCase()) continue;
      const actuel = prixActuels && isNum(prixActuels[p.id]) ? prixActuels[p.id] : null;
      const memeTurbo = isNum(strike) && p.strike === strike && isNum(prix) && prix < b.pru;   // sans prix actuel : même turbo racheté moins cher
      if (isNum(actuel) ? actuel < b.pru : memeTurbo)
        w.push(`Moyenne à la baisse : ${p.libelle} est déjà ouvert et en perte (prix moyen ${Math.round(b.pru * 1000) / 1000} €).`);
    }
    const ouvertes = (journal.positions || []).map(bilanPosition).filter((b) => b.statut === 'ouverte');
    const engage = ouvertes.reduce((t, b) => t + (b.cout_restant || 0), 0);
    if (isNum(R.poche_eur) && isNum(mise) && engage + mise > R.poche_eur) w.push(`Au-dessus de la poche : ${Math.round(engage + mise)} € engagés pour ${R.poche_eur} €.`);
    for (const e of annoncesProches(calendrier, maintenant, 3).filter(estMajeure)) w.push(`${e.nom} à ${e.heure_paris} : ${e.regle || 'à plat avant'}.`);
    return w;
  }

  /* ---------------- reco du matin (reco/latest.json) ---------------- */

  // Une idée de la reco, revue par l'app : entrée (milieu de zone), R:R recalculé, cohérence des niveaux,
  // écart du cours actuel à l'entrée. `orange` : à ne pas suivre les yeux fermés.
  function revoirIdee(idee, spot, recoDuJour) {
    const e = idee.entree || {}, put = String(idee.sens).toUpperCase() === 'PUT', sgn = put ? -1 : 1;
    const bas = isNum(e.bas) ? e.bas : e.haut, haut = isNum(e.haut) ? e.haut : e.bas;
    const entree = isNum(bas) && isNum(haut) ? (bas + haut) / 2 : null;
    const r = { entree, ratio: null, incoherences: [], ecart_pct: null, orange: [] };
    if (isNum(entree) && isNum(idee.stop) && isNum(idee.objectif1)) {
      const risque = sgn * (entree - idee.stop), gain = sgn * (idee.objectif1 - entree);
      if (risque > 0) r.ratio = Math.round((gain / risque) * 100) / 100;
      if (!(risque > 0)) r.incoherences.push('stop du mauvais côté de l\'entrée');
      if (!(gain > 0)) r.incoherences.push('objectif du mauvais côté de l\'entrée');
    }
    if (isNum(idee.barriere) && isNum(idee.stop) && !(sgn * (idee.stop - idee.barriere) > 0)) r.incoherences.push('barrière avant le stop');
    if (isNum(spot) && isNum(bas) && isNum(haut)) {
      const lo = Math.min(bas, haut), hi = Math.max(bas, haut), d = spot < lo ? lo - spot : spot > hi ? spot - hi : 0;
      r.ecart_pct = Math.round((d / spot) * 10000) / 100;
      if (r.ecart_pct > 0.5) r.orange.push(`cours à ${String(r.ecart_pct).replace('.', ',')} % de l'entrée`);
    }
    if (!recoDuJour) r.orange.push('reco d\'un autre jour');
    if (r.incoherences.length) r.orange.push('niveaux incohérents : ' + r.incoherences.join(', '));
    return r;
  }

  // Track record des recos (fichier reco/scores.json écrit par score.yml). Aucune conclusion sous 30 idées.
  function statsRecos(scores) {
    const l = (scores || []).filter((s) => s && s.issue);
    const decl = l.filter((s) => s.declenchee), rs = decl.map((s) => s.r).filter(isNum);
    const somme = rs.reduce((t, v) => t + v, 0);
    return {
      idees: l.length, declenchees: decl.length,
      objectif: decl.filter((s) => s.issue === 'objectif').length, stop: decl.filter((s) => s.issue === 'stop').length,
      r_total: Math.round(somme * 100) / 100, r_moyen: rs.length ? Math.round((somme / rs.length) * 100) / 100 : null,
      gagnantes_pct: rs.length ? Math.round((rs.filter((v) => v > 0).length / rs.length) * 100) : null,
      assez: l.length >= 30,
    };
  }

  // Réalisé d'une journée (ventes datées ce jour-là), valeur totale (caisse + positions au prix estimé).
  function realiseDuJour(journal, jour) {
    let t = 0;
    for (const p of journal.positions || []) {
      const b = bilanPosition(p);
      if (b.pru == null) continue;
      for (const e of actives(p)) if (e.type === 'vente' && e.date === jour) { const m = montantExecution(e); if (m != null && isNum(e.quantite)) t += m - b.pru * e.quantite; }
    }
    return r2(t);
  }
  function valeurTotale(journal, suivis) {
    return r2(cash(journal) + suivis.filter((x) => x.s.statut === 'ouverte').reduce((t, x) => t + (isNum(x.s.prix) ? x.s.prix * x.s.quantite_restante : x.s.cout_restant || 0), 0));
  }

  /* ---------------- affichage ---------------- */

  // Montant en euros, arrondi au centime ; « ,00 » masqué (1 234,9995 → « 1 235 € »).
  function formatEur(x, { signe = false } = {}) {
    if (!isNum(x)) return '—';
    const c = Math.round(x * 100) / 100;
    const entier = Math.abs(c - Math.round(c)) < 1e-9;
    const s = c.toLocaleString('fr-FR', { minimumFractionDigits: entier ? 0 : 2, maximumFractionDigits: entier ? 0 : 2 })
      .replace(/ | /g, ' ');
    return (signe && c > 0 ? '+' : '') + s + ' €';
  }

  const Calc = { REGLES, configurer, FINANCEMENT, SOUS_JACENTS, cleSousJacent, devisePosition, montantExecution, bilanPosition,
    strikeDuJour, valeurTheorique, levier, distanceBarriere, prixCourant, suiviPosition, dimensionner,
    ratioGainRisque, cash, stats, formatEur, actives, parisVersMs, jourParis, heureParis, annoncesProches, enPeriodeFOMC, estMajeure, revoirIdee, statsRecos,
    marcheOuvert, seanceOuverte, alertes, verifierRegles, realiseDuJour, valeurTotale };

  if (typeof module !== 'undefined' && module.exports) module.exports = Calc;
  else root.Calc = Calc;
})(typeof window !== 'undefined' ? window : globalThis);
