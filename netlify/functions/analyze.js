// Fonction Netlify : appelle l'API Gemini cote serveur (la cle reste cachee ici).
// Recoit { url, theme }, renvoie le diagnostic en JSON.
// Modele : gemini-3.5-flash-lite (couvert par le niveau gratuit Google AI Studio).

const MODEL = "gemini-3.5-flash-lite";

// Mode d'appel a Gemini. Peut etre force via la variable Netlify GEMINI_MODE
// ("ancre", "schema" ou "simple") pour eviter les tentatives inutiles et economiser
// du temps d'execution. Sinon, le premier appel determine le mode et il est memorise
// tant que le conteneur reste chaud.
let MODE_RETENU = process.env.GEMINI_MODE || null;


// --------- Schema impose : Gemini ne peut plus devier du format ---------
const SCHEMA = {
  type: "OBJECT",
  properties: {
    site: { type: "STRING" },
    verdict: { type: "STRING" },
    aio: {
      type: "OBJECT",
      properties: {
        enjeu: { type: "STRING" },
        requete: { type: "STRING" },
        apercu: { type: "STRING" },
        citationRaison: { type: "STRING" },
      },
      required: ["enjeu", "requete", "apercu", "citationRaison"],
    },
    llm: {
      type: "OBJECT",
      properties: {
        enjeu: { type: "STRING" },
        raison: { type: "STRING" },
      },
      required: ["enjeu", "raison"],
    },
    explications: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { enjeu: { type: "STRING" }, action: { type: "STRING" } },
        required: ["enjeu", "action"],
      },
    },
    recos: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          titre: { type: "STRING" },
          perimetre: { type: "STRING", enum: ["Google AI Overview", "Assistants IA", "Les deux"] },
          detail: { type: "STRING" },
          impact: { type: "STRING", enum: ["fort", "moyen"] },
          delai: { type: "STRING", enum: ["court terme", "moyen terme"] },
          responsable: { type: "STRING", enum: ["Redaction", "Technique", "Marketing", "Produit"] },
        },
        required: ["titre", "perimetre", "detail", "impact", "delai", "responsable"],
      },
    },
  },
  required: ["site", "verdict", "aio", "llm", "explications", "recos"],
};

// --------- Assemblage : mesures calculees + redaction du modele ---------
function assembler(txt, calcAIO, calcLLM, criteres, robots, site, hostFinal, redirige, mode) {
  const d = (txt && typeof txt === "object") ? txt : {};
  const aio = d.aio || {};
  const llm = d.llm || {};
  const expl = Array.isArray(d.explications) ? d.explications : [];

  // Les signaux combinent le constat mesure et l'explication redigee.
  const signaux = criteres.map(function (c, i) {
    return {
      nom: c.nom,
      perimetre: c.perimetre,
      etat: c.etat,
      constat: c.constat,
      enjeu: (expl[i] && expl[i].enjeu) || "",
      action: (expl[i] && expl[i].action) || "",
      obtenu: c.obtenu,
      max: c.max,
    };
  });

  return {
    site: d.site || "",
    verdict: d.verdict || "",
    mesurable: !!calcAIO,
    aio: calcAIO ? {
      score: calcAIO.score,
      detail: calcAIO.detail,
      enjeu: aio.enjeu || "",
      requete: aio.requete || "",
      apercu: aio.apercu || "",
      citation: { verdict: verdictCitation(calcAIO.score), raison: aio.citationRaison || "" },
    } : null,
    llm: calcLLM ? {
      score: calcLLM.score,
      detail: calcLLM.detail,
      enjeu: llm.enjeu || "",
      presence: niveauPresence(calcLLM.score),
      raison: llm.raison || "",
      acces: { etat: robots && robots.dispo
                 ? (robots.nbBloques === 0 ? "ouvert" : (robots.nbBloques >= robots.nbTotal - 1 ? "restreint" : "partiel"))
                 : "indetermine",
               note: "" },
    } : null,
    signaux: signaux,
    recos: Array.isArray(d.recos) ? d.recos : [],
    robots: robots,
    site_: site,
    hostFinal: hostFinal,
    redirige: redirige,
    mode: mode,
  };
}


