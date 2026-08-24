// ============================================================
//  Readr / Diagnostic de visibilité IA pour les médias
//  Fonction d'analyse.
//
//  Principe : le code mesure et calcule, les textes sont pré-écrits.
//  Aucune phrase du rapport n'est produite par un modèle génératif,
//  à l'exception des trois réécritures, qui sont facultatives et
//  contrôlées (aucun nombre absent des pages du média n'est accepté).
// ============================================================

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

// Deux identites. Certains sites de presse refusent un agent inconnu :
// on retente alors avec une identite de navigateur classique.
const UA_READR = {
  "user-agent": "ReadrDiagnostic/1.0 (+https://www.readr.agency)",
  "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "fr-FR,fr;q=0.9",
};
const UA_NAVIGATEUR = {
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "fr-FR,fr;q=0.9",
};

// Journal des echecs, remonte au rapport pour rendre toute panne explicable.
const JOURNAL = [];

async function tenter(u, ms, entetes) {
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, ms);
  try {
    const r = await fetch(u, { signal: ctrl.signal, redirect: "follow", headers: entetes });
    clearTimeout(timer);
    if (!r.ok) return { ok: false, motif: "HTTP " + r.status };
    const ct = r.headers.get("content-type") || "";
    if (ct && ct.indexOf("html") === -1) return { ok: false, motif: "type " + ct.split(";")[0] };
    const brut = await r.text();
    // On conserve le debut et la fin : le pied de page porte les liens utiles.
    const txt = brut.length > 900000 ? brut.slice(0, 600000) + " " + brut.slice(-300000) : brut;
    return { ok: true, html: txt, urlFinale: r.url || u, xRobots: r.headers.get("x-robots-tag") || "" };
  } catch (e) {
    clearTimeout(timer);
    const code = (e && e.cause && e.cause.code) || (e.name === "AbortError" ? "delai depasse" : "erreur reseau");
    return { ok: false, motif: code };
  }
}

async function getHTML(u, ms) {
  const delai = ms || 6000;
  let r = await tenter(u, delai, UA_READR);
  if (!r.ok && r.motif !== "delai depasse") {
    // Un refus peut venir de l'agent declare : seconde tentative en navigateur.
    r = await tenter(u, delai, UA_NAVIGATEUR);
  }
  if (!r.ok) {
    if (JOURNAL.length < 6) JOURNAL.push(u.replace(/^https?:\/\//, "").slice(0, 60) + " : " + r.motif);
    return null;
  }
  return { html: r.html, urlFinale: r.urlFinale, xRobots: r.xRobots };
}

// Retire scripts, styles et balises pour obtenir le texte visible.
const ENTITES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  eacute: "é", egrave: "è", ecirc: "ê", agrave: "à", ccedil: "ç",
  ugrave: "ù", ocirc: "ô", icirc: "î", iuml: "ï", ntilde: "ñ",
  laquo: "«", raquo: "»", hellip: "...", rsquo: "'", lsquo: "'",
  ldquo: '"', rdquo: '"', ndash: ", ", mdash: ", ", euro: "€", deg: "°",
};

// Decode les entites HTML, nommees comme numeriques.
// Sans cela, une apostrophe ecrite &#039; s'affichait telle quelle dans le rapport.
function decodeEntites(t) {
  return t
    .replace(/&#(\d+);/g, function (_, n) {
      const code = parseInt(n, 10);
      return (code > 0 && code < 1114112) ? String.fromCodePoint(code) : " ";
    })
    .replace(/&#x([0-9a-f]+);/gi, function (_, h) {
      const code = parseInt(h, 16);
      return (code > 0 && code < 1114112) ? String.fromCodePoint(code) : " ";
    })
    .replace(/&([a-z]+);/gi, function (m, nom) {
      const v = ENTITES[nom.toLowerCase()];
      return v !== undefined ? v : " ";
    });
}

