// Fonction Netlify : appelle l'API Gemini cote serveur (la cle reste cachee ici).
// Recoit { url, theme }, renvoie le diagnostic en JSON.
// Modele : gemini-3.5-flash-lite (couvert par le niveau gratuit Google AI Studio).

const MODEL = "gemini-3.5-flash-lite";

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
  const timer = setTimeout(function () { ctrl.abort(); }, 6000);
  try {
    const r = await fetch(origin + "/robots.txt", {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "user-agent": "ReadrDiagnostic/1.0 (+https://www.readr.agency)" },
    });
    clearTimeout(timer);
    if (!r.ok) return { dispo: false, raison: "robots.txt inaccessible (HTTP " + r.status + ")" };
    const txt = (await r.text()).slice(0, 200000);
    if (!/user-agent/i.test(txt)) return { dispo: false, raison: "robots.txt vide ou non standard" };

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
    return { dispo: false, raison: "robots.txt injoignable" };
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
        error: "Cle GEMINI_API_KEY absente. Ajoutez-la dans les variables Netlify puis relancez un deploiement.",
      }),
    };
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { body = {}; }
  const url = (body.url || "").trim();
  const theme = (body.theme || "").trim();
  if (!url) return { statusCode: 400, body: JSON.stringify({ error: "url manquante" }) };

  const sys = [
    "Tu es consultant senior en visibilite des contenus dans les moteurs de reponse IA.",
    "Tes interlocuteurs sont des directions marketing et produit de medias francais. Ils connaissent le SEO, l'audience, l'abonnement. Ils ne connaissent pas le jargon GEO.",
    "",
    "Tu distingues STRICTEMENT deux surfaces, qui ne fonctionnent pas de la meme maniere :",
    "1. AI OVERVIEW (Google) : la reponse generee au-dessus des resultats de recherche. Elle s'appuie sur l'index Google. Les leviers restent proches du SEO : indexation, structure, donnees structurees, autorite de la page, fraicheur. L'enjeu business est une PERTE de trafic existant, mesurable dans leurs outils.",
    "2. ASSISTANTS IA (ChatGPT, Perplexity, Gemini en application, Claude) : reponses hors moteur de recherche. Ils dependent de leurs propres crawlers, de leurs donnees d'entrainement et surtout des MENTIONS de la marque ailleurs sur le web (earned media, citations par des tiers, presence dans les sources de reference). L'enjeu business est une PRESENCE DE MARQUE sur une surface nouvelle, pas une perte de trafic.",
    "",
    "Point de vigilance important : de nombreux editeurs francais bloquent volontairement les crawlers IA (GPTBot, Google-Extended, PerplexityBot, ClaudeBot, CCBot) dans le cadre des negociations sur les droits voisins. Une absence dans les assistants peut donc etre un CHOIX STRATEGIQUE et non un defaut. Tu dois envisager cette hypothese et ne jamais presenter un blocage volontaire comme une erreur.",
    "",
    "REGLES DE REDACTION :",
    "- Francais professionnel, precis. Vouvoiement.",
    "- Interdiction absolue du tiret cadratin et du tiret demi-cadratin.",
    "- Pas de superlatifs marketing, pas de formules creuses.",
    "- Chaque constat doit etre concret.",
    "",
    "Reponds UNIQUEMENT par un objet JSON valide, sans texte avant ou apres, sans balises markdown.",
    "Les cles restent sans accent, les valeurs sont en francais correctement accentue.",
    "",
    "Structure exacte :",
    "{",
    '"site":"nom du media",',
    '"verdict":"une phrase de 18 mots maximum resumant la situation sur les deux surfaces",',
    '"aio":{',
    '  "score":nombre 0 a 100,',
    '  "enjeu":"2 phrases : ce que ce score implique pour leur trafic de recherche et leurs abonnements",',
    '  "requete":"une question reelle qu un lecteur taperait sur Google dans cette thematique",',
    '  "apercu":"la reponse que produirait un AI Overview a cette question, 3 phrases",',
    '  "citation":{"verdict":"probable|partielle|improbable","raison":"pourquoi ce media serait cite ou non, 1 phrase concrete"}',
    "},",
    '"llm":{',
    '  "score":nombre 0 a 100,',
    '  "enjeu":"2 phrases : ce que ce score implique pour leur presence de marque aupres des assistants",',
    '  "presence":"forte|partielle|faible",',
    '  "raison":"pourquoi la marque est citee ou non par les assistants, 1 phrase concrete",',
    '  "acces":{"etat":"ouvert|partiel|restreint|indetermine","note":"1 phrase sur l acces des crawlers IA, en envisageant l hypothese d un blocage volontaire lie aux droits voisins"}',
    "},",
    '"signaux":[',
    '  {"nom":"nom du critere","perimetre":"AI Overview|Assistants IA|Les deux","etat":"fort|moyen|faible","constat":"1 phrase factuelle","enjeu":"pourquoi cela compte, 1 phrase","action":"quoi faire precisement, 1 phrase"}',
    "],",
    '"recos":[',
    '  {"titre":"action en 6 mots maximum","perimetre":"AI Overview|Assistants IA|Les deux","detail":"comment la mettre en oeuvre, 2 phrases","impact":"fort|moyen","delai":"court terme|moyen terme","responsable":"Redaction|Technique|Marketing|Produit"}',
    "]",
    "}",
    "",
    "Contraintes :",
    "- signaux : exactement 6 entrees. Trois qui concernent surtout AI Overview (structure et lisibilite machine, donnees et chiffres cites, fraicheur et mise a jour). Trois qui concernent surtout les assistants (autorite et signature, mentions de la marque hors de votre site, profondeur thematique).",
    "- recos : exactement 6 entrees, de la plus prioritaire a la moins prioritaire, avec un equilibre entre les deux surfaces.",
    "- Les recommandations doivent etre applicables par une redaction ou une equipe produit de media.",
  ].join("\n");

  const robots = await readRobots(url);

  let robotsBrief;
  if (!robots.dispo) {
    robotsBrief = "Acces des robots IA : non verifiable (" + (robots.raison || "inconnu") + "). Reste prudent, n'affirme rien.";
  } else if (robots.nbBloques === 0) {
    robotsBrief = "Acces des robots IA (verifie dans le robots.txt) : aucun des " + robots.nbTotal +
      " robots IA courants n'est bloque. L'acces est ouvert.";
  } else {
    robotsBrief = "Acces des robots IA (verifie dans le robots.txt) : " + robots.nbBloques + " robots sur " +
      robots.nbTotal + " sont bloques, a savoir " + robots.listeBloques.join(", ") +
      ". Ce blocage est tres probablement volontaire (strategie droits voisins ou negociation de licence), " +
      "donc traite-le comme une decision a arbitrer et jamais comme une erreur technique.";
  }

  const userMsg =
    "Site a analyser : " + url + ". " +
    (theme ? "Thematique principale : " + theme + ". " : "") +
    robotsBrief + " " +
    "Dans llm.acces, reprends fidelement ce constat verifie sans le contredire. " +
    "Produis le diagnostic au format JSON demande.";

  try {
    const endpoint =
      "https://generativelanguage.googleapis.com/v1beta/models/" + MODEL + ":generateContent";

    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: sys }] },
        contents: [{ role: "user", parts: [{ text: userMsg }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 4096 },
        // Ancrage Google Search retire : il demande la facturation activee.
        // Pour le reactiver plus tard (niveau payant), ajoutez ici :
        // tools: [{ google_search: {} }],
      }),
    });

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
        body: JSON.stringify({ error: "Reponse illisible. Debut : " + text.slice(0, 160) }),
      };
    }

    const parsed = JSON.parse(text.slice(start, end + 1));
    parsed.robots = robots;

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