// --------- Grille de scoring deterministe ---------
// Le score est CALCULE a partir des mesures, jamais produit par le modele.
// Meme site analyse deux fois = meme score. La grille est explicite et opposable.

function pts(valeur, paliers) {
  // paliers : [[seuil, points], ...] du plus haut au plus bas
  for (let i = 0; i < paliers.length; i++) {
    if (valeur >= paliers[i][0]) return paliers[i][1];
  }
  return 0;
}

function etatVers(v, plein, moitie) {
  if (v === "present") return plein;
  if (v === "partiel") return moitie;
  return 0;
}

// Score Google AI Overview : entierement mesurable sur les pages.
function scoreAIO(m) {
  const d = [];
  d.push({ critere: "Balisage Article ou NewsArticle", obtenu: etatVers(m.balisageArticle, 20, 10), max: 20,
           constat: m.balisageArticle === "present" ? "Present sur les articles analyses"
                  : (m.balisageArticle === "partiel" ? "Present sur une partie des articles" : "Absent des articles analyses") });
  d.push({ critere: "Auteur declare dans les donnees structurees", obtenu: etatVers(m.auteurBalise, 15, 8), max: 15,
           constat: m.auteurBalise === "present" ? "Champ auteur renseigne"
                  : (m.auteurBalise === "partiel" ? "Champ auteur renseigne par intermittence" : "Champ auteur absent") });
  d.push({ critere: "Date de publication declaree", obtenu: etatVers(m.datePubliee, 10, 5), max: 10,
           constat: m.datePubliee === "present" ? "Date de publication presente" : "Date de publication absente" });
  d.push({ critere: "Date de mise a jour declaree", obtenu: etatVers(m.dateMaj, 15, 8), max: 15,
           constat: m.dateMaj === "present" ? "Date de modification presente" : "Date de modification absente" });
  d.push({ critere: "Signature visible sur la page", obtenu: etatVers(m.auteurAffiche, 5, 3), max: 5,
           constat: m.auteurAffiche === "present" ? "Signature affichee" : "Aucune signature reperee" });
  d.push({ critere: "Donnees chiffrees par article", obtenu: pts(m.chiffresMoyen, [[4,15],[3,12],[2,9],[1,5]]), max: 15,
           constat: m.chiffresMoyen + " donnee(s) chiffree(s) en moyenne" });
  d.push({ critere: "Sous-titres par article", obtenu: pts(m.sousTitresMoyen, [[5,10],[3,7],[1,4]]), max: 10,
           constat: m.sousTitresMoyen + " sous-titre(s) en moyenne" });
  d.push({ critere: "Longueur des articles", obtenu: pts(m.motsMoyen, [[1200,10],[600,8],[300,5]]), max: 10,
           constat: m.motsMoyen + " mots en moyenne" });

  const total = d.reduce(function (a, x) { return a + x.obtenu; }, 0);
  return { score: total, detail: d };
}

// Score Assistants IA : part mesurable uniquement.
// Les mentions de la marque hors du site ne sont pas mesurables ici, c'est assume et affiche.
function scoreLLM(m, robots) {
  const d = [];

  let ptsAcces = 0, constatAcces;
  if (robots && robots.dispo) {
    const ouverts = robots.nbTotal - robots.nbBloques;
    ptsAcces = Math.round((ouverts / robots.nbTotal) * 40);
    constatAcces = ouverts + " robot(s) IA sur " + robots.nbTotal + " ont acces au site";
  } else {
    constatAcces = "Fichier robots.txt non lisible, acces non verifiable";
  }
  d.push({ critere: "Acces des robots IA", obtenu: ptsAcces, max: 40, constat: constatAcces });

  d.push({ critere: "Auteur declare dans les donnees structurees", obtenu: etatVers(m.auteurBalise, 20, 10), max: 20,
           constat: m.auteurBalise === "present" ? "Auteur identifiable par les machines" : "Auteur non identifiable par les machines" });
  d.push({ critere: "Balisage Article ou NewsArticle", obtenu: etatVers(m.balisageArticle, 15, 8), max: 15,
           constat: m.balisageArticle === "present" ? "Contenu identifie comme article" : "Contenu non identifie comme article" });
  d.push({ critere: "Date de mise a jour declaree", obtenu: etatVers(m.dateMaj, 10, 5), max: 10,
           constat: m.dateMaj === "present" ? "Actualisation explicite" : "Actualisation non declaree" });
  d.push({ critere: "Longueur des articles", obtenu: pts(m.motsMoyen, [[1200,15],[600,11],[300,6]]), max: 15,
           constat: m.motsMoyen + " mots en moyenne" });

  const total = d.reduce(function (a, x) { return a + x.obtenu; }, 0);
  return { score: total, detail: d };
}

