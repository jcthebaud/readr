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
        score: { type: "INTEGER" },
        enjeu: { type: "STRING" },
        requete: { type: "STRING" },
        apercu: { type: "STRING" },
        citation: {
          type: "OBJECT",
          properties: {
            verdict: { type: "STRING", enum: ["probable", "partielle", "improbable"] },
            raison: { type: "STRING" },
          },
          required: ["verdict", "raison"],
        },
      },
      required: ["score", "enjeu", "requete", "apercu", "citation"],
    },
    llm: {
      type: "OBJECT",
      properties: {
        score: { type: "INTEGER" },
        enjeu: { type: "STRING" },
        presence: { type: "STRING", enum: ["forte", "partielle", "faible"] },
        raison: { type: "STRING" },
        acces: {
          type: "OBJECT",
          properties: {
            etat: { type: "STRING", enum: ["ouvert", "partiel", "restreint", "indetermine"] },
            note: { type: "STRING" },
          },
          required: ["etat", "note"],
        },
      },
      required: ["score", "enjeu", "presence", "raison", "acces"],
    },
    signaux: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          nom: { type: "STRING" },
          perimetre: { type: "STRING", enum: ["Google AI Overview", "Assistants IA", "Les deux"] },
          etat: { type: "STRING", enum: ["fort", "moyen", "faible"] },
          constat: { type: "STRING" },
          enjeu: { type: "STRING" },
          action: { type: "STRING" },
        },
        required: ["nom", "perimetre", "etat", "constat", "enjeu", "action"],
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
  required: ["site", "verdict", "aio", "llm", "signaux", "recos"],
};

// --------- Filet de securite : rattrape une reponse mal formee ---------
function normalise(d) {
  if (!d || typeof d !== "object") return null;
  d.aio = d.aio || {};
  d.llm = d.llm || {};
  // ancien format a plat : un score unique au premier niveau
  if (typeof d.aio.score !== "number" && typeof d.score === "number") d.aio.score = d.score;
  if (typeof d.llm.score !== "number" && typeof d.score === "number") d.llm.score = d.score;
  if (typeof d.aio.requete !== "string" && typeof d.requete === "string") d.aio.requete = d.requete;
  if (typeof d.aio.apercu !== "string" && typeof d.apercuIA === "string") d.aio.apercu = d.apercuIA;
  if (!d.aio.citation && d.citation) d.aio.citation = d.citation;
  if (typeof d.aio.enjeu !== "string" && typeof d.enjeu === "string") d.aio.enjeu = d.enjeu;
  d.llm.acces = d.llm.acces || { etat: "indetermine", note: "" };
  d.signaux = Array.isArray(d.signaux) ? d.signaux : [];
  d.recos = Array.isArray(d.recos) ? d.recos : [];
  // un diagnostic sans aucun score exploitable n'est pas affichable
  if (typeof d.aio.score !== "number" && typeof d.llm.score !== "number") return null;
  return d;
}


