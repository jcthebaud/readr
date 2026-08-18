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
    dependance: { type: "STRING" },
    aio: {
      type: "OBJECT",
      properties: {
        enjeu: { type: "STRING" },
        citationRaison: { type: "STRING" },
      },
      required: ["enjeu", "citationRaison"],
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
    reecritures: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          faiblesse: { type: "STRING" },
          version: { type: "STRING" },
        },
        required: ["faiblesse", "version"],
      },
    },
    recos: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          titre: { type: "STRING" },
          perimetre: { type: "STRING", enum: ["Google AI Overview", "Assistants IA", "Google et assistants IA"] },
          detail: { type: "STRING" },
          impact: { type: "STRING", enum: ["fort", "moyen"] },
          delai: { type: "STRING", enum: ["court terme", "moyen terme"] },
          responsable: { type: "STRING", enum: ["Redaction", "Technique", "Marketing", "Produit"] },
        },
        required: ["titre", "perimetre", "detail", "impact", "delai", "responsable"],
      },
    },
  },
  required: ["site", "verdict", "dependance", "aio", "llm", "explications", "reecritures", "recos"],
};

// --------- Assemblage : mesures calculees + redaction du modele ---------
function assembler(txt, calcAIO, calcLLM, calcPresse, calcIndep, criteres, robots, site, hostFinal, redirige, mode) {
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
    dependance: d.dependance || "",
    mesurable: !!calcAIO,
    aio: calcAIO ? {
      score: calcAIO.score,
      brut: calcAIO.brut,
      malus: calcAIO.malus,
      detail: calcAIO.detail,
      enjeu: aio.enjeu || "",
      passage: (site && site.passage) || "",
      ouverture: (site && site.ouverture) || "",
      ouvertureMots: site ? site.ouvertureMots : 0,
      ouvertureChiffre: site ? site.ouvertureChiffre : false,
      ouvertureRenvoi: site ? site.ouvertureRenvoi : false,
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
    presse: calcPresse ? { score: calcPresse.score, detail: calcPresse.detail } : null,
    independance: calcIndep ? { score: calcIndep.score, detail: calcIndep.detail,
                                reseaux: (site && site.audience) ? site.audience.reseaux : 0 } : null,
    signaux: signaux,
    recos: Array.isArray(d.recos) ? d.recos : [],
    reecritures: Array.isArray(d.reecritures) ? d.reecritures.slice(0, 3) : [],
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

  // --- Bloc 1 : identification du contenu (30 points) ---
  d.push({ critere: "Balisage Article ou NewsArticle", obtenu: etatVers(m.balisageArticle, 12, 6), max: 12,
           constat: m.balisageArticle === "present" ? "Pr\u00e9sent sur les pages analys\u00e9es"
                  : (m.balisageArticle === "partiel" ? "Pr\u00e9sent sur une partie des pages" : "Absent des pages analys\u00e9es") });
  d.push({ critere: "Auteur d\u00e9clar\u00e9 dans les donn\u00e9es structur\u00e9es", obtenu: etatVers(m.auteurBalise, 8, 4), max: 8,
           constat: m.auteurBalise === "present" ? "Champ auteur renseign\u00e9" : "Champ auteur absent" });
  d.push({ critere: "Date de publication d\u00e9clar\u00e9e", obtenu: etatVers(m.datePubliee, 4, 2), max: 4,
           constat: m.datePubliee === "present" ? "Date de publication pr\u00e9sente" : "Date de publication absente" });
  d.push({ critere: "Date de mise \u00e0 jour d\u00e9clar\u00e9e", obtenu: etatVers(m.dateMaj, 6, 3), max: 6,
           constat: m.dateMaj === "present" ? "Date de modification pr\u00e9sente" : "Date de modification absente" });

  // --- Bloc 2 : extractibilite des passages (55 points) ---
  // C'est le coeur de la citation dans un AI Overview : le moteur reprend un passage,
  // pas une page entiere.
  d.push({ critere: "Donn\u00e9es chiffr\u00e9es par page", obtenu: pts(m.chiffresMoyen, [[4,14],[3,11],[2,8],[1,4]]), max: 14,
           constat: m.chiffresMoyen + " donn\u00e9e(s) chiffr\u00e9e(s) en moyenne" });
  d.push({ critere: "Listes et tableaux", obtenu: pts(m.listesMoyen, [[3,12],[2,9],[1,6]]), max: 12,
           constat: m.listesMoyen + " liste(s) ou tableau(x) par page" });
  d.push({ critere: "Longueur des paragraphes",
           obtenu: (m.paraMoyen >= 25 && m.paraMoyen <= 70) ? 12 : ((m.paraMoyen >= 18 && m.paraMoyen <= 95) ? 7 : 2), max: 12,
           constat: m.paraMoyen + " mots par paragraphe en moyenne" });
  d.push({ critere: "R\u00e9ponse d\u00e8s l'ouverture", obtenu: m.ouverturesDirectes > 0 ? 9 : 0, max: 9,
           constat: m.ouverturesDirectes > 0 ? "Le premier paragraphe r\u00e9pond directement" : "Le premier paragraphe ne r\u00e9pond pas directement" });
  d.push({ critere: "Sous-titres formul\u00e9s en question", obtenu: pts(m.partQuestions, [[30,8],[15,5],[1,3]]), max: 8,
           constat: m.partQuestions + " % des sous-titres sont des questions" });

  // --- Bloc 3 : formats de reponse directe (15 points) ---
  d.push({ critere: "Balisage FAQ ou HowTo", obtenu: etatVers(m.balisageFAQ, 8, 4), max: 8,
           constat: m.balisageFAQ === "present" ? "Balisage de r\u00e9ponse directe pr\u00e9sent" : "Aucun balisage de r\u00e9ponse directe" });
  d.push({ critere: "Sous-titres par page", obtenu: pts(m.sousTitresMoyen, [[5,7],[3,5],[1,3]]), max: 7,
           constat: m.sousTitresMoyen + " sous-titre(s) en moyenne" });

  const total = d.reduce(function (a, x) { return a + x.obtenu; }, 0);
  return { score: total, detail: d };
}

// Score Assistants IA : part mesurable uniquement.
// Les mentions de la marque hors du site ne sont pas mesurables ici, c'est assume et affiche.
function scoreLLM(m, robots) {
  const d = [];

  // Les robots de recuperation conditionnent la citation, ceux d'entrainement
  // alimentent les modeles sans effet direct. La ponderation le reflete.
  let ptsRecup = 0, constatRecup, ptsEntrain = 0, constatEntrain;
  if (robots && robots.dispo) {
    const ouvertsR = robots.recupTotal - robots.recupBloques;
    ptsRecup = Math.round((ouvertsR / robots.recupTotal) * 28);
    constatRecup = ouvertsR + " / " + robots.recupTotal + " robots de r\u00e9cup\u00e9ration ont acc\u00e8s";
    const ouvertsE = robots.entrainTotal - robots.entrainBloques;
    ptsEntrain = Math.round((ouvertsE / robots.entrainTotal) * 12);
    constatEntrain = ouvertsE + " / " + robots.entrainTotal + " robots d'entra\u00eenement ont acc\u00e8s";
  } else {
    constatRecup = "Fichier robots.txt non lisible";
    constatEntrain = "Fichier robots.txt non lisible";
  }
  d.push({ critere: "Acc\u00e8s des robots de r\u00e9cup\u00e9ration", obtenu: ptsRecup, max: 28, constat: constatRecup });
  d.push({ critere: "Acc\u00e8s des robots d'entra\u00eenement", obtenu: ptsEntrain, max: 12, constat: constatEntrain });

  d.push({ critere: "Auteur d\u00e9clar\u00e9 dans les donn\u00e9es structur\u00e9es", obtenu: etatVers(m.auteurBalise, 15, 8), max: 15,
           constat: m.auteurBalise === "present" ? "Auteur d\u00e9clar\u00e9 comme entit\u00e9"
                  : (m.auteurTexteSeul ? "Auteur d\u00e9clar\u00e9 en texte simple, non reli\u00e9 \u00e0 une entit\u00e9" : "Champ auteur absent") });
  d.push({ critere: "Balisage Article ou NewsArticle", obtenu: etatVers(m.balisageArticle, 12, 6), max: 12,
           constat: m.balisageArticle === "present" ? "Contenu identifi\u00e9 comme article" : "Contenu non identifi\u00e9 comme article" });
  d.push({ critere: "Date de mise \u00e0 jour d\u00e9clar\u00e9e", obtenu: etatVers(m.dateMaj, 8, 4), max: 8,
           constat: m.dateMaj === "present" ? "Actualisation explicite" : "Actualisation non d\u00e9clar\u00e9e" });
  d.push({ critere: "Longueur des pages", obtenu: pts(m.motsMoyen, [[1200,15],[600,11],[300,6]]), max: 15,
           constat: m.motsMoyen + " mots en moyenne" });
  d.push({ critere: "Liage d'entit\u00e9 (sameAs)", obtenu: etatVers(m.liageEntite, 5, 3), max: 5,
           constat: m.liageEntite === "present" ? "Liens d'entit\u00e9 pr\u00e9sents" : "Aucun lien d'entit\u00e9 d\u00e9clar\u00e9" });
  d.push({ critere: "Fichier llms.txt", obtenu: (m.llmsTxt ? 5 : 0), max: 5,
           constat: m.llmsTxt ? "Pr\u00e9sent \u00e0 la racine du site" : "Absent" });

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
  const timer = setTimeout(function () { ctrl.abort(); }, ms || 2500);
  try {
    const r = await fetch(u, { signal: ctrl.signal, redirect: "follow", headers: UA });
    clearTimeout(timer);
    if (!r.ok) return null;
    const ct = r.headers.get("content-type") || "";
    if (ct && ct.indexOf("html") === -1) return null;
    const txt = await r.text();
    return {
      html: txt.slice(0, 400000),
      urlFinale: r.url || u,
      xRobots: r.headers.get("x-robots-tag") || "",
    };
  } catch (e) {
    clearTimeout(timer);
    return null;
  }
}

// Retire scripts, styles et balises pour obtenir le texte visible.
const ENTITES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  eacute: "\u00e9", egrave: "\u00e8", ecirc: "\u00ea", agrave: "\u00e0", ccedil: "\u00e7",
  ugrave: "\u00f9", ocirc: "\u00f4", icirc: "\u00ee", iuml: "\u00ef", ntilde: "\u00f1",
  laquo: "\u00ab", raquo: "\u00bb", hellip: "...", rsquo: "'", lsquo: "'",
  ldquo: '"', rdquo: '"', ndash: ", ", mdash: ", ", euro: "\u20ac", deg: "\u00b0",
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
  if (m.schemaArticle) return true;
  return m.parasUtiles >= 5 && m.mots >= 250 && m.h1 >= 1;
}