// Etat d'un critere a partir du taux d'obtention
function etatCritere(obtenu, max) {
  const r = max ? obtenu / max : 0;
  if (r >= 0.75) return "fort";
  if (r >= 0.4) return "moyen";
  return "faible";
}

// Verdict de citation deduit du score, pas invente.
function verdictCitation(score) {
  if (score >= 70) return "probable";
  if (score >= 45) return "partielle";
  return "improbable";
}
function niveauPresence(score) {
  if (score >= 70) return "forte";
  if (score >= 45) return "partielle";
  return "faible";
}

// --------- Validation du domaine ---------
// Rejette les saisies qui ne sont pas des noms de domaine (ex : "challenges").
function domaineValide(host) {
  if (!host) return false;
  if (host.length > 253) return false;
  return /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*\.[a-z]{2,24}$/i.test(host);
}

// --------- Lecture reelle des pages du site ---------
// Recupere la page d'accueil, y repere des articles, et mesure les signaux
// qui determinent la citation par les IA. Tout est factuel, rien n'est estime ici.
// Les delais sont courts et les appels parallelises : la fonction doit tenir
// dans le temps d'execution alloue par Netlify.

const UA = { "user-agent": "ReadrDiagnostic/1.0 (+https://www.readr.agency)" };

async function getHTML(u, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, ms || 3000);
  try {
    const r = await fetch(u, { signal: ctrl.signal, redirect: "follow", headers: UA });
    clearTimeout(timer);
    if (!r.ok) return null;
    const ct = r.headers.get("content-type") || "";
    if (ct && ct.indexOf("html") === -1) return null;
    const txt = await r.text();
    return { html: txt.slice(0, 400000), urlFinale: r.url || u };
  } catch (e) {
    clearTimeout(timer);
    return null;
  }
}