// --------- Validation du domaine ---------
// Rejette les saisies qui ne sont pas des noms de domaine (ex : "challenges").
function domaineValide(host) {
  if (!host) return false;
  if (host.length > 253) return false;
  // au moins un point, des libelles valides, une extension de 2 a 24 lettres
  return /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*\.[a-z]{2,24}$/i.test(host);
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
      body: JSON.stringify({ error: "Adresse invalide. Indiquez un domaine complet, par exemple challenges.fr" }),
    };
  }
  if (!domaineValide(host)) {
    return {
      statusCode: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "Adresse incompl\u00e8te. Indiquez le domaine avec son extension, par exemple challenges.fr" }),
    };
  }



  const sys = [
    "Tu es consultant senior en visibilit\u00e9 des contenus dans les moteurs de r\u00e9ponse IA.",
    "Tes interlocuteurs sont des directions marketing et produit de m\u00e9dias fran\u00e7ais. Ils connaissent le SEO, l'audience, l'abonnement. Ils ne connaissent pas le jargon GEO.",
    "",
    "Tu distingues STRICTEMENT deux environnements, qui ne fonctionnent pas de la m\u00eame mani\u00e8re :",
    "1. GOOGLE AI OVERVIEW : le r\u00e9sum\u00e9 g\u00e9n\u00e9r\u00e9 au-dessus des r\u00e9sultats de recherche. Il s'appuie sur l'index Google. Les leviers restent proches du SEO : indexation, structure, donn\u00e9es structur\u00e9es, autorit\u00e9 de la page, fra\u00eecheur. L'enjeu business est une PERTE de trafic existant, mesurable dans leurs outils.",
    "2. ASSISTANTS IA (ChatGPT, Perplexity, Gemini en application, Claude) : r\u00e9ponses hors moteur de recherche. Ils d\u00e9pendent de leurs propres robots, de leurs donn\u00e9es d'entra\u00eenement et surtout des MENTIONS de la marque ailleurs sur le web (earned media, citations par des tiers, pr\u00e9sence dans les sources de r\u00e9f\u00e9rence). L'enjeu business est une PR\u00c9SENCE DE MARQUE sur un espace nouveau, pas une perte de trafic.",
    "",
    "Point de vigilance important : de nombreux \u00e9diteurs fran\u00e7ais bloquent volontairement les robots IA (GPTBot, Google-Extended, PerplexityBot, ClaudeBot, CCBot) dans le cadre des n\u00e9gociations sur les droits voisins. Une absence dans les assistants peut donc \u00eatre un CHOIX STRAT\u00c9GIQUE et non un d\u00e9faut. Tu dois envisager cette hypoth\u00e8se et ne jamais pr\u00e9senter un blocage volontaire comme une erreur.",
    "",
    "R\u00c8GLES DE R\u00c9DACTION, \u00e0 respecter imp\u00e9rativement :",
    "- R\u00e9dige en fran\u00e7ais soutenu et professionnel, avec TOUS les accents correctement plac\u00e9s : \u00e9, \u00e8, \u00ea, \u00e0, \u00f9, \u00e7, \u00ee, \u00f4. Un texte sans accents est consid\u00e9r\u00e9 comme une r\u00e9ponse invalide.",
    "- Vouvoiement syst\u00e9matique.",
    "- Interdiction absolue du tiret cadratin et du tiret demi-cadratin. Utilise la virgule, les deux-points ou les parenth\u00e8ses.",
    "- Pas de superlatifs marketing, pas de formules creuses du type r\u00e9volution ou incontournable.",
    "- Chaque constat doit \u00eatre concret et v\u00e9rifiable.",
    "",
    "Structure des contenus attendus :",
    "- signaux : exactement 6 entr\u00e9es. Trois qui concernent surtout Google AI Overview (structure et lisibilit\u00e9 machine, donn\u00e9es et chiffres cit\u00e9s, fra\u00eecheur et mise \u00e0 jour). Trois qui concernent surtout les assistants (autorit\u00e9 et signature, mentions de la marque hors de votre site, profondeur th\u00e9matique).",
    "- recos : exactement 6 entr\u00e9es, de la plus prioritaire \u00e0 la moins prioritaire, avec un \u00e9quilibre entre les deux environnements.",
    "- Les recommandations doivent \u00eatre applicables par une r\u00e9daction ou une \u00e9quipe produit de m\u00e9dia, pas par un expert technique isol\u00e9.",
    "- verdict : une phrase de 18 mots maximum r\u00e9sumant la situation sur les deux environnements.",
    "- aio.enjeu et llm.enjeu : deux phrases chacun, exprim\u00e9es en trafic, audience et abonnement.",
    "- aio.requete : une question r\u00e9elle qu'un lecteur taperait sur Google dans cette th\u00e9matique.",
    "- aio.apercu : la r\u00e9ponse que produirait un AI Overview \u00e0 cette question, en trois phrases.",
  ].join("\n");

  // Une seule requete sortante : elle verifie l'existence du domaine ET lit le robots.txt.
  const robots = await readRobots(url);
  if (robots.joignable === false) {
    return {
      statusCode: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "Ce domaine est introuvable. V\u00e9rifiez l'adresse saisie." }),
    };
  }

  let robotsBrief;
  if (!robots.dispo) {
    robotsBrief = "Acc\u00e8s des robots IA : non v\u00e9rifiable (" + (robots.raison || "inconnu") + "). Reste prudent, n'affirme rien sur ce point.";
  } else if (robots.nbBloques === 0) {
    robotsBrief = "Acc\u00e8s des robots IA (v\u00e9rifi\u00e9 dans le fichier robots.txt) : aucun des " + robots.nbTotal +
      " robots IA courants n'est bloqu\u00e9. L'acc\u00e8s est ouvert.";
  } else {
    robotsBrief = "Acc\u00e8s des robots IA (v\u00e9rifi\u00e9 dans le fichier robots.txt) : " + robots.nbBloques + " robots sur " +
      robots.nbTotal + " sont bloqu\u00e9s, \u00e0 savoir " + robots.listeBloques.join(", ") +
      ". Ce blocage est tr\u00e8s probablement volontaire (strat\u00e9gie de droits voisins ou n\u00e9gociation de licence), " +
      "donc traite-le comme une d\u00e9cision \u00e0 arbitrer et jamais comme une erreur technique.";
  }

  const userMsg =
    "Site \u00e0 analyser : " + url + ". " +
    (theme ? "Th\u00e9matique principale : " + theme + ". " : "") +
    robotsBrief + " " +
    "Dans llm.acces, reprends fid\u00e8lement ce constat v\u00e9rifi\u00e9 sans le contredire. " +
    "R\u00e9dige l'int\u00e9gralit\u00e9 du diagnostic en fran\u00e7ais correctement accentu\u00e9.";

  try {
    const endpoint =
      "https://generativelanguage.googleapis.com/v1beta/models/" + MODEL + ":generateContent";

    // Trois tentatives, de la plus riche a la plus sure :
    //  1. ancrage web active (le modele lit reellement le site)  -> necessite la facturation
    //  2. schema strict (format garanti, mais sans lecture du site)
    //  3. appel simple (dernier recours)
    // Gemini n'accepte pas l'ancrage et le schema simultanement, d'ou la cascade.
    async function callGemini(mode) {
      const gen = { temperature: 0.7, maxOutputTokens: 8192 };
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

    // Si un mode fonctionnel est deja connu, on l'utilise directement : un seul appel.
    let mode, resp;
    if (MODE_RETENU) {
      mode = MODE_RETENU;
      resp = await callGemini(mode);
      if (!resp.ok) { MODE_RETENU = null; }   // le mode memorise ne marche plus, on repart en cascade
    }
    if (!resp || !resp.ok) {
      mode = "ancre";
      resp = await callGemini("ancre");
      if (!resp.ok) { mode = "schema"; resp = await callGemini("schema"); }
      if (!resp.ok) { mode = "simple"; resp = await callGemini("simple"); }
      if (resp.ok) MODE_RETENU = mode;
    }

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

    const parsed = normalise(JSON.parse(text.slice(start, end + 1)));
    if (!parsed) {
      return {
        statusCode: 502,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "Le diagnostic est revenu incomplet. Relancez l'analyse." }),
      };
    }
    parsed.robots = robots;
    parsed.mode = mode;

    return {
      statusCode: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(parsed),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "Exception : " + (e && e.message ? e.message : String(e)) }),
    };
  }
};