function analyserPage(html) {
  const res = {
    schemaArticle: false, schemaAuteur: false, schemaDatePub: false, schemaDateMaj: false,
    auteurVisible: false, dateVisible: false,
    h1: 0, h2: 0, paragraphes: 0, mots: 0, chiffres: 0,
    listes: 0, tableaux: 0, schemaFAQ: false, titresTotal: 0, titresQuestion: 0,
    parasUtiles: 0, paraMoyen: 0, ouvertureDirecte: false, ouverture: "", ouvertureMots: 0,
    ouvertureChiffre: false, ouvertureRenvoi: false, passage: "", passageNote: 0,
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
  if (/property=["']article:modified_time["']/i.test(html)) res.schemaDateMaj = true;
  if (/name=["']author["']/i.test(html) || /rel=["']author["']/i.test(html)) res.auteurVisible = true;
  if (/<time[\s>]/i.test(html)) res.dateVisible = true;
  if (/class=["'][^"']*(author|auteur|signature|byline)[^"']*["']/i.test(html)) res.auteurVisible = true;

  res.h1 = (html.match(/<h1[\s>]/gi) || []).length;
  res.h2 = (html.match(/<h2[\s>]/gi) || []).length;
  res.paragraphes = (html.match(/<p[\s>]/gi) || []).length;

  // --- Signaux propres au metier de la presse ---
  // Ces elements ne sont pas regardes par les outils GEO generiques, alors qu'ils
  // determinent la reprise des contenus d'actualite.

  // Le balisage NewsArticle est celui attendu pour la presse : Article seul est plus faible.
  res.schemaNews = /"@type"\s*:\s*("NewsArticle"|\[[^\]]*"NewsArticle")/i.test(html);

  // Signature reliee a une page auteur : c'est ce qui construit l'autorite journalistique.
  res.pageAuteur = /<a[^>]+href=["'][^"']*\/(auteur|auteurs|author|authors|journaliste|redaction)\//i.test(html);

  // Type d'article declare : reportage, enquete, analyse. Un signal d'expertise editoriale.
  res.genreDeclare = /"articleSection"\s*:|"genre"\s*:|"@type"\s*:\s*"(ReportageNewsArticle|AnalysisNewsArticle|OpinionNewsArticle|BackgroundNewsArticle)"/i.test(html);

  // Citations sourcees : verbatim entre guillemets, marqueur du travail journalistique
  // et matiere premiere reprise par les moteurs.
  res.citations = (html.match(/<(blockquote|q)[\s>]/gi) || []).length
                + ((html.match(/\u00ab[^\u00bb]{25,400}\u00bb/g) || []).length);

  // Liens vers des sources primaires (institutions, etudes, textes officiels)
  const liensSortants = (html.match(/<a\s[^>]*href=["']https?:\/\/[^"']+["']/gi) || []);
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
  res.listes = (html.match(/<ul[\s>]/gi) || []).length + (html.match(/<ol[\s>]/gi) || []).length;
  res.tableaux = (html.match(/<table[\s>]/gi) || []).length;

  // Balisage FAQ ou HowTo : concu pour la reponse directe
  res.schemaFAQ = /"@type"\s*:\s*"(FAQPage|HowTo|QAPage)"/i.test(html);

  // Sous-titres formules en question : structure question/reponse
  const titres = (html.match(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi) || [])
    .map(function (t) { return texteVisible(t); })
    .filter(function (t) { return t.length > 3; });
  res.titresTotal = titres.length;
  res.titresQuestion = titres.filter(function (t) { return t.indexOf("?") !== -1; }).length;

  // Paragraphes : longueur et extractibilite
  const paras = (html.match(/<p[^>]*>([\s\S]*?)<\/p>/gi) || [])
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
        const phrase = /[.!?]["'\u00bb]?\s*$/.test(t.trim());
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

  const texte = texteVisible(html);
  res.mots = texte ? texte.split(/\s+/).length : 0;
  // Une seule expression, pour ne pas compter deux fois un pourcentage.
  res.chiffres = (texte.match(/\b\d[\d\s.,]*\s*(%|euros?|EUR|\u20ac|millions?|milliards?|ans?|km|kg|heures?|jours?|mois)\b/gi) || []).length;

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

async function lireSite(origin) {
  const rep = await getHTML(origin, 2500);
  if (!rep) return { dispo: false, raison: "page d'accueil illisible" };
  const accueil = rep.html;

  let originFinal = origin;
  try { originFinal = new URL(rep.urlFinale).origin; } catch (e) {}

  const urls = trouverArticles(accueil, originFinal);
  // En parallele : douze pages coutent le meme temps qu'une seule.
  const reps = await Promise.all(urls.map(function (u) { return getHTML(u, 3500); }));

  let atteintes = 0;
  const candidates = [];
  reps.forEach(function (h, i) {
    if (!h) return;
    atteintes++;
    const mes = analyserPage(h.html);
    if (!estUnArticle(mes)) return;                  // rubrique, accueil, page de service
    candidates.push({ url: urls[i], mesures: mes, extrait: texteVisible(h.html).slice(0, 450) });
  });

  // On privilegie les pages balisees, puis les plus fournies, et on en garde cinq.
  candidates.sort(function (a, b) {
    if (a.mesures.schemaArticle !== b.mesures.schemaArticle) return a.mesures.schemaArticle ? -1 : 1;
    return b.mesures.mots - a.mesures.mots;
  });
  const pages = candidates.slice(0, 5);

  if (!pages.length) {
    return {
      dispo: false,
      raison: atteintes ? "aucune page article identifiee" : "pages inaccessibles",
      nbPages: 0, nbTentees: urls.length, nbAtteintes: atteintes, originFinal: originFinal,
    };
  }

  // Les signaux d'audience propre se trouvent surtout dans l'entete et le pied de page.
  const audience = analyserAudience(accueil + " " + (reps.find(function (x) { return x; }) || { html: "" }).html);

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
       dateVisible:0, mots:0, chiffres:0, h2:0, paragraphes:0,
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
    nbAtteintes: atteintes,
    originFinal: originFinal,
    urls: pages.map(function (p) { return p.url; }),
    extraits: pages.map(function (p) { return p.extrait; }),
    // Seuils a la majorite : une seule page atypique parmi les cinq analysees
    // ne doit pas faire chuter un site correctement configure.
    balisageArticle: niveau(agg.schemaArticle, n),
    auteurBalise: niveau(agg.schemaAuteur, n),
    datePubliee: (agg.schemaDatePub > 0 || agg.dateVisible > 0) ? "present" : "absent",
    dateMaj: agg.schemaDateMaj > 0 ? "present" : "absent",
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
  r.appMobile = /(apps\.apple\.com|itunes\.apple\.com|play\.google\.com\/store\/apps)/i.test(html);

  // Notifications push : canal direct, sans intermediaire
  r.push = /(onesignal|batch\.com|batchsdk|pushwoosh|serviceWorker[\s\S]{0,120}push|firebase-messaging)/i.test(html);

  // Plateforme de consentement : prerequis d'une collecte de donnees propres
  r.cmp = /(didomi|sirdata|onetrust|axeptio|tarteaucitron|sfbx|appconsent|quantcast|commandersact)/i.test(html);

  // Canaux non maitrises, pour mise en perspective
  r.reseaux = (html.match(/href=["'][^"']*(facebook\.com|twitter\.com|x\.com|instagram\.com|tiktok\.com|linkedin\.com|youtube\.com)/gi) || []).length;

  return r;
}

// --------- Grille editoriale : specifique au metier de la presse ---------
// Ces criteres ne figurent pas dans les outils GEO generiques. Ils portent sur
// ce qui fait l'autorite d'un media aux yeux d'un moteur de reponse.
function scorePresse(m) {
  const d = [];
  d.push({ critere: "Balisage NewsArticle", obtenu: etatVers(m.balisageNews, 25, 12), max: 25,
           constat: m.balisageNews === "present" ? "Vos articles sont declares comme contenu de presse"
                  : (m.balisageNews === "partiel" ? "Une partie seulement de vos articles est declaree comme presse" : "Vos articles sont balises Article, pas NewsArticle") });
  d.push({ critere: "Signature reliee a une page auteur", obtenu: etatVers(m.pageAuteur, 20, 10), max: 20,
           constat: m.pageAuteur === "present" ? "Les signatures renvoient vers une page journaliste" : "Les signatures ne renvoient vers aucune page journaliste" });
  d.push({ critere: "Liens vers des sources primaires", obtenu: pts(m.sourcesMoyen, [[3,20],[2,15],[1,9]]), max: 20,
           constat: m.sourcesMoyen + " lien(s) vers institutions, etudes ou textes officiels par article" });
  d.push({ critere: "Citations et verbatims", obtenu: pts(m.citationsMoyen, [[3,20],[2,15],[1,9]]), max: 20,
           constat: m.citationsMoyen + " citation(s) sourcee(s) par article" });
  d.push({ critere: "Genre editorial declare", obtenu: etatVers(m.genreDeclare, 15, 8), max: 15,
           constat: m.genreDeclare === "present" ? "Le type d'article est declare (reportage, enquete, analyse)" : "Aucun genre editorial n'est declare dans le balisage" });

  const total = d.reduce(function (a, x) { return a + x.obtenu; }, 0);
  return { score: total, detail: d };
}



// --------- Grille d'independance : ce que le media possede en propre ---------
// Les trois grilles precedentes mesurent une exposition a des plateformes que le media
// ne controle pas. Celle-ci mesure sa capacite a s'en affranchir.
function scoreIndependance(a) {
  const d = [];
  const b = function (v, plein) { return v ? plein : 0; };

  d.push({ critere: "Offre de newsletters identifiable", obtenu: b(a.newsletter, 20), max: 20,
           constat: a.newsletter ? "Un espace newsletters est accessible depuis le site" : "Aucun espace newsletters reperable" });
  d.push({ critere: "Formulaire de collecte d'adresses", obtenu: b(a.formulaireEmail, 15), max: 15,
           constat: a.formulaireEmail ? "Un champ de collecte d'adresses est present" : "Aucun formulaire de collecte reperable" });
  d.push({ critere: "Espace compte et connexion", obtenu: b(a.compte, 20), max: 20,
           constat: a.compte ? "Un espace compte permet d'identifier le lecteur" : "Aucun espace compte reperable : les lecteurs restent anonymes" });
  d.push({ critere: "Offre d'abonnement", obtenu: b(a.abonnement, 20), max: 20,
           constat: a.abonnement ? "Une offre d'abonnement est accessible" : "Aucune offre d'abonnement reperable" });
  d.push({ critere: "Notifications push", obtenu: b(a.push, 10), max: 10,
           constat: a.push ? "Un canal de notification directe est en place" : "Aucun canal de notification directe detecte" });
  d.push({ critere: "Application mobile", obtenu: b(a.appMobile, 10), max: 10,
           constat: a.appMobile ? "Une application mobile est proposee" : "Aucune application mobile reperee" });
  d.push({ critere: "Plateforme de gestion du consentement", obtenu: b(a.cmp, 5), max: 5,
           constat: a.cmp ? "Un dispositif de consentement est en place" : "Aucun dispositif de consentement detecte" });

  const total = d.reduce(function (x, y) { return x + y.obtenu; }, 0);
  return { score: total, detail: d };
}

// --------- Controle anti-invention ---------
// Une consigne de prompt n'est pas une garantie. Ce controle verifie mecaniquement
// que le modele n'a introduit aucune statistique fabriquee, et neutralise ce qui
// ne peut pas etre justifie. Mieux vaut un champ vide qu'un chiffre faux.

// Regle stricte pour les champs d'interpretation : AUCUN chiffre.
// Leur role est d'expliquer un constat, jamais de le quantifier. Les seuls chiffres
// du rapport sont ceux que le code a mesures ou calcules.
// Cette regle attrape aussi les comparaisons du type "trois fois moins que la moyenne".
const RE_CHIFFRE = /\d/;
const RE_COMPARAISON = /\b(deux|trois|quatre|cinq|six|sept|huit|neuf|dix|moitie|double|triple)\s+(fois|points?)\b/i;

function contientChiffre(t) {
  return typeof t === "string" && (RE_CHIFFRE.test(t) || RE_COMPARAISON.test(t));
}

// Motifs de statistique, tolerance plus large pour les champs d'action
// ou un objectif chiffre est legitime (par exemple : sous 60 mots).
const RE_STAT = /(\d[\d\s.,]*\s?%)|(\d[\d\s.,]*\s*(?:euros?|EUR|\u20ac|millions?|milliards?|dollars?))|(\bfois\s+(?:moins|plus)\b)/i;

function nettoyerProse(t, journal, etiquette) {
  if (!t) return "";
  if (contientChiffre(t)) {
    journal.push(etiquette);
    return "";
  }
  return t;
}

// Pour une action, un objectif chiffre est utile : on ne retire que les statistiques.
function nettoyerAction(t, journal, etiquette) {
  if (!t) return "";
  if (RE_STAT.test(t)) {
    journal.push(etiquette);
    return "";
  }
  return t;
}

// Extrait les nombres significatifs d'un texte.
function nombresDe(t) {
  return (String(t).match(/\d[\d\s.,]*/g) || [])
    .map(function (x) { return x.replace(/[\s.,]/g, ""); })
    .filter(function (x) { return x.length > 0; });
}

// Une reecriture ne peut contenir que des nombres presents dans les extraits d'origine.
function reecritureValide(version, sourceConcatenee) {
  const refs = nombresDe(sourceConcatenee);
  const nb = nombresDe(version);
  for (let i = 0; i < nb.length; i++) {
    if (refs.indexOf(nb[i]) === -1) return false;   // nombre absent des pages du media
  }
  return true;
}

function controler(res, extraits) {
  const journal = [];
  const source = (extraits || []).join(" ");

  res.verdict = nettoyerProse(res.verdict, journal, "verdict");
  res.dependance = nettoyerProse(res.dependance, journal, "dependance");
  if (res.aio) {
    res.aio.enjeu = nettoyerProse(res.aio.enjeu, journal, "aio.enjeu");
    if (res.aio.citation) {
      res.aio.citation.raison = nettoyerProse(res.aio.citation.raison, journal, "aio.citation");
    }
  }
  if (res.llm) {
    res.llm.enjeu = nettoyerProse(res.llm.enjeu, journal, "llm.enjeu");
    res.llm.raison = nettoyerProse(res.llm.raison, journal, "llm.raison");
  }
  (res.signaux || []).forEach(function (x, i) {
    x.enjeu = nettoyerProse(x.enjeu, journal, "signal " + (i + 1));
    x.action = nettoyerAction(x.action, journal, "action " + (i + 1));
  });
  (res.recos || []).forEach(function (x, i) {
    x.detail = nettoyerAction(x.detail, journal, "reco " + (i + 1));
  });

  // Les reecritures citant un nombre absent des pages du media sont supprimees.
  const avant = (res.reecritures || []).length;
  res.reecritures = (res.reecritures || []).filter(function (r) {
    const ok = reecritureValide(r.version, source);
    if (!ok) journal.push("reecriture rejetee");
    return ok;
  });
  if (avant !== res.reecritures.length) res.reecrituresRejetees = avant - res.reecritures.length;

  res.controle = { champsNeutralises: journal.length, detail: journal };
  return res;
}

// --------- Malus : les blocages qui annulent la citation ---------
// Contrairement aux criteres positifs, ces elements empechent l'extraction
// quel que soit la qualite du contenu. Plafonnes a 25 points.
function calculMalus(m, robots) {
  const liste = [];
  if (m.nosnippet) liste.push({ libelle: "Extraction interdite (nosnippet ou max-snippet:0)", points: 15, preuve: "directive presente dans les pages analysees" });
  if (m.noindex) liste.push({ libelle: "Pages en noindex", points: 10, preuve: "directive noindex detectee" });
  if (m.paywall) liste.push({ libelle: "Contenu derriere un paywall", points: 8, preuve: m.partPaywall + "% des pages analysees" });
  if (m.datePubliee === "absent" && m.dateMaj === "absent")
    liste.push({ libelle: "Aucune date de publication ni de mise a jour", points: 4, preuve: "aucune date exploitable" });
  if (m.balisageArticle === "absent" && m.auteurAffiche === "absent")
    liste.push({ libelle: "Aucun auteur ni balisage identifiable", points: 4, preuve: "ni balisage Article ni signature" });
  if (robots && robots.dispo && robots.recupBloques >= robots.recupTotal - 1)
    liste.push({ libelle: "Robots de recuperation bloques", points: 8,
                 preuve: robots.recupBloques + " / " + robots.recupTotal + " robots de recuperation bloques" });

  let total = liste.reduce(function (a, x) { return a + x.points; }, 0);
  if (total > 25) total = 25;
  return { total: total, liste: liste };
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
      return { nom: b.label, org: b.org, usage: b.usage, etat: st.etat, source: st.source };
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
    "R\u00c8GLE ABSOLUE : tu ne simules rien. Tu ne rediges aucune reponse d'IA fictive, aucune requete imaginaire, aucun exemple hypothetique. Le rapport ne doit contenir que des constats issus des mesures et des extraits fournis.",
    "R\u00c8GLE ABSOLUE : tu ne commentes QUE les crit\u00e8res mesur\u00e9s qui te sont transmis. Tu n'affirmes rien sur ce qui n'a pas \u00e9t\u00e9 mesur\u00e9 : ni les reprises par des tiers, ni la notori\u00e9t\u00e9, ni les positions concurrentielles, ni le volume de trafic, ni la performance pass\u00e9e. Si un sujet n'appara\u00eet pas dans les mesures fournies, tu n'en parles pas.",
    "R\u00c8GLE ABSOLUE : tu n'inventes jamais un fait attribuable au m\u00e9dia analys\u00e9. Tout chiffre, date, quantit\u00e9 ou nom propre que tu \u00e9cris doit provenir des extraits de leurs pages qui te sont fournis. Un fait invent\u00e9 et attribu\u00e9 \u00e0 un m\u00e9dia est la faute la plus grave que tu puisses commettre.",
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
    "- Ecris comme un consultant francais qui redige une note, pas comme une intelligence artificielle. Evite les constructions par opposition du type \'ce n'est pas X mais Y\', \'non pas X mais Y\', \'plutot que\'. Evite les mots d'emphase comme \'vraiment\', \'veritablement\', \'essentiel\'. Prefere des phrases affirmatives et concretes.",
    "- Chaque phrase apporte une information utile.",
    "",
    "Contenus attendus :",
    "- verdict : une phrase de 18 mots maximum, coh\u00e9rente avec les deux scores fournis.",
    "- dependance : trois phrases, redigees simplement, comme un consultant qui parle a un directeur. Premiere phrase : ce que les scores mesures indiquent sur la part de leur visibilite qui depend de plateformes exterieures. Deuxieme phrase : ce que montrent les mesures d'independance qui te sont fournies, en nommant precisement ce qui est en place et ce qui manque (newsletter, compte, abonnement, notification). Troisieme phrase : la consequence concrete pour leur activite. Aucun chiffre. N'emploie jamais la construction \'ce n'est pas X, c'est Y\' ni \'plutot que\'. Ecris des phrases affirmatives simples.",
    "- aio.enjeu et llm.enjeu : deux phrases chacun, exprim\u00e9es en trafic, audience et abonnement.",
    "- aio.citationRaison : une phrase qui explique, en s'appuyant uniquement sur les mesures fournies, ce qui favorise ou ce qui empeche la reprise de leurs pages comme source par Google. Tu ne decris aucune requete et aucune reponse imaginaire.",
    "- llm.raison : une phrase appuy\u00e9e sur les mesures fournies.",
    "- explications : exactement autant d'entr\u00e9es que de crit\u00e8res fournis, dans le M\u00caME ORDRE. Pour chacune, pourquoi ce crit\u00e8re compte pour la citation (une phrase) et l'action \u00e0 mener (une phrase op\u00e9rationnelle).",
    "- recos : exactement 6 actions d\u00e9duites des crit\u00e8res mesur\u00e9s les plus faibles. Les quatre premi\u00e8res corrigent les crit\u00e8res techniques et \u00e9ditoriaux mesur\u00e9s. Les deux derni\u00e8res portent sur la r\u00e9duction de la d\u00e9pendance aux plateformes, \u00e0 partir des mesures d'ind\u00e9pendance qui te sont fournies : capture d'adresses, espace compte, offre d'abonnement, notification directe. Formule-les en langage de responsable marketing ou produit, jamais en jargon SEO.",
    "- reecritures : exactement 3 passages reformul\u00e9s \u00e0 partir des extraits fournis. INTERDICTION ABSOLUE D'INVENTER UN FAIT. Tu n'ajoutes aucun chiffre, aucune date, aucun nom, aucune quantit\u00e9 qui ne figure pas d\u00e9j\u00e0 mot pour mot dans les extraits. Tu ne fais que r\u00e9organiser l'information existante : mettre la r\u00e9ponse en premi\u00e8re phrase, remplacer les mots de renvoi par le nom explicite de l'entit\u00e9, supprimer ce qui d\u00e9pend du contexte. Si un extrait ne contient aucune donn\u00e9e chiffr\u00e9e, tu n'en inventes pas : tu produis une reformulation sans chiffre et tu l'indiques dans le champ faiblesse. Attribuer au m\u00e9dia une statistique qu'il n'a pas publi\u00e9e est une faute grave. Chaque version fait 60 mots maximum. Le champ faiblesse explique en une phrase ce qui rendait le passage d'origine non citable.",
  ].join("\n");

  // --- Mesures reelles : robots.txt et pages du site, en parallele ---
  const [robots, site, llms] = await Promise.all([
    readRobots(url),
    lireSite(origin),
    getHTML(origin + "/llms.txt", 2000),
  ]);
  if (site && site.dispo) site.llmsTxt = !!(llms && llms.html && llms.html.length > 20);

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
  const calcPresse = site.dispo ? scorePresse(site) : null;
  const calcIndep = (site.dispo && site.audience) ? scoreIndependance(site.audience) : null;
  const malus = site.dispo ? calculMalus(site, robots) : { total: 0, liste: [] };

  if (calcAIO) {
    calcAIO.brut = calcAIO.score;
    calcAIO.malus = malus;
    calcAIO.score = Math.max(0, calcAIO.score - malus.total);
  }

  // Criteres consolides. On ne fait expliquer que les points perfectibles,
  // dedupliques, classes par nombre de points perdus, et limites a 6.
  const tous = [];
  if (calcAIO) calcAIO.detail.forEach(function (d) {
    tous.push({ nom: d.critere, perimetre: "Google AI Overview", etat: etatCritere(d.obtenu, d.max),
                constat: d.constat, obtenu: d.obtenu, max: d.max });
  });
  if (calcPresse) calcPresse.detail.forEach(function (d) {
    tous.push({ nom: d.critere, perimetre: "Autorite editoriale", etat: etatCritere(d.obtenu, d.max),
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
      if (compte[cle] > 1) c.perimetre = "Google et assistants IA";
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

  const indepBrief = calcIndep
    ? "MESURES D'INDEPENDANCE (ce que le media possede en propre, verifie sur son site) : " +
      calcIndep.detail.map(function (x) { return x.critere + " : " + x.constat; }).join(" ; ") +
      ". Score d'independance : " + calcIndep.score + " sur 100. "
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
    indepBrief +
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
    let resultat = assembler(brut, calcAIO, calcLLM, calcPresse, calcIndep, criteres, robots, site, hostFinal, redirige, mode);
    // Verification mecanique : aucune statistique inventee ne doit sortir d'ici.
    resultat = controler(resultat, site.dispo ? site.extraits : []);

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