// Retire scripts, styles et balises pour obtenir le texte visible.
function texteVisible(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Cherche des liens d'articles plausibles sur la page d'accueil.
function trouverArticles(html, origin) {
  const exclus = /\/(tag|tags|category|categories|auteur|author|page|abonnement|abonnez|newsletter|contact|mentions|cgv|cgu|privacy|login|compte|recherche|search|rss|feed)\b/i;
  const liens = [];
  const re = /<a\s[^>]*href=["']([^"'#]+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null && liens.length < 200) {
    let href = m[1];
    if (!href || href.indexOf("mailto:") === 0 || href.indexOf("javascript:") === 0) continue;
    let abs;
    try { abs = new URL(href, origin).href; } catch (e) { continue; }
    if (abs.indexOf(origin) !== 0) continue;
    if (exclus.test(abs)) continue;
    const chemin = abs.slice(origin.length);
    if (chemin.length < 12) continue;
    const segments = chemin.split("/").filter(Boolean);
    if (segments.length < 1) continue;
    const dernier = segments[segments.length - 1];
    if (dernier.indexOf("-") === -1 && !/\d/.test(dernier)) continue;
    if (liens.indexOf(abs) === -1) liens.push(abs);
  }
  return liens.slice(0, 2);
}

// Analyse une page article et en extrait les signaux mesurables.
function analyserPage(html) {
  const res = {
    schemaArticle: false, schemaAuteur: false, schemaDatePub: false, schemaDateMaj: false,
    auteurVisible: false, dateVisible: false,
    h1: 0, h2: 0, paragraphes: 0, mots: 0, chiffres: 0,
  };
  if (!html) return res;

  const blocs = html.match(/<script[^>]+application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) || [];
  blocs.forEach(function (b) {
    const brut = b.replace(/<script[^>]*>/i, "").replace(/<\/script>/i, "").trim();
    let data;
    try { data = JSON.parse(brut); } catch (e) { return; }
    const items = [];
    (function aplatir(x) {
      if (!x) return;
      if (Array.isArray(x)) { x.forEach(aplatir); return; }
      if (typeof x !== "object") return;
      items.push(x);
      if (x["@graph"]) aplatir(x["@graph"]);
    })(data);
    items.forEach(function (it) {
      const t = it["@type"];
      const types = Array.isArray(t) ? t.join(" ") : String(t || "");
      if (/Article|NewsArticle|BlogPosting|ReportageNewsArticle/i.test(types)) {
        res.schemaArticle = true;
        if (it.author) res.schemaAuteur = true;
        if (it.datePublished) res.schemaDatePub = true;
        if (it.dateModified) res.schemaDateMaj = true;
      }
    });
  });

  if (/property=["']article:published_time["']/i.test(html)) res.dateVisible = true;
  if (/property=["']article:modified_time["']/i.test(html)) res.schemaDateMaj = true;
  if (/name=["']author["']/i.test(html) || /rel=["']author["']/i.test(html)) res.auteurVisible = true;
  if (/<time[\s>]/i.test(html)) res.dateVisible = true;
  if (/class=["'][^"']*(author|auteur|signature|byline)[^"']*["']/i.test(html)) res.auteurVisible = true;

  res.h1 = (html.match(/<h1[\s>]/gi) || []).length;
  res.h2 = (html.match(/<h2[\s>]/gi) || []).length;
  res.paragraphes = (html.match(/<p[\s>]/gi) || []).length;

  const texte = texteVisible(html);
  res.mots = texte ? texte.split(/\s+/).length : 0;
  res.chiffres = (texte.match(/\b\d[\d\s.,]*\s*(%|euros?|EUR|\u20ac|millions?|milliards?|ans?)\b/gi) || []).length
               + (texte.match(/\b\d{1,3}([.,]\d+)?\s?%/g) || []).length;

  return res;
}

async function lireSite(origin) {
  const rep = await getHTML(origin, 3000);
  if (!rep) return { dispo: false, raison: "page d'accueil illisible" };
  const accueil = rep.html;

  let originFinal = origin;
  try { originFinal = new URL(rep.urlFinale).origin; } catch (e) {}

  const urls = trouverArticles(accueil, originFinal);
  // En parallele : deux articles coutent le meme temps qu'un seul.
  const reps = await Promise.all(urls.map(function (u) { return getHTML(u, 3000); }));
  const pages = [];
  reps.forEach(function (h, i) {
    if (h) pages.push({ url: urls[i], mesures: analyserPage(h.html), extrait: texteVisible(h.html).slice(0, 700) });
  });

  if (!pages.length) {
    return { dispo: false, raison: "aucun article accessible", nbArticles: 0, originFinal: originFinal };
  }

  const n = pages.length;
  const agg = pages.reduce(function (a, p) {
    const m = p.mesures;
    a.schemaArticle += m.schemaArticle ? 1 : 0;
    a.schemaAuteur += m.schemaAuteur ? 1 : 0;
    a.schemaDatePub += m.schemaDatePub ? 1 : 0;
    a.schemaDateMaj += m.schemaDateMaj ? 1 : 0;
    a.auteurVisible += m.auteurVisible ? 1 : 0;
    a.dateVisible += m.dateVisible ? 1 : 0;
    a.mots += m.mots; a.chiffres += m.chiffres; a.h2 += m.h2; a.paragraphes += m.paragraphes;
    return a;
  }, { schemaArticle:0, schemaAuteur:0, schemaDatePub:0, schemaDateMaj:0, auteurVisible:0,
       dateVisible:0, mots:0, chiffres:0, h2:0, paragraphes:0 });

  return {
    dispo: true,
    nbArticles: n,
    originFinal: originFinal,
    urls: pages.map(function (p) { return p.url; }),
    extraits: pages.map(function (p) { return p.extrait; }),
    balisageArticle: agg.schemaArticle === n ? "present" : (agg.schemaArticle > 0 ? "partiel" : "absent"),
    auteurBalise: agg.schemaAuteur === n ? "present" : (agg.schemaAuteur > 0 ? "partiel" : "absent"),
    datePubliee: (agg.schemaDatePub > 0 || agg.dateVisible > 0) ? "present" : "absent",
    dateMaj: agg.schemaDateMaj > 0 ? "present" : "absent",
    auteurAffiche: agg.auteurVisible > 0 ? "present" : "absent",
    motsMoyen: Math.round(agg.mots / n),
    chiffresMoyen: Math.round((agg.chiffres / n) * 10) / 10,
    sousTitresMoyen: Math.round(agg.h2 / n),
  };
}

// --------- Lecture reelle du robots.txt ---------
// Les robots IA les plus courants. Libelle = ce qui s'affiche a l'ecran.
const AI_BOTS = [
  { ua: "GPTBot",             label: "GPTBot",             org: "OpenAI (entrainement)" },
  { ua: "OAI-SearchBot",      label: "OAI-SearchBot",      org: "OpenAI (recherche)" },
  { ua: "ChatGPT-User",       label: "ChatGPT-User",       org: "ChatGPT (navigation)" },
  { ua: "Google-Extended",    label: "Google-Extended",    org: "Google Gemini" },
  { ua: "PerplexityBot",      label: "PerplexityBot",      org: "Perplexity" },
  { ua: "ClaudeBot",          label: "ClaudeBot",          org: "Anthropic" },
  { ua: "CCBot",              label: "CCBot",              org: "Common Crawl" },
  { ua: "Applebot-Extended",  label: "Applebot-Extended",  org: "Apple Intelligence" },
];

function parseRobots(txt) {
  // Retourne une map : user-agent (minuscule) -> { disallow:[], allow:[] }
  const groups = {};
  let current = [];
  let expectRules = false;
  txt.split(/\r?\n/).forEach(function (raw) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) return;
    const idx = line.indexOf(":");
    if (idx === -1) return;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      if (expectRules) { current = []; expectRules = false; }
      const ua = value.toLowerCase();
      current.push(ua);
      if (!groups[ua]) groups[ua] = { disallow: [], allow: [] };
    } else if (field === "disallow" || field === "allow") {
      expectRules = true;
      current.forEach(function (ua) {
        if (!groups[ua]) groups[ua] = { disallow: [], allow: [] };
        groups[ua][field === "disallow" ? "disallow" : "allow"].push(value);
      });
    }
  });
  return groups;
}

function botStatus(groups, ua) {
  const key = ua.toLowerCase();
  const explicit = Object.prototype.hasOwnProperty.call(groups, key);
  const rules = explicit ? groups[key] : groups["*"];
  if (!rules) return { etat: "autorise", source: "aucune regle" };
  const blockedAll = rules.disallow.some(function (d) { return d === "/"; });
  const allowedAll = rules.allow.some(function (a) { return a === "/"; });
  if (blockedAll && !allowedAll) {
    return { etat: "bloque", source: explicit ? "regle explicite" : "regle generale" };
  }
  if (rules.disallow.some(function (d) { return d && d !== "/"; })) {
    return { etat: "partiel", source: explicit ? "regle explicite" : "regle generale" };
  }
  return { etat: "autorise", source: explicit ? "regle explicite" : "regle generale" };
}

async function readRobots(siteUrl) {
  let origin;
  try { origin = new URL(siteUrl).origin; } catch (e) { return { dispo: false, raison: "URL invalide" }; }

  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, 4000);
  try {
    const r = await fetch(origin + "/robots.txt", {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "user-agent": "ReadrDiagnostic/1.0 (+https://www.readr.agency)" },
    });
    clearTimeout(timer);
    if (!r.ok) return { dispo: false, joignable: true, raison: "robots.txt inaccessible (HTTP " + r.status + ")" };
    const txt = (await r.text()).slice(0, 200000);
    if (!/user-agent/i.test(txt)) return { dispo: false, joignable: true, raison: "robots.txt vide ou non standard" };

    const groups = parseRobots(txt);
    const bots = AI_BOTS.map(function (b) {
      const st = botStatus(groups, b.ua);
      return { nom: b.label, org: b.org, etat: st.etat, source: st.source };
    });
    const bloques = bots.filter(function (b) { return b.etat === "bloque"; });
    const partiels = bots.filter(function (b) { return b.etat === "partiel"; });

    let etat;
    if (bloques.length === 0 && partiels.length === 0) etat = "ouvert";
    else if (bloques.length >= bots.length - 1) etat = "restreint";
    else etat = "partiel";

    return {
      dispo: true,
      etat: etat,
      bots: bots,
      nbBloques: bloques.length,
      nbTotal: bots.length,
      listeBloques: bloques.map(function (b) { return b.nom; }),
    };
  } catch (e) {
    clearTimeout(timer);
    const code = (e && e.cause && e.cause.code) || "";
    // ENOTFOUND : le domaine n'existe pas du tout.
    if (code === "ENOTFOUND") return { dispo: false, joignable: false, raison: "domaine introuvable" };
    return { dispo: false, joignable: true, raison: "robots.txt injoignable" };
  }
}



exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  if (!process.env.GEMINI_API_KEY) {
    return {
      statusCode: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        error: "Cl\u00e9 GEMINI_API_KEY absente. Ajoutez-la dans les variables Netlify puis relancez un d\u00e9ploiement.",
      }),
    };
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { body = {}; }
  const url = (body.url || "").trim();
  const theme = (body.theme || "").trim();
  if (!url) return { statusCode: 400, body: JSON.stringify({ error: "url manquante" }) };

  // Le domaine doit etre syntaxiquement valide (extension obligatoire).
  let origin, host;
  try {
    const parsed = new URL(url);
    origin = parsed.origin;
    host = parsed.hostname;
  } catch (e) {
    return {
      statusCode: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "Adresse invalide. Indiquez un domaine complet, par exemple economist.com" }),
    };
  }
  if (!domaineValide(host)) {
    return {
      statusCode: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "Adresse incompl\u00e8te. Indiquez le domaine avec son extension, par exemple economist.com" }),
    };
  }



  const sys = [
    "Tu es consultant senior en visibilit\u00e9 des contenus dans les moteurs de r\u00e9ponse IA.",
    "Tes interlocuteurs sont des directions marketing et produit de m\u00e9dias fran\u00e7ais. Ils connaissent le SEO, l'audience et l'abonnement, pas le jargon GEO.",
    "",
    "R\u00c8GLE ABSOLUE : tu ne produis AUCUN chiffre, AUCUN score, AUCUN \u00e9tat de crit\u00e8re.",
    "Les scores et les constats te sont fournis, ils ont \u00e9t\u00e9 mesur\u00e9s sur les pages du site.",
    "Ton r\u00f4le est uniquement d'expliquer ce que ces mesures impliquent et de recommander des actions.",
    "Ne contredis jamais une mesure fournie. N'invente aucune donn\u00e9e qui ne t'a pas \u00e9t\u00e9 transmise.",
    "Si une information ne t'a pas \u00e9t\u00e9 fournie, ne l'invente pas et reste sur ce que tu sais.",
    "",
    "Tu distingues deux environnements :",
    "1. GOOGLE AI OVERVIEW : le r\u00e9sum\u00e9 au-dessus des r\u00e9sultats de recherche, adoss\u00e9 \u00e0 l'index Google. Enjeu business : une perte de trafic existant.",
    "2. ASSISTANTS IA (ChatGPT, Perplexity, Gemini, Claude) : hors moteur de recherche, d\u00e9pendants de leurs propres robots et des mentions de la marque ailleurs sur le web. Enjeu business : la pr\u00e9sence de marque.",
    "",
    "Point de vigilance : de nombreux \u00e9diteurs fran\u00e7ais bloquent volontairement les robots IA dans le cadre des n\u00e9gociations sur les droits voisins. Un acc\u00e8s restreint peut donc \u00eatre un choix strat\u00e9gique, jamais une erreur technique.",
    "",
    "R\u00c8GLES DE R\u00c9DACTION :",
    "- Fran\u00e7ais professionnel, tous les accents correctement plac\u00e9s. Vouvoiement.",
    "- Interdiction absolue du tiret cadratin et du tiret demi-cadratin.",
    "- Pas de superlatifs marketing, pas de formules creuses.",
    "- Chaque phrase apporte une information utile.",
    "",
    "Contenus attendus :",
    "- verdict : une phrase de 18 mots maximum, coh\u00e9rente avec les deux scores fournis.",
    "- aio.enjeu et llm.enjeu : deux phrases chacun, exprim\u00e9es en trafic, audience et abonnement.",
    "- aio.requete : une question r\u00e9elle qu'un lecteur taperait sur Google, en lien avec les extraits fournis.",
    "- aio.apercu : la r\u00e9ponse que produirait un AI Overview \u00e0 cette question, en trois phrases.",
    "- aio.citationRaison et llm.raison : une phrase chacune, appuy\u00e9e sur les mesures fournies.",
    "- explications : exactement autant d'entr\u00e9es que de crit\u00e8res fournis, dans le M\u00caME ORDRE. Pour chacune, pourquoi ce crit\u00e8re compte pour la citation (une phrase) et l'action \u00e0 mener (une phrase op\u00e9rationnelle).",
    "- recos : exactement 6 actions, de la plus prioritaire \u00e0 la moins prioritaire, d\u00e9duites des crit\u00e8res les plus faibles.",
  ].join("\n");

  // --- Mesures reelles : robots.txt et pages du site, en parallele ---
  const [robots, site] = await Promise.all([readRobots(url), lireSite(origin)]);

  // Domaine inexistant : le DNS ne resout pas.
  if (robots.joignable === false && !site.dispo) {
    return {
      statusCode: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "Ce domaine est introuvable. Verifiez l'adresse saisie." }),
    };
  }

  // Domaine reellement atteint (il peut differer en cas de redirection)
  let hostFinal = host;
  try { if (site.originFinal) hostFinal = new URL(site.originFinal).hostname; } catch (e) {}
  const redirige = hostFinal.replace(/^www\./i, "") !== host.replace(/^www\./i, "");

  let robotsBrief;
  if (!robots.dispo) {
    robotsBrief = "Acces des robots IA : non verifiable (" + (robots.raison || "inconnu") + "). N'affirme rien sur ce point.";
  } else if (robots.nbBloques === 0) {
    robotsBrief = "Acces des robots IA (verifie dans le robots.txt) : aucun des " + robots.nbTotal +
      " robots IA courants n'est bloque, l'acces est ouvert.";
  } else {
    robotsBrief = "Acces des robots IA (verifie dans le robots.txt) : " + robots.nbBloques + " robots sur " +
      robots.nbTotal + " sont bloques, a savoir " + robots.listeBloques.join(", ") +
      ". Ce blocage est tres probablement volontaire (strategie de droits voisins), donc traite-le comme une decision a arbitrer, jamais comme une erreur.";
  }

  // Scores calcules par le code, jamais par le modele
  const calcAIO = site.dispo ? scoreAIO(site) : null;
  const calcLLM = site.dispo ? scoreLLM(site, robots) : null;

  // Criteres consolides. On ne fait expliquer que les points perfectibles,
  // dedupliques, classes par nombre de points perdus, et limites a 6.
  const tous = [];
  if (calcAIO) calcAIO.detail.forEach(function (d) {
    tous.push({ nom: d.critere, perimetre: "Google AI Overview", etat: etatCritere(d.obtenu, d.max),
                constat: d.constat, obtenu: d.obtenu, max: d.max });
  });
  if (calcLLM) calcLLM.detail.forEach(function (d) {
    tous.push({ nom: d.critere, perimetre: "Assistants IA", etat: etatCritere(d.obtenu, d.max),
                constat: d.constat, obtenu: d.obtenu, max: d.max });
  });

  // un critere present dans les deux grilles concerne les deux environnements
  const compte = {};
  tous.forEach(function (c) { const k = c.nom.toLowerCase(); compte[k] = (compte[k] || 0) + 1; });

  const vus = {};
  const criteres = tous
    .filter(function (c) {
      if (c.etat === "fort") return false;
      const cle = c.nom.toLowerCase();
      if (vus[cle]) return false;
      vus[cle] = true;
      if (compte[cle] > 1) c.perimetre = "Les deux";
      return true;
    })
    .sort(function (a, b) { return (b.max - b.obtenu) - (a.max - a.obtenu); })
    .slice(0, 6);

  const listeCriteres = criteres.map(function (c, i) {
    return (i + 1) + ". " + c.nom + " (" + c.perimetre + ") : " + c.constat +
           " [" + c.obtenu + " points sur " + c.max + ", niveau " + c.etat + "]";
  }).join(" ");

  const extraits = (site.dispo && site.extraits && site.extraits.length)
    ? " EXTRAITS REELS de vos articles, a utiliser pour comprendre le sujet traite : " +
      site.extraits.map(function (e, i) { return "Article " + (i + 1) + " : " + e; }).join(" ")
    : "";

  const scoresBrief = calcAIO
    ? "SCORES CALCULES, a reprendre tels quels : Google AI Overview " + calcAIO.score + " sur 100, " +
      "Assistants IA " + calcLLM.score + " sur 100. "
    : "Les pages du site n'ont pas pu etre lues, aucun score n'a pu etre calcule. Reste tres prudent. ";

  const userMsg =
    "Site analyse : " + (redirige ? ("https://" + hostFinal + " (le domaine saisi " + host + " redirige vers celui-ci)") : url) + ". " +
    (theme ? "Thematique principale : " + theme + ". " : "") +
    scoresBrief +
    (criteres.length ? ("CRITERES MESURES, dans l'ordre, a expliquer un par un : " + listeCriteres + " ") : "") +
    robotsBrief + " " +
    extraits +
    " Redige uniquement les explications et les recommandations demandees, en francais accentue.";

  try {
    const endpoint =
      "https://generativelanguage.googleapis.com/v1beta/models/" + MODEL + ":generateContent";

    // Trois tentatives, de la plus riche a la plus sure :
    //  1. ancrage web active (le modele lit reellement le site)  -> necessite la facturation
    //  2. schema strict (format garanti, mais sans lecture du site)
    //  3. appel simple (dernier recours)
    // Gemini n'accepte pas l'ancrage et le schema simultanement, d'ou la cascade.
    async function callGemini(mode) {
      const gen = { temperature: 0.6, maxOutputTokens: 3000 };
      const payload = {
        system_instruction: { parts: [{ text: sys }] },
        contents: [{ role: "user", parts: [{ text: userMsg }] }],
        generationConfig: gen,
      };
      if (mode === "ancre") {
        payload.tools = [{ google_search: {} }];
      } else if (mode === "schema") {
        gen.responseMimeType = "application/json";
        gen.responseSchema = SCHEMA;
      }
      return fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": process.env.GEMINI_API_KEY,
        },
        body: JSON.stringify(payload),
      });
    }

    // Un seul appel au modele. L'ancrage web n'est plus necessaire puisque nous
    // transmettons de vrais extraits des pages, et il consommait trop de temps
    // d'execution (Netlify coupe la fonction au-dela de sa limite).
    // GEMINI_MODE = "ancre" permet de le reactiver si besoin.
    const mode = MODE_RETENU || "schema";
    let resp = await callGemini(mode);
    if (!resp.ok && mode !== "simple") resp = await callGemini("simple");

    const json = await resp.json();

    if (!resp.ok) {
      const detail = json && json.error && json.error.message ? json.error.message : "HTTP " + resp.status;
      return {
        statusCode: 502,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "Erreur Gemini : " + detail }),
      };
    }

    const parts =
      (json.candidates && json.candidates[0] && json.candidates[0].content &&
        json.candidates[0].content.parts) || [];
    const text = parts.map(function (p) { return p.text || ""; }).join("\n").trim();

    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) {
      return {
        statusCode: 502,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "R\u00e9ponse illisible. D\u00e9but : " + text.slice(0, 160) }),
      };
    }

    const brut = JSON.parse(text.slice(start, end + 1));
    const resultat = assembler(brut, calcAIO, calcLLM, criteres, robots, site, hostFinal, redirige, mode);

    // La note d'acces des robots reste factuelle, elle n'est pas redigee par le modele.
    if (resultat.llm) {
      resultat.llm.acces.note = robots && robots.dispo
        ? (robots.nbBloques === 0
            ? "Aucun robot IA n'est bloque dans votre fichier robots.txt."
            : robots.nbBloques + " robot(s) IA sur " + robots.nbTotal + " sont bloques : " +
              robots.listeBloques.join(", ") + ". Un blocage volontaire releve d'un arbitrage de droits voisins avant d'etre un sujet technique.")
        : "Votre fichier robots.txt n'a pas pu etre lu, l'acces des robots IA n'est pas verifiable.";
    }

    return {
      statusCode: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(resultat),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "Exception : " + (e && e.message ? e.message : String(e)) }),
    };
  }
};
