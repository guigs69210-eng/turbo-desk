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
  function configurer(regles) { Object.assign(REGLES, regles || {}); return REGLES; }

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

  // Bilan d'une position à partir de ses exécutions (PRU pondéré, P&L réalisé, quantité restante).
  function bilanPosition(p) {
    let qAchat = 0, coutAchat = 0, qVente = 0, investi = 0, recupere = 0, realise = 0;
    let qteConnue = true;
    const exs = (p.executions || []).slice().sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
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
    if (qteConnue) statut = qRestante > 1e-9 ? 'ouverte' : 'fermee';
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
    const dateISO = new Date(now).toISOString().slice(0, 10);
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
    const jour = new Date(marche.maintenant ? Date.parse(marche.maintenant) : Date.now()).toISOString().slice(0, 10);
    const strike = pc.strike != null ? pc.strike : strikeDuJour(p, jour);
    out.levier = r2(levier(marche.spot, strike, p.sens));
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
      for (const e of p.executions || []) {
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
    ratioGainRisque, cash, stats, formatEur };

  if (typeof module !== 'undefined' && module.exports) module.exports = Calc;
  else root.Calc = Calc;
})(typeof window !== 'undefined' ? window : globalThis);