function texteVisible(html) {
  return decodeEntites(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ").trim();
}


// --------- Isolement du corps de l'article ---------
// Les menus, entetes et pieds de page faussent toutes les mesures : sur un grand
// quotidien, la navigation represente plusieurs centaines de mots et des dizaines
// de listes. On mesure donc uniquement le corps redactionnel.
function corpsArticle(html) {
  if (!html) return { corps: "", source: "vide" };

  const sansBruit = function (t) {
    return t
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
      .replace(/<header[\s\S]*?<\/header>/gi, " ")
      .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
      .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
      .replace(/<form[\s\S]*?<\/form>/gi, " ");
  };

  // 1. La balise <article> la plus fournie
  const articles = html.match(/<article[\s\S]*?<\/article>/gi) || [];
  if (articles.length) {
    const meilleur = articles.sort(function (a, b) { return b.length - a.length; })[0];
    if (texteVisible(meilleur).split(/\s+/).length >= 80) {
      return { corps: sansBruit(meilleur), source: "article" };
    }
  }

  // 2. Un conteneur de corps de texte identifie par sa classe
  const conteneurs = html.match(/<div[^>]+(class|id)=["'][^"']*(article-body|articleBody|post-content|entry-content|contenu-article|article__content|story-body|texte-article)[^"']*["'][\s\S]*?<\/div>/gi) || [];
  if (conteneurs.length) {
    const meilleur = conteneurs.sort(function (a, b) { return b.length - a.length; })[0];
    if (texteVisible(meilleur).split(/\s+/).length >= 80) {
      return { corps: sansBruit(meilleur), source: "conteneur" };
    }
  }

  // 3. La balise <main>
  const main = html.match(/<main[\s\S]*?<\/main>/i);
  if (main && texteVisible(main[0]).split(/\s+/).length >= 80) {
    return { corps: sansBruit(main[0]), source: "main" };
  }

  // 4. A defaut, le document expurge de sa navigation
  return { corps: sansBruit(html), source: "page entiere" };
}

// Cherche des liens d'articles plausibles sur la page d'accueil.
function trouverArticles(html, origin) {
  // Le mot exclu doit constituer un SEGMENT ENTIER du chemin.
  // Sans cela, un article intitule "auteur-mystere-revele" etait ecarte a tort.
  // "rubrique" n'est volontairement pas exclu : sur de nombreux sites de presse
  // francais, /rubrique/ est le prefixe des articles eux-memes.
  const exclus = /\/(tag|tags|category|categories|categorie|auteur|auteurs|author|authors|page|abonnement|abonnez|newsletter|newsletters|contact|mentions|cgv|cgu|privacy|cookies|login|connexion|compte|recherche|search|rss|feed|sitemap|plan-du-site)(\/|$|\?)/i;
  const forts = [];   // chemins qui ressemblent nettement a un article
  const faibles = []; // candidats de repli

  const re = /<a\s[^>]*href=["']([^"'#]+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null && (forts.length + faibles.length) < 300) {
    let href = m[1];
    if (!href || href.indexOf("mailto:") === 0 || href.indexOf("javascript:") === 0) continue;
    let abs;
    try { abs = new URL(href, origin).href; } catch (e) { continue; }
    if (abs.indexOf(origin) !== 0) continue;
    if (exclus.test(abs)) continue;
    if (/\.(jpg|jpeg|png|gif|svg|webp|pdf|zip|mp3|mp4|xml|json|css|js)(\?|$)/i.test(abs)) continue;

    const chemin = abs.slice(origin.length).split("?")[0];
    const segments = chemin.split("/").filter(Boolean);
    if (!segments.length) continue;
    const dernier = segments[segments.length - 1];

    // Signature nette d'un article : slug avec tirets, ou identifiant numerique, ou date dans l'URL
    const slug = dernier.indexOf("-") !== -1 && dernier.length >= 10;
    const identifiant = /\d{4,}/.test(dernier);
    const date = /\/(19|20)\d{2}\//.test(chemin);

    if ((slug || identifiant || date) && chemin.length >= 10) {
      if (forts.indexOf(abs) === -1) forts.push(abs);
    } else if (segments.length >= 2 && chemin.length >= 8) {
      if (faibles.indexOf(abs) === -1) faibles.push(abs);
    }
  }

  // On privilegie les candidats nets, puis on complete avec les replis.
  // On demande plus de candidats que necessaire : les pages lourdes ou protegees
  // echouent souvent, et les requetes etant paralleles, le surcout de temps est nul.
  return forts.concat(faibles).slice(0, 12);
}

// Analyse une page article et en extrait les signaux mesurables.
// Une page de rubrique ou d'accueil fausse toutes les mesures : on l'ecarte.
// Un article se reconnait a son balisage, ou a defaut a sa densite redactionnelle.
function estUnArticle(m) {
  // Un article payant reste un article : son balisage, sa signature, ses dates et
  // sa structure sont mesurables sur l'extrait visible. On ne l'ecarte que si la
  // page ne contient reellement aucun texte exploitable.
  if (m.mots < 60) return false;

  // Le balisage reste le signal le plus sur.
  if (m.schemaArticle) return true;

  // Sans balisage, il faut des marqueurs propres a un article et non a une rubrique :
  // une page de rubrique aligne des chapeaux courts, sans date ni signature,
  // et multiplie les intertitres qui sont en realite des titres d'articles.
  const assezDeTexte = m.mots >= 250 && m.parasUtiles >= 5;
  const marqueurArticle = m.dateVisible || m.auteurVisible;
  const parasSubstantiels = m.paraMoyen >= 18;
  const pasUneListeDeTitres = m.titresTotal <= Math.max(6, m.parasUtiles / 2);

  return assezDeTexte && marqueurArticle && parasSubstantiels && pasUneListeDeTitres;
}

function analyserPage(htmlComplet) {
  // Le balisage se lit sur le document entier (il est dans l'entete),
  // le contenu editorial uniquement sur le corps de l'article.
  const extrait = corpsArticle(htmlComplet);
  const html = htmlComplet;
  const corps = extrait.corps;
  const res = {
    schemaArticle: false, schemaAuteur: false, schemaDatePub: false, schemaDateMaj: false,
    auteurVisible: false, dateVisible: false,
    h1: 0, h2: 0, paragraphes: 0, mots: 0, chiffres: 0,
    listes: 0, tableaux: 0, schemaFAQ: false, titresTotal: 0, titresQuestion: 0,
    parasUtiles: 0, paraMoyen: 0, ouvertureDirecte: false, ouverture: "", ouvertureMots: 0,
    ouvertureChiffre: false, ouvertureRenvoi: false, passage: "", passageNote: 0,
    sourceCorps: "", coquille: false, mur: false, dateMajVisible: false,
    schemaNews: false, pageAuteur: false, genreDeclare: false, citations: 0, sourcesPrimaires: 0,
    schemaAuteurTexte: false, noindex: false, nosnippet: false, maxSnippet: null, paywall: false,
    h1Unique: false, sautNiveau: false, sameAs: false, breadcrumb: false,
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
        // Un auteur declare comme objet est exploitable, une simple chaine l'est moins.
        if (it.author && typeof it.author === "object") res.schemaAuteur = true;
        else if (it.author) res.schemaAuteurTexte = true;
        if (it.datePublished) res.schemaDatePub = true;
        if (it.dateModified) res.schemaDateMaj = true;
      }
    });
  });

  if (/property=["']article:published_time["']/i.test(html)) res.dateVisible = true;
  // Le Monde et beaucoup de titres affichent "modifie a 09h32" sans balisage dedie :
  // on accepte le meta, le JSON-LD, la balise time et la mention visible.
  if (/property=["']article:modified_time["']/i.test(html)) res.schemaDateMaj = true;
  if (/name=["'](last-?modified|date-?modified|revised)["']/i.test(html)) res.schemaDateMaj = true;
  if (/<time[^>]+(datetime|itemprop=["']dateModified["'])[^>]*>/i.test(html)
      && /(modifi|mis\s+\u00e0\s+jour|updated)/i.test(decodeEntites(html))) res.schemaDateMaj = true;
  if (/modifi[e\u00e9]e?\s*(le|\u00e0|a)?\s*\d/i.test(decodeEntites(html))
      || /mis\s+\u00e0\s+jour/i.test(decodeEntites(html))) res.dateMajVisible = true;
  if (/name=["']author["']/i.test(html) || /rel=["']author["']/i.test(html)) res.auteurVisible = true;
  if (/<time[\s>]/i.test(html)) res.dateVisible = true;
  if (/class=["'][^"']*(author|auteur|signature|byline)[^"']*["']/i.test(html)) res.auteurVisible = true;

  res.h1 = (html.match(/<h1[\s>]/gi) || []).length;
  res.h2 = (corps.match(/<h2[\s>]/gi) || []).length;
  res.paragraphes = (corps.match(/<p[\s>]/gi) || []).length;

  // --- Signaux propres au metier de la presse ---
  // Ces elements ne sont pas regardes par les outils GEO generiques, alors qu'ils
  // determinent la reprise des contenus d'actualite.

  // Le balisage NewsArticle est celui attendu pour la presse : Article seul est plus faible.
  res.schemaNews = /"@type"\s*:\s*("NewsArticle"|\[[^\]]*"NewsArticle")/i.test(html);

  // Signature reliee a une page auteur : c'est ce qui construit l'autorite journalistique.
  // Une page qui recense les articles d'un journaliste suffit : la biographie n'est pas exigee.
  res.pageAuteur = /<a[^>]+href=["'][^"']*\/(auteur|auteurs|author|authors|journaliste|journalistes|signataire|signataires|redaction|contributeur)\//i.test(html)
                || /"author"\s*:\s*\{[^}]*"url"\s*:/i.test(html);

  // Type d'article declare : reportage, enquete, analyse. Un signal d'expertise editoriale.
  res.genreDeclare = /"articleSection"\s*:|"genre"\s*:|"@type"\s*:\s*"(ReportageNewsArticle|AnalysisNewsArticle|OpinionNewsArticle|BackgroundNewsArticle)"/i.test(html);

  // Citations sourcees : verbatim entre guillemets, marqueur du travail journalistique
  // et matiere premiere reprise par les moteurs.
  // Les guillemets francais sont souvent encodes en &laquo; : il faut decoder avant de chercher.
  const texteCit = decodeEntites(corps);
  res.citations = (corps.match(/<(blockquote|q)[\s>]/gi) || []).length
                + ((texteCit.match(/«[^»]{25,400}»/g) || []).length);

  // Liens vers des sources primaires (institutions, etudes, textes officiels)
  const liensSortants = (corps.match(/<a\s[^>]*href=["']https?:\/\/[^"']+["']/gi) || []);
  res.sourcesPrimaires = liensSortants.filter(function (l) {
    return /\.(gouv\.fr|europa\.eu|who\.int|oecd\.org|insee\.fr|banque-france\.fr|legifrance\.gouv\.fr|ademe\.fr|senat\.fr|assemblee-nationale\.fr)|\/(etude|rapport|communique)/i.test(l);
  }).length;

  // --- Bloqueurs d'extraction : ils empechent la citation quel que soit le contenu ---

  // Directives robots au niveau de la page
  const metaRobots = (html.match(/<meta[^>]+name=["']robots["'][^>]*>/gi) || []).join(" ").toLowerCase();
  res.noindex = /noindex/.test(metaRobots);
  res.nosnippet = /nosnippet/.test(metaRobots) || /data-nosnippet/i.test(html);
  const mx = metaRobots.match(/max-snippet\s*:\s*(-?\d+)/);
  res.maxSnippet = mx ? parseInt(mx[1], 10) : null;   // -1 = illimite, 0 = aucun extrait

  // Mur d'inscription ou d'abonnement : le corps de l'article n'est pas servi.
  // Le noter comme un contenu faible serait faux : nous n'avons rien pu lire.
  const texteMur = decodeEntites(corps).slice(0, 4000);
  res.mur = /(cr[e\u00e9]ez\s+(un\s+)?compte|inscrivez-vous\s+pour|connectez-vous\s+pour|r[e\u00e9]serv[e\u00e9]\s+aux\s+abonn|poursuivre\s+votre\s+lecture|lire\s+la\s+suite\s+de\s+cet\s+article|d[e\u00e9]j[a\u00e0]\s+abonn[e\u00e9]|acc[e\u00e9]dez\s+[a\u00e0]\s+la\s+totalit|subscribe\s+to\s+(continue|read)|already\s+a\s+subscriber|sign\s+in\s+to\s+read|create\s+an\s+account\s+to)/i.test(texteMur);

  // Paywall declare dans les donnees structurees ou marqueurs courants
  res.paywall = /"isAccessibleForFree"\s*:\s*(false|"false")/i.test(html)
             || /class=["'][^"']*(paywall|premium-wall|article-locked|subscription-wall)[^"']*["']/i.test(html);

  // Hierarchie des titres
  const niveaux = (html.match(/<h([1-6])[\s>]/gi) || []).map(function (t) { return parseInt(t.replace(/\D/g, ""), 10); });
  res.h1Unique = (html.match(/<h1[\s>]/gi) || []).length === 1;
  res.sautNiveau = false;
  for (let i = 1; i < niveaux.length; i++) {
    if (niveaux[i] - niveaux[i - 1] > 1) { res.sautNiveau = true; break; }
  }

  // Liage d'entite et navigation
  res.sameAs = /"sameAs"\s*:/i.test(html);
  res.breadcrumb = /"@type"\s*:\s*"BreadcrumbList"/i.test(html);

  // --- Signaux d'extractibilite : ce qui permet a un AI Overview de reprendre un passage ---

  // Listes et tableaux : formats que les moteurs reprennent en priorite
  res.listes = (corps.match(/<ul[\s>]/gi) || []).length + (corps.match(/<ol[\s>]/gi) || []).length;
  res.tableaux = (corps.match(/<table[\s>]/gi) || []).length;

  // Balisage FAQ ou HowTo : concu pour la reponse directe
  res.schemaFAQ = /"@type"\s*:\s*"(FAQPage|HowTo|QAPage)"/i.test(html);

  // Sous-titres formules en question : structure question/reponse
  const titres = (corps.match(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi) || [])
    .map(function (t) { return texteVisible(t); })
    .filter(function (t) { return t.length > 3; });
  res.titresTotal = titres.length;
  res.titresQuestion = titres.filter(function (t) { return t.indexOf("?") !== -1; }).length;

  // Paragraphes : longueur et extractibilite
  const paras = (corps.match(/<p[^>]*>([\s\S]*?)<\/p>/gi) || [])
    .map(function (t) { return texteVisible(t); })
    .filter(function (t) { return t.split(/\s+/).length >= 8; });

  res.parasUtiles = paras.length;
  if (paras.length) {
    const longueurs = paras.map(function (t) { return t.split(/\s+/).length; });
    res.paraMoyen = Math.round(longueurs.reduce(function (a, b) { return a + b; }, 0) / longueurs.length);

    // Paragraphe d'ouverture : c'est lui qui sert de reponse directe, ou non.
    const premier = paras[0];
    const motsPremier = premier.split(/\s+/).length;
    res.ouverture = premier.slice(0, 400);
    res.ouvertureMots = motsPremier;
    res.ouvertureChiffre = /\d/.test(premier);
    res.ouvertureRenvoi = /^(mais|or|donc|ainsi|pourtant|cependant|il|elle|ils|elles|ce|cet|cette|cela|celui|celle|c'est|y|en)\b/i.test(premier.trim());
    res.ouvertureDirecte = motsPremier <= 60 && res.ouvertureChiffre && !res.ouvertureRenvoi;

    // Meilleur passage extractible : autonome, calibre, avec une donnee
    const candidats = paras
      .map(function (t) {
        const mots = t.split(/\s+/).length;
        const virgules = (t.match(/,/g) || []).length;
        const points = (t.match(/[.!?]/g) || []).length;

        // Un passage citable est une phrase, pas une enumeration ni une liste de credits.
        const enumeration = virgules > Math.max(3, mots / 6) && points <= 1;
        const phrase = /[.!?]["'»]?\s*$/.test(t.trim());
        if (!/\d/.test(t) || enumeration || !phrase) return { texte: t, note: 0, mots: mots };

        let note = 2;                                   // contient une donnee
        if (mots >= 25 && mots <= 70) note += 3;
        else if (mots >= 18 && mots <= 90) note += 1;
        if (/\d+\s?(%|euros?|millions?|milliards?|ans?)/i.test(t)) note += 1;
        if (!/^(mais|or|donc|ainsi|pourtant|cependant|il|elle|ils|elles|ce|cette|cela|celui)\b/i.test(t)) note += 1;
        return { texte: t, note: note, mots: mots };
      })
      .sort(function (a, b) { return b.note - a.note; });

    if (candidats.length && candidats[0].note >= 5) {
      res.passage = candidats[0].texte.slice(0, 400);
      res.passageNote = candidats[0].note;
    }
  }

  const texte = texteVisible(corps);
  res.mots = texte ? texte.split(/\s+/).length : 0;
  res.sourceCorps = extrait.source;
  // Corps introuvable et texte residuel faible : le contenu est charge par le navigateur.
  res.coquille = (res.mots < 80);
  // Une seule expression, pour ne pas compter deux fois un pourcentage.
  res.chiffres = (texte.match(/\b\d[\d\s.,]*\s*(%|euros?|EUR|€|millions?|milliards?|ans?|km|kg|heures?|jours?|mois)\b/gi) || []).length;

  return res;
}

// Convertit un comptage en niveau, a la majorite.
function niveau(compte, total) {
  if (!total) return "absent";
  const part = compte / total;
  if (part >= 0.7) return "present";
  if (part >= 0.25) return "partiel";
  return "absent";
}

async function lireSite(origin, urlsSecours) {
  const rep = await getHTML(origin, 5000);

  // Accueil inaccessible : on se rabat sur les adresses du plan de site.
  if (!rep) {
    if (!urlsSecours || !urlsSecours.length) {
      return { dispo: false, raison: "page d'accueil illisible" };
    }
  }

  const accueil = rep ? rep.html : "";
  let originFinal = origin;
  if (rep) { try { originFinal = new URL(rep.urlFinale).origin; } catch (e) {} }

  let urls = rep ? trouverArticles(accueil, originFinal) : [];
  if (!urls.length && urlsSecours && urlsSecours.length) urls = urlsSecours.slice(0, 12);
  // En parallele : douze pages coutent le meme temps qu'une seule.
  const reps = await Promise.all(urls.map(function (u) { return getHTML(u, 4000); }));

  let atteintes = 0, murs = 0, coquilles = 0;
  const candidates = [];
  reps.forEach(function (h, i) {
    if (!h) return;
    atteintes++;
    const mes = analyserPage(h.html);
    if (mes.mur && mes.mots < 400) murs++;
    if (mes.coquille) coquilles++;
    if (!estUnArticle(mes)) return;                  // rubrique, accueil, page de service
    candidates.push({ url: urls[i], mesures: mes, extrait: texteVisible(h.html).slice(0, 450) });
  });

  // On privilegie les pages balisees, puis les plus fournies, et on en garde cinq.
  candidates.sort(function (a, b) {
    if (a.mesures.schemaArticle !== b.mesures.schemaArticle) return a.mesures.schemaArticle ? -1 : 1;
    return b.mesures.mots - a.mesures.mots;
  });
  const pages = candidates.slice(0, 5);
  const pagesMurees = pages.filter(function (x) { return x.mesures.mur; }).length;

  if (!pages.length) {
    let motif = "aucune page article identifiee";
    if (!atteintes) motif = "pages inaccessibles";
    else if (murs >= Math.max(1, Math.round(atteintes / 2))) motif = "contenu reserve";
    else if (coquilles >= Math.max(1, Math.round(atteintes / 2))) motif = "contenu charge par le navigateur";
    return {
      dispo: false,
      raison: motif,
      nbMurs: murs,
      nbCoquilles: coquilles,
      nbPages: 0, nbTentees: urls.length, nbAtteintes: atteintes, originFinal: originFinal,
    };
  }

  // Les signaux d'audience propre se trouvent surtout dans l'entete et le pied de page.
  // Entete et pied de page figurent aussi sur les articles : sans accueil, on les y lit.
  const pourAudience = (accueil ? accueil + " " : "")
    + reps.filter(function (x) { return x; }).slice(0, 2).map(function (x) { return x.html; }).join(" ");
  const audience = analyserAudience(pourAudience);

  const n = pages.length;
  const agg = pages.reduce(function (a, p) {
    const m = p.mesures;
    a.schemaArticle += m.schemaArticle ? 1 : 0;
    a.schemaAuteur += m.schemaAuteur ? 1 : 0;
    a.schemaDatePub += m.schemaDatePub ? 1 : 0;
    a.schemaDateMaj += m.schemaDateMaj ? 1 : 0;
    a.dateMajVisible += m.dateMajVisible ? 1 : 0;
    a.auteurVisible += m.auteurVisible ? 1 : 0;
    a.dateVisible += m.dateVisible ? 1 : 0;
    a.mots += m.mots; a.chiffres += m.chiffres; a.h2 += m.h2; a.paragraphes += m.paragraphes;
    a.listes += m.listes; a.tableaux += m.tableaux;
    a.schemaFAQ += m.schemaFAQ ? 1 : 0;
    a.titresTotal += m.titresTotal; a.titresQuestion += m.titresQuestion;
    a.ouvertureDirecte += m.ouvertureDirecte ? 1 : 0;
    a.noindex += m.noindex ? 1 : 0;
    a.nosnippet += m.nosnippet ? 1 : 0;
    a.snippetZero += (m.maxSnippet !== null && m.maxSnippet === 0) ? 1 : 0;
    a.paywall += m.paywall ? 1 : 0;
    a.h1Unique += m.h1Unique ? 1 : 0;
    a.sautNiveau += m.sautNiveau ? 1 : 0;
    a.sameAs += m.sameAs ? 1 : 0;
    a.breadcrumb += m.breadcrumb ? 1 : 0;
    a.auteurTexte += m.schemaAuteurTexte ? 1 : 0;
    a.schemaNews += m.schemaNews ? 1 : 0;
    a.pageAuteur += m.pageAuteur ? 1 : 0;
    a.genreDeclare += m.genreDeclare ? 1 : 0;
    a.citations += m.citations;
    a.sourcesPrimaires += m.sourcesPrimaires;
    if (m.paraMoyen) { a.paraSomme += m.paraMoyen; a.paraCount += 1; }
    if (m.passageNote > a.meilleureNote) { a.meilleureNote = m.passageNote; a.passage = m.passage; }
    if (!a.ouverture && m.ouverture) {
      a.ouverture = m.ouverture; a.ouvertureMots = m.ouvertureMots;
      a.ouvertureChiffre = m.ouvertureChiffre; a.ouvertureRenvoi = m.ouvertureRenvoi;
    }
    return a;
  }, { schemaArticle:0, schemaAuteur:0, schemaDatePub:0, schemaDateMaj:0, auteurVisible:0,
       dateVisible:0, dateMajVisible:0, mots:0, chiffres:0, h2:0, paragraphes:0,
       listes:0, tableaux:0, schemaFAQ:0, titresTotal:0, titresQuestion:0,
       ouvertureDirecte:0, paraSomme:0, paraCount:0, meilleureNote:0, passage:"",
       noindex:0, nosnippet:0, snippetZero:0, paywall:0, h1Unique:0, sautNiveau:0,
       sameAs:0, breadcrumb:0, auteurTexte:0,
       ouverture:"", ouvertureMots:0, ouvertureChiffre:false, ouvertureRenvoi:false,
       schemaNews:0, pageAuteur:0, genreDeclare:0, citations:0, sourcesPrimaires:0 });

  return {
    dispo: true,
    nbPages: n,
    nbTentees: urls.length,
    viaPlanDeSite: !rep,
    nbAtteintes: atteintes,
    nbBalisees: pages.filter(function (x) { return x.mesures.schemaArticle; }).length,
    nbMurees: pagesMurees,
    contenuPartiel: pagesMurees >= Math.max(1, Math.round(pages.length / 2)),
    originFinal: originFinal,
    urls: pages.map(function (p) { return p.url; }),
    extraits: pages.map(function (p) { return p.extrait; }),
    // Seuils a la majorite : une seule page atypique parmi les cinq analysees
    // ne doit pas faire chuter un site correctement configure.
    balisageArticle: niveau(agg.schemaArticle, n),
    auteurBalise: niveau(agg.schemaAuteur, n),
    datePubliee: (agg.schemaDatePub > 0 || agg.dateVisible > 0) ? "present" : "absent",
    dateMaj: agg.schemaDateMaj > 0 ? "present" : (agg.dateMajVisible > 0 ? "partiel" : "absent"),
    auteurAffiche: agg.auteurVisible > 0 ? "present" : "absent",
    motsMoyen: Math.round(agg.mots / n),
    chiffresMoyen: Math.round((agg.chiffres / n) * 10) / 10,
    sousTitresMoyen: Math.round(agg.h2 / n),

    // Signaux d'extractibilite, propres a l'AI Overview
    listesMoyen: Math.round(((agg.listes + agg.tableaux) / n) * 10) / 10,
    balisageFAQ: agg.schemaFAQ > 0 ? "present" : "absent",
    partQuestions: agg.titresTotal ? Math.round((agg.titresQuestion / agg.titresTotal) * 100) : 0,
    paraMoyen: agg.paraCount ? Math.round(agg.paraSomme / agg.paraCount) : 0,
    ouverturesDirectes: agg.ouvertureDirecte,
    passage: agg.passage || "",
    ouverture: agg.ouverture || "",
    ouvertureMots: agg.ouvertureMots,
    ouvertureChiffre: agg.ouvertureChiffre,
    ouvertureRenvoi: agg.ouvertureRenvoi,

    // Bloqueurs et hygiene technique
    noindex: agg.noindex > 0,
    nosnippet: agg.nosnippet > 0 || agg.snippetZero > 0,
    paywall: agg.paywall > 0,
    partPaywall: Math.round((agg.paywall / n) * 100),
    hierarchieTitres: (agg.h1Unique >= n * 0.7 && agg.sautNiveau <= n * 0.3) ? "present"
                      : (agg.h1Unique > 0 ? "partiel" : "absent"),
    liageEntite: niveau(agg.sameAs, n),
    filAriane: niveau(agg.breadcrumb, n),
    auteurTexteSeul: agg.auteurTexte > 0,

    // Independance vis-a-vis des plateformes
    audience: audience,

    // Signaux propres a la presse
    balisageNews: niveau(agg.schemaNews, n),
    pageAuteur: niveau(agg.pageAuteur, n),
    genreDeclare: niveau(agg.genreDeclare, n),
    citationsMoyen: Math.round((agg.citations / n) * 10) / 10,
    sourcesMoyen: Math.round((agg.sourcesPrimaires / n) * 10) / 10,
  };
}





// --------- Plan de site : voie de secours quand l'accueil est inaccessible ---------
// Les protections anti-robots visent surtout la page d'accueil. Le plan de site
// reste souvent servi, et il liste les articles recents.

async function getXML(u, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, ms || 4000);
  try {
    const r = await fetch(u, { signal: ctrl.signal, redirect: "follow", headers: UA_NAVIGATEUR });
    clearTimeout(timer);
    if (!r.ok) return null;
    const t = await r.text();
    return t.slice(0, 400000);
  } catch (e) {
    clearTimeout(timer);
    return null;
  }
}

function urlsDuPlan(xml, origin) {
  if (!xml) return [];
  return (xml.match(/<loc>\s*([^<\s]+)\s*<\/loc>/gi) || [])
    .map(function (m) { return m.replace(/<\/?loc>/gi, "").trim(); })
    .filter(function (u) { return u.indexOf(origin) === 0; });
}

// Retient les adresses qui ressemblent a des articles, les plus recentes d'abord.
function articlesDeXml(xml, origin) {
  if (!xml) return [];
  if (/<sitemapindex/i.test(xml)) return [];   // index de plans : traite plus bas
  return urlsDuPlan(xml, origin)
    .filter(function (u) {
      const chemin = u.slice(origin.length);
      return chemin.length >= 12 && (/-/.test(chemin) || /\d{4,}/.test(chemin));
    })
    .slice(-12).reverse();
}

// Cherche les plans de site declares dans le robots.txt, puis les emplacements usuels.
async function articlesDuPlanDeSite(origin, robotsTxt) {
  const candidats = [];
  if (robotsTxt) {
    (robotsTxt.match(/^\s*sitemap\s*:\s*(\S+)/gim) || []).forEach(function (l) {
      const u = l.split(/:\s*/).slice(1).join(":").trim();
      if (u.indexOf(origin) === 0) candidats.push(u);
    });
  }
  ["/sitemap.xml", "/sitemap_index.xml", "/sitemap-index.xml", "/sitemap-news.xml"]
    .forEach(function (c) { if (candidats.indexOf(origin + c) === -1) candidats.push(origin + c); });

  for (let i = 0; i < Math.min(candidats.length, 2); i++) {
    const xml = await getXML(candidats[i], 3000);
    if (!xml) continue;
    let urls = urlsDuPlan(xml, origin);
    if (!urls.length) continue;

    // Si c'est un index de plans, on ouvre le plus recent.
    if (/<sitemapindex/i.test(xml)) {
      const sous = await getXML(urls[urls.length - 1], 3000);
      urls = urlsDuPlan(sous, origin);
    }
    // On garde les adresses qui ressemblent a des articles, les plus recentes d'abord.
    const articles = urls.filter(function (u) {
      const chemin = u.slice(origin.length);
      return chemin.length >= 12 && (/-/.test(chemin) || /\d{4,}/.test(chemin));
    });
    if (articles.length) return articles.slice(-12).reverse();
  }
  return [];
}

// --------- Mesure de l'independance vis-a-vis des plateformes ---------
// Ce que le media possede en propre : capture d'audience, compte, abonnement.
// C'est la seule reponse structurelle a la dependance aux moteurs.
function analyserAudience(html) {
  const r = {
    newsletter: false, formulaireEmail: false, compte: false, abonnement: false,
    appMobile: false, push: false, cmp: false, reseaux: 0,
  };
  if (!html) return r;

  // Capture newsletter : lien dedie ou formulaire email present
  r.newsletter = /href=["'][^"']*\/(newsletter|newsletters|infolettre)/i.test(html)
              || /(inscri\w+|abonn\w+)[^<]{0,40}newsletter/i.test(html);
  r.formulaireEmail = /<input[^>]+type=["']email["']/i.test(html)
                   || /<input[^>]+name=["'][^"']*(email|mail)[^"']*["']/i.test(html);

  // Espace compte : la connexion est le socle d'une relation identifiee
  r.compte = /href=["'][^"']*\/(login|connexion|se-connecter|mon-compte|moncompte|account|espace-client)/i.test(html)
          || /(se\s+connecter|mon\s+compte|s'identifier)/i.test(html);

  // Offre d'abonnement
  r.abonnement = /href=["'][^"']*\/(abonnement|abonnements|abonnez|offres|s-abonner|subscribe|premium)/i.test(html)
              || /(s'abonner|nos\s+offres|devenir\s+abonn)/i.test(html);

  // Application mobile
  // Liens de magasin, banniere native iOS/Android, ou lien alternate d'application.
  r.appMobile = /(apps\.apple\.com|itunes\.apple\.com|play\.google\.com\/store\/apps|market:\/\/details)/i.test(html)
             || /<meta[^>]+name=["'](apple-itunes-app|google-play-app)["']/i.test(html)
             || /<link[^>]+href=["'](android-app|ios-app):/i.test(html)
             || /href=["'][^"']*\/(application|applications|nos-applications|app-mobile)["'\/]/i.test(html);

  // Notifications push : canal direct, sans intermediaire
  r.push = /(onesignal|batch\.com|batchsdk|pushwoosh|serviceWorker[\s\S]{0,120}push|firebase-messaging)/i.test(html);

  // Plateforme de consentement : prerequis d'une collecte de donnees propres
  r.cmp = /(didomi|sirdata|onetrust|axeptio|tarteaucitron|sfbx|appconsent|quantcast|commandersact)/i.test(html);

  // Canaux non maitrises, pour mise en perspective
  r.reseaux = (html.match(/href=["'][^"']*(facebook\.com|twitter\.com|x\.com|instagram\.com|tiktok\.com|linkedin\.com|youtube\.com)/gi) || []).length;

  return r;
}

// --------- Lecture reelle du robots.txt ---------
// Les robots IA les plus courants. Libelle = ce qui s'affiche a l'ecran.
// usage "recuperation" : ces robots conditionnent directement la citation.
// usage "entrainement" : ils alimentent les modeles, sans effet direct sur la citation.
// Distinction importante : bloquer Google-Extended n'empeche pas l'AI Overview,
// qui s'appuie sur l'index Google classique.
const AI_BOTS = [
  { ua: "OAI-SearchBot",     label: "OAI-SearchBot",     org: "OpenAI, recherche",        usage: "recuperation" },
  { ua: "ChatGPT-User",      label: "ChatGPT-User",      org: "ChatGPT, navigation",      usage: "recuperation" },
  { ua: "PerplexityBot",     label: "PerplexityBot",     org: "Perplexity, index",        usage: "recuperation" },
  { ua: "Perplexity-User",   label: "Perplexity-User",   org: "Perplexity, navigation",   usage: "recuperation" },
  { ua: "Claude-SearchBot",  label: "Claude-SearchBot",  org: "Anthropic, recherche",     usage: "recuperation" },
  { ua: "Bingbot",           label: "Bingbot",           org: "Bing, alimente Copilot",   usage: "recuperation" },
  { ua: "GPTBot",            label: "GPTBot",            org: "OpenAI, entrainement",     usage: "entrainement" },
  { ua: "ClaudeBot",         label: "ClaudeBot",         org: "Anthropic, entrainement",  usage: "entrainement" },
  { ua: "Google-Extended",   label: "Google-Extended",   org: "Gemini, entrainement",     usage: "entrainement" },
  { ua: "CCBot",             label: "CCBot",             org: "Common Crawl",             usage: "entrainement" },
  { ua: "Applebot-Extended", label: "Applebot-Extended", org: "Apple, entrainement",      usage: "entrainement" },
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
  const cle = ua.toLowerCase();
  const explicite = Object.prototype.hasOwnProperty.call(groups, cle);
  const regles = explicite ? groups[cle] : groups["*"];
  if (!regles) return { etat: "autorise", restreint: false };

  const toutBloque = regles.disallow.some(function (d) { return d === "/"; });
  const toutAutorise = regles.allow.some(function (a) { return a === "/"; });
  if (toutBloque && !toutAutorise) return { etat: "bloque", restreint: false, explicite: explicite };

  // Des interdictions de chemins particuliers (rubriques privees, recherche) ne
  // remettent pas en cause l'acces aux articles : le robot reste autorise.
  const restreint = regles.disallow.some(function (d) { return d && d !== "/"; });
  return { etat: "autorise", restreint: restreint, explicite: explicite };
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
      headers: UA_READR,
    });
    clearTimeout(timer);
    if (!r.ok) return { dispo: false, joignable: true, raison: "robots.txt inaccessible (HTTP " + r.status + ")" };
    const txt = (await r.text()).slice(0, 200000);
    if (!/user-agent/i.test(txt)) return { dispo: false, joignable: true, raison: "robots.txt vide ou non standard" };

    const groups = parseRobots(txt);
    const brutRobots = txt;
    const bots = AI_BOTS.map(function (b) {
      const st = botStatus(groups, b.ua);
      return { nom: b.label, org: b.org, usage: b.usage, etat: st.etat, restreint: !!st.restreint };
    });
    const bloques = bots.filter(function (b) { return b.etat === "bloque"; });

    const recup = bots.filter(function (b) { return b.usage === "recuperation"; });
    const entrain = bots.filter(function (b) { return b.usage === "entrainement"; });
    const recupBloques = recup.filter(function (b) { return b.etat === "bloque"; });
    const entrainBloques = entrain.filter(function (b) { return b.etat === "bloque"; });

    let etat;
    if (recupBloques.length === 0) etat = bloques.length === 0 ? "ouvert" : "partiel";
    else if (recupBloques.length >= recup.length - 1) etat = "restreint";
    else etat = "partiel";

    return {
      dispo: true,
      etat: etat,
      bots: bots,
      nbBloques: bloques.length,
      nbTotal: bots.length,
      listeBloques: bloques.map(function (b) { return b.nom; }),
      // Ventilation par usage : seuls les robots de recuperation conditionnent la citation.
      texte: brutRobots.slice(0, 20000),
      recupTotal: recup.length,
      recupBloques: recupBloques.length,
      recupListeBloques: recupBloques.map(function (b) { return b.nom; }),
      entrainTotal: entrain.length,
      entrainBloques: entrainBloques.length,
      entrainListeBloques: entrainBloques.map(function (b) { return b.nom; }),
    };
  } catch (e) {
    clearTimeout(timer);
    const code = (e && e.cause && e.cause.code) || "";
    // ENOTFOUND : le domaine n'existe pas du tout.
    if (code === "ENOTFOUND") return { dispo: false, joignable: false, raison: "domaine introuvable" };
    return { dispo: false, joignable: true, raison: "robots.txt injoignable" };
  }
}




// Version de la fonction. Elle s'affiche en bas du rapport et se consulte
// directement dans un navigateur, ce qui permet de verifier ce qui tourne
// reellement en ligne.
const VERSION = "2026-08-22 / v6 : extrait payant analyse, corps d'article isole";

// ============================================================
//  TEXTES DU RAPPORT
//  Toutes les phrases affichées sont écrites ici. Aucune n'est
//  produite par un modèle. Pour changer une formulation, modifiez
//  ce bloc : c'est le seul endroit à toucher.
// ============================================================

const TEXTES = {

  // --- Pourquoi chaque critère compte, et quoi faire quand il est faible ---
  criteres: {
    robots: {
      nom: "Accès des robots de récupération",
      presse: false,
      pourquoi: "Ces robots sont ceux qui viennent lire vos pages au moment où un lecteur pose sa question. Sans accès, aucune citation n'est possible, quelle que soit la qualité de vos articles.",
      action: "Réexaminer les directives du fichier robots.txt en distinguant les robots d'entraînement, qui alimentent les modèles, de ceux de récupération, qui conditionnent la citation.",
    },
    balisage: {
      nom: "Balisage Article ou NewsArticle",
      presse: true,
      pourquoi: "Le balisage indique aux machines qu'elles lisent un article de presse et non une page quelconque. Il conditionne la reconnaissance de votre contenu comme source d'information.",
      action: "Déclarer le type NewsArticle dans les données structurées de chaque article, avec le titre, la date et la rubrique.",
    },
    auteur: {
      nom: "Auteur déclaré et page journaliste",
      presse: true,
      pourquoi: "Un auteur identifiable rattache l'information à une personne et à une expertise. C'est un des signaux d'autorité les plus regardés sur les sujets sensibles.",
      action: "Renseigner le champ auteur dans les données structurées et relier chaque signature à une page journaliste documentée.",
    },
    dateMaj: {
      nom: "Date de mise à jour déclarée",
      presse: false,
      pourquoi: "Sans date de modification, vos contenus paraissent figés face à des sources qui affichent leur actualisation. Sur un sujet mouvant, cela suffit à vous écarter.",
      action: "Publier une date de mise à jour visible et déclarée dans le balisage, en priorité sur les articles de fond et les sujets récurrents.",
    },
    chiffres: {
      nom: "Données chiffrées par article",
      presse: false,
      pourquoi: "Les passages contenant une donnée vérifiable sont nettement plus repris que les développements qualitatifs. C'est la matière première d'une réponse générative.",
      action: "Placer en tête d'article un encadré de deux ou trois données sourcées et datées, en commençant par les sujets à fort trafic.",
    },
    ouverture: {
      nom: "Réponse dès l'ouverture",
      presse: false,
      pourquoi: "Le premier paragraphe décide si votre article répond à la question. S'il installe le décor au lieu de répondre, il n'est pas repris.",
      action: "Ouvrir les articles par une phrase qui répond directement, en restant sous soixante mots et en citant une donnée concrète.",
    },
    paragraphes: {
      nom: "Longueur des paragraphes",
      presse: false,
      pourquoi: "Un moteur extrait un passage autonome, pas un article entier. Un paragraphe trop long ou trop dépendant du contexte ne peut pas être repris tel quel.",
      action: "Ramener les paragraphes à une fourchette de trente à soixante mots, avec une idée par bloc et sans mot de renvoi en ouverture.",
    },
    listes: {
      nom: "Listes et tableaux",
      presse: false,
      pourquoi: "Les formats structurés sont repris en priorité par les moteurs de réponse, parce qu'ils se transposent directement dans un résumé.",
      action: "Introduire une liste ou un tableau de synthèse dans les formats explicatifs : comparatifs, modes d'emploi, récapitulatifs.",
    },
    sources: {
      nom: "Citations et sources primaires",
      presse: true,
      pourquoi: "Les verbatims et les liens vers des sources institutionnelles distinguent un travail journalistique d'un contenu de reprise. Ils augmentent la confiance accordée à la source.",
      action: "Systématiser les liens vers les documents d'origine (institutions, études, textes officiels) et conserver au moins un verbatim identifiable par article.",
    },

    newsletter: {
      nom: "Offre de newsletters",
      pourquoi: "La newsletter est le seul canal où vous décidez du moment, du contenu et de la mise en avant. C'est la première marche vers une relation directe.",
      action: "Structurer une offre de newsletters par centre d'intérêt et l'exposer dans le parcours de lecture, pas uniquement en pied de page.",
    },
    collecte: {
      nom: "Formulaire de collecte d'adresses",
      pourquoi: "Sans point de collecte visible, une audience de passage reste anonyme et ne peut jamais être recontactée.",
      action: "Placer un formulaire de collecte au sein des articles et en fin de lecture, avec une promesse éditoriale explicite.",
    },
    compte: {
      nom: "Espace compte et connexion",
      pourquoi: "La connexion transforme une visite anonyme en lecteur identifié. C'est le socle de toute personnalisation et de toute stratégie d'abonnement.",
      action: "Ouvrir un espace compte et donner une raison concrète de se connecter : lecture reprise, articles sauvegardés, alertes personnalisées.",
    },
    abonnement: {
      nom: "Offre d'abonnement",
      pourquoi: "L'abonnement est le seul revenu qui ne dépend ni d'un algorithme ni d'un marché publicitaire. Il suppose un parcours lisible et accessible.",
      action: "Rendre l'offre d'abonnement accessible depuis chaque article et travailler les étapes du tunnel de conversion.",
    },
    application: {
      nom: "Application mobile",
      pourquoi: "L'application crée une habitude de consultation qui ne passe par aucun moteur ni réseau social.",
      action: "Évaluer l'intérêt d'une application au regard de votre volume de lecteurs récurrents et de votre offre d'abonnement.",
    },
    push: {
      nom: "Notifications directes",
      pourquoi: "La notification atteint le lecteur sans intermédiaire, au moment choisi par la rédaction.",
      action: "Mettre en place un canal de notification et le piloter par thématique pour éviter la désinscription.",
    },
  },

  // --- Synthèse : phrases courtes, assemblées à partir des mesures ---
  synthese: {
    ouverture: {
      haut: "Vos articles remplissent l'essentiel des conditions techniques permettant à un moteur de réponse de les citer.",
      moyen: "Vos articles remplissent une partie des conditions permettant à un moteur de réponse de les citer.",
      bas: "Vos articles remplissent peu des conditions permettant à un moteur de réponse de les citer.",
    },
    frein: "Le principal point à corriger est {frein}.",
    blocage: "Un élément bloque la reprise de vos contenus quelle que soit leur qualité : {motif}.",
    audience: {
      haut: "Vous disposez en revanche des canaux nécessaires pour joindre vos lecteurs directement : {liste}.",
      moyen: "Côté canaux directs, vous disposez de {liste}, mais il manque {manque}.",
      bas: "Vous n'avez presque aucun moyen de joindre vos lecteurs sans passer par une plateforme : il manque {manque}.",
    },
    contenuPartiel: "Vos articles étant réservés aux abonnés, nous n'avons lu que l'extrait accessible : les mesures de longueur et de densité portent sur cette partie visible, celle que voient aussi les moteurs de réponse.",
    conclusion: {
      risque: "Une baisse de visibilité sur les moteurs se traduirait donc directement par une perte d'audience, sans relais pour la retenir.",
      amorti: "Une baisse de visibilité sur les moteurs serait donc partiellement absorbée par vos canaux directs.",
      solide: "Votre exposition aux moteurs est correcte et vos canaux directs vous permettent de convertir cette audience.",
    },
  },

  // --- Recommandations sur l'audience propre, selon ce qui manque ---
  recoIndep: {
    compte: "Ouvrir un espace de connexion pour identifier vos lecteurs récurrents et sortir de l'audience anonyme.",
    newsletter: "Structurer une offre de newsletters par thématique pour transformer l'audience de passage en base adressable.",
    collecte: "Installer des points de collecte d'adresses dans le parcours de lecture, avec une promesse éditoriale claire.",
    abonnement: "Rendre l'offre d'abonnement visible depuis les articles et travailler les étapes du tunnel.",
    push: "Ouvrir un canal de notification directe, piloté par thématique.",
    application: "Évaluer l'intérêt d'une application au regard de votre volume de lecteurs récurrents et de votre offre d'abonnement.",
    consolider: "Exploiter les canaux propres déjà en place : segmentation, scénarios de réengagement, passage du lecteur inscrit à l'abonné.",
  },
};

// ============================================================
//  GRILLES DE NOTATION
//  Deux scores, quinze critères, aucun doublon.
// ============================================================

function pts(valeur, paliers) {
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

function etatCritere(obtenu, max) {
  const r = max ? obtenu / max : 0;
  if (r >= 0.75) return "fort";
  if (r >= 0.4) return "moyen";
  return "faible";
}

// --- Score 1 : citabilité par les moteurs de réponse ---
function scorePotentiel(m, robots) {
  const d = [];

  let ptsRobots = 0, constatRobots;
  if (robots && robots.dispo) {
    const ouverts = robots.recupTotal - robots.recupBloques;
    ptsRobots = Math.round((ouverts / robots.recupTotal) * 16);
    constatRobots = ouverts + " robot(s) de récupération sur " + robots.recupTotal + " ont accès au site";
  } else {
    constatRobots = "Fichier robots.txt non lisible";
  }
  d.push({ cle: "robots", obtenu: ptsRobots, max: 16, constat: constatRobots });

  d.push({ cle: "chiffres", obtenu: pts(m.chiffresMoyen, [[4, 14], [3, 11], [2, 8], [1, 4]]), max: 14,
           constat: m.chiffresMoyen + " donnée(s) chiffrée(s) en moyenne par article" });

  d.push({ cle: "balisage", obtenu: etatVers(m.balisageNews === "present" ? "present" : m.balisageArticle, 12, 6), max: 12,
           constat: m.balisageNews === "present" ? "Vos articles sont déclarés comme contenu de presse"
                  : (m.balisageArticle === "present" ? "Vos articles sont balisés Article, sans le type presse"
                  : (m.balisageArticle === "partiel" ? "Une partie seulement de vos articles est balisée"
                  : "Aucun balisage d'article détecté")) });

  d.push({ cle: "auteur",
           obtenu: (m.auteurBalise === "present" ? 8 : (m.auteurBalise === "partiel" ? 4 : 0))
                 + (m.pageAuteur === "present" ? 4 : (m.pageAuteur === "partiel" ? 2 : 0)), max: 12,
           constat: (m.auteurBalise === "present" ? "Auteur déclaré dans les données structurées" : "Auteur absent des données structurées")
                  + (m.pageAuteur === "present" ? ", relié à une page journaliste" : ", sans page journaliste") });

  d.push({ cle: "paragraphes",
           obtenu: (m.paraMoyen >= 25 && m.paraMoyen <= 70) ? 12 : ((m.paraMoyen >= 18 && m.paraMoyen <= 95) ? 7 : 2), max: 12,
           constat: m.paraMoyen + " mots par paragraphe en moyenne" });

  d.push({ cle: "ouverture", obtenu: m.ouverturesDirectes > 0 ? 10 : 0, max: 10,
           constat: m.ouverturesDirectes > 0 ? "Le premier paragraphe répond directement"
                                             : "Le premier paragraphe ne répond pas directement" });

  d.push({ cle: "listes", obtenu: pts(m.listesMoyen, [[3, 8], [2, 6], [1, 4]]), max: 8,
           constat: m.listesMoyen + " liste(s) ou tableau(x) par article" });

  d.push({ cle: "dateMaj", obtenu: etatVers(m.dateMaj, 8, 4), max: 8,
           constat: m.dateMaj === "present" ? "Date de modification déclarée" : "Aucune date de modification déclarée" });

  d.push({ cle: "sources",
           obtenu: pts(m.sourcesMoyen, [[2, 5], [1, 3]]) + pts(m.citationsMoyen, [[2, 3], [1, 2]]), max: 8,
           constat: m.sourcesMoyen + " lien(s) vers des sources primaires et " + m.citationsMoyen + " citation(s) par article" });

  const total = d.reduce(function (a, x) { return a + x.obtenu; }, 0);
  return { score: total, detail: d };
}

// --- Score 2 : audience détenue en propre ---
function scoreAudience(a) {
  const b = function (v, plein) { return v ? plein : 0; };
  const d = [
    { cle: "compte", obtenu: b(a.compte, 25), max: 25,
      constat: a.compte ? "Un espace compte permet d'identifier le lecteur" : "Aucun espace compte repérable" },
    { cle: "newsletter", obtenu: b(a.newsletter, 22), max: 22,
      constat: a.newsletter ? "Une offre de newsletters est accessible" : "Aucune offre de newsletters repérable" },
    { cle: "abonnement", obtenu: b(a.abonnement, 22), max: 22,
      constat: a.abonnement ? "Une offre d'abonnement est accessible" : "Aucune offre d'abonnement repérable" },
    { cle: "collecte", obtenu: b(a.formulaireEmail, 13), max: 13,
      constat: a.formulaireEmail ? "Un point de collecte d'adresses est présent" : "Aucun point de collecte repérable" },
    { cle: "application", obtenu: b(a.appMobile, 10), max: 10,
      constat: a.appMobile ? "Une application mobile est proposée" : "Aucune application mobile repérée" },
    { cle: "push", obtenu: b(a.push, 8), max: 8,
      constat: a.push ? "Un canal de notification directe est en place" : "Aucun canal de notification directe" },
  ];
  const total = d.reduce(function (x, y) { return x + y.obtenu; }, 0);
  return { score: total, detail: d };
}

// --- Malus : blocages qui annulent la citation ---
function calculMalus(m, robots) {
  const l = [];
  if (m.nosnippet) l.push({ libelle: "Extraction interdite (nosnippet ou max-snippet:0)", points: 15,
                            preuve: "directive relevée dans vos pages" });
  if (m.noindex) l.push({ libelle: "Pages en noindex", points: 10, preuve: "directive noindex relevée" });
  if (m.paywall) l.push({ libelle: "Contenu derrière un paywall", points: 8,
                          preuve: m.partPaywall + " % des articles analysés" });
  if (robots && robots.dispo && robots.recupBloques >= robots.recupTotal - 1) {
    l.push({ libelle: "Robots de récupération bloqués", points: 8,
             preuve: robots.recupBloques + " sur " + robots.recupTotal + " bloqués" });
  }
  if (m.datePubliee === "absent" && m.dateMaj === "absent") {
    l.push({ libelle: "Aucune date de publication ni de mise à jour", points: 4, preuve: "aucune date exploitable" });
  }
  let total = l.reduce(function (a, x) { return a + x.points; }, 0);
  if (total > 25) total = 25;
  return { total: total, liste: l };
}

// ============================================================
//  SYNTHÈSE : assemblée par règles, sans modèle génératif
// ============================================================

function niveauScore(s) { return s >= 70 ? "haut" : (s >= 45 ? "moyen" : "bas"); }

function construireSynthese(citab, audience, malus, contenuPartiel) {
  const nE = niveauScore(citab.score);
  const nA = niveauScore(audience.score);
  const p = [];

  p.push(TEXTES.synthese.ouverture[nE]);

  // Le frein principal est nommé, pas résumé en généralités.
  const faibles = citab.detail
    .filter(function (x) { return etatCritere(x.obtenu, x.max) !== "fort"; })
    .sort(function (a, b) { return (b.max - b.obtenu) - (a.max - a.obtenu); });
  if (faibles.length) {
    p.push(TEXTES.synthese.frein.replace("{frein}",
      TEXTES.criteres[faibles[0].cle].nom.toLowerCase()));
  }

  if (malus.total > 0 && malus.liste.length) {
    p.push(TEXTES.synthese.blocage.replace("{motif}", malus.liste[0].libelle.toLowerCase()));
  }

  // Ce qui est en place et ce qui manque, nommément.
  const enPlace = audience.detail.filter(function (x) { return x.obtenu > 0; })
    .map(function (x) { return TEXTES.criteres[x.cle].nom.toLowerCase(); });
  const manquant = audience.detail.filter(function (x) { return x.obtenu === 0; })
    .sort(function (a, b) { return b.max - a.max; })
    .map(function (x) { return TEXTES.criteres[x.cle].nom.toLowerCase(); });

  const liste = function (t) {
    if (!t.length) return "";
    if (t.length === 1) return t[0];
    return t.slice(0, -1).join(", ") + " et " + t[t.length - 1];
  };

  if (nA === "haut") {
    p.push(TEXTES.synthese.audience.haut.replace("{liste}", liste(enPlace.slice(0, 3))));
  } else if (nA === "moyen") {
    p.push(TEXTES.synthese.audience.moyen
      .replace("{liste}", liste(enPlace.slice(0, 2)))
      .replace("{manque}", liste(manquant.slice(0, 2))));
  } else {
    p.push(TEXTES.synthese.audience.bas.replace("{manque}", liste(manquant.slice(0, 3))));
  }

  if (contenuPartiel) p.push(TEXTES.synthese.contenuPartiel);

  if (nE === "haut" && nA !== "bas") p.push(TEXTES.synthese.conclusion.solide);
  else if (nA === "bas") p.push(TEXTES.synthese.conclusion.risque);
  else p.push(TEXTES.synthese.conclusion.amorti);

  return p.join(" ");
}

// Recommandations : les critères les plus coûteux, puis l'audience propre.
function construireRecos(citab, audience) {
  const recos = [];

  citab.detail
    .filter(function (x) { return etatCritere(x.obtenu, x.max) !== "fort"; })
    .sort(function (a, b) { return (b.max - b.obtenu) - (a.max - a.obtenu); })
    .slice(0, 4)
    .forEach(function (x) {
      const t = TEXTES.criteres[x.cle];
      recos.push({ titre: t.nom, action: t.action, perdus: x.max - x.obtenu, famille: "Potentiel de citation" });
    });

  const manque = audience.detail.filter(function (x) { return x.obtenu === 0; })
                                .sort(function (a, b) { return b.max - a.max; });
  if (manque.length) {
    manque.slice(0, 2).forEach(function (x) {
      recos.push({ titre: TEXTES.criteres[x.cle].nom, action: TEXTES.recoIndep[x.cle],
                   perdus: x.max, famille: "Audience en propre" });
    });
  } else {
    recos.push({ titre: "Exploiter vos canaux propres", action: TEXTES.recoIndep.consolider,
                 perdus: 0, famille: "Audience en propre" });
  }
  return recos;
}

// Constats détaillés : chaque critère reçoit son texte fixe.
function construireConstats(bloc, famille) {
  return bloc.detail.map(function (x) {
    const t = TEXTES.criteres[x.cle];
    const etat = etatCritere(x.obtenu, x.max);
    return {
      nom: t.nom,
      famille: famille,
      presse: !!t.presse,
      etat: etat,
      constat: x.constat,
      pourquoi: t.pourquoi,
      action: etat === "fort" ? "" : t.action,
      obtenu: x.obtenu,
      max: x.max,
    };
  });
}


// ============================================================
//  RÉÉCRITURES : seul recours à un modèle génératif.
//  Facultatif : sans clé, ou en cas d'échec, le rapport reste complet.
// ============================================================

const MODELE = "gemini-3.5-flash-lite";

function nombresDe(t) {
  return (String(t).match(/\d[\d\s.,]*/g) || [])
    .map(function (x) { return x.replace(/[\s.,]/g, ""); })
    .filter(function (x) { return x.length > 0; });
}

// Une réécriture ne peut contenir que des nombres présents dans les pages du média.
function reecritureValide(version, source) {
  const refs = nombresDe(source);
  const nb = nombresDe(version);
  for (let i = 0; i < nb.length; i++) {
    if (refs.indexOf(nb[i]) === -1) return false;
  }
  return true;
}

async function genererReecritures(extraits) {
  if (!process.env.GEMINI_API_KEY || !extraits || !extraits.length) return [];

  const sys = [
    "Tu reformules des passages d'articles de presse pour qu'ils puissent être repris par un moteur de réponse.",
    "INTERDICTION ABSOLUE D'INVENTER UN FAIT. Tu n'ajoutes aucun chiffre, aucune date, aucun nom, aucune quantité",
    "qui ne figure pas déjà mot pour mot dans les extraits fournis. Tu réorganises seulement l'information existante :",
    "la réponse en première phrase, le nom de l'entité écrit en toutes lettres, aucun mot de renvoi au contexte.",
    "Si un extrait ne contient aucun chiffre, tu n'en inventes pas.",
    "Français professionnel, tous les accents. Aucun tiret cadratin.",
    "Réponds uniquement par un objet JSON : {\"reecritures\":[{\"faiblesse\":\"...\",\"version\":\"...\"}]}",
    "Exactement 3 entrées. Chaque version fait 60 mots maximum.",
    "Le champ faiblesse explique en une phrase ce qui rendait le passage d'origine difficile à reprendre.",
  ].join("\n");

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, 6000);
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" + MODELE + ":generateContent",
      {
        method: "POST",
        signal: ctrl.signal,
        headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: sys }] },
          contents: [{ role: "user", parts: [{ text: "Extraits réels : " + extraits.join(" | ") }] }],
          generationConfig: { temperature: 0.5, maxOutputTokens: 900,
                              responseMimeType: "application/json" },
        }),
      });
    clearTimeout(timer);
    if (!r.ok) return [];
    const j = await r.json();
    const parts = (j.candidates && j.candidates[0] && j.candidates[0].content
                   && j.candidates[0].content.parts) || [];
    const txt = parts.map(function (p) { return p.text || ""; }).join("").trim();
    const a = txt.indexOf("{"), b = txt.lastIndexOf("}");
    if (a === -1) return [];
    const obj = JSON.parse(txt.slice(a, b + 1));
    const source = extraits.join(" ");
    return (obj.reecritures || [])
      .filter(function (x) { return x && x.version && reecritureValide(x.version, source); })
      .slice(0, 3);
  } catch (e) {
    return [];   // le rapport se passe très bien des réécritures
  }
}

// ============================================================
//  POINT D'ENTRÉE
// ============================================================

exports.handler = async function (event) {
  const json = function (code, obj) {
    return { statusCode: code, headers: { "content-type": "application/json; charset=utf-8" },
             body: JSON.stringify(obj) };
  };

  // Une visite directe dans le navigateur affiche la version deployee.
  if (event.httpMethod === "GET") {
    return json(200, { version: VERSION });
  }
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  JOURNAL.length = 0;

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { body = {}; }
  const url = (body.url || "").trim();
  const theme = (body.theme || "").trim();
  if (!url) return json(400, { error: "Adresse manquante." });

  let origin, host;
  try {
    const u = new URL(url);
    origin = u.origin; host = u.hostname;
  } catch (e) {
    return json(400, { error: "Adresse invalide. Indiquez un domaine complet, par exemple economist.com" });
  }
  if (!domaineValide(host)) {
    return json(400, { error: "Adresse incomplète. Indiquez le domaine avec son extension, par exemple economist.com" });
  }

  // Tout est lancé en parallèle : robots.txt, page d'accueil et plan de site.
  // Le plan de site ne sert que si l'accueil est bloqué, mais le demander d'emblée
  // évite d'ajouter son délai à celui de l'accueil.
  let [robots, site, planXml] = await Promise.all([
    readRobots(url),
    lireSite(origin),
    getXML(origin + "/sitemap.xml", 3500),
  ]);

  // Accueil inaccessible : on reconstitue l'échantillon depuis le plan de site.
  if (!site.dispo && site.raison === "page d'accueil illisible") {
    let secours = articlesDeXml(planXml, origin);
    if (!secours.length) {
      secours = await articlesDuPlanDeSite(origin, robots && robots.texte);
    }
    if (secours.length) site = await lireSite(origin, secours);
  }

  if (robots.joignable === false && !site.dispo) {
    return json(400, { error: "Ce domaine est introuvable. Vérifiez l'adresse saisie." });
  }

  let hostFinal = host;
  try { if (site.originFinal) hostFinal = new URL(site.originFinal).hostname; } catch (e) {}
  const redirige = hostFinal.replace(/^www\./i, "") !== host.replace(/^www\./i, "");

  if (!site.dispo) {
    return json(200, {
      mesurable: false,
      hostFinal: hostFinal, redirige: redirige, theme: theme,
      raison: site.raison || "",
      journal: JOURNAL.slice(0, 6),
      robots: robots,
      site_: site,
      version: VERSION,
    });
  }

  const citab = scorePotentiel(site, robots);
  const malus = calculMalus(site, robots);
  citab.brut = citab.score;
  citab.malus = malus;
  citab.score = Math.max(0, citab.score - malus.total);

  const audience = scoreAudience(site.audience || {});
  const reecritures = await genererReecritures(site.extraits);

  return json(200, {
    mesurable: true,
    hostFinal: hostFinal,
    redirige: redirige,
    theme: theme,
    synthese: construireSynthese(citab, audience, malus, site.contenuPartiel),
    potentiel: { score: citab.score, brut: citab.brut, malus: citab.malus, detail: citab.detail },
    audience: { score: audience.score, detail: audience.detail, reseaux: (site.audience || {}).reseaux || 0 },
    constats: construireConstats(citab, "Potentiel de citation").concat(construireConstats(audience, "Audience en propre")),
    recos: construireRecos(citab, audience),
    ouverture: {
      texte: site.ouverture || "",
      mots: site.ouvertureMots || 0,
      chiffre: !!site.ouvertureChiffre,
      renvoi: !!site.ouvertureRenvoi,
    },
    passage: site.passage || "",
    reecritures: reecritures,
    robots: robots,
    site_: site,
    version: VERSION,
  });
};
