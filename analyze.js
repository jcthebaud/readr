// Fonction Netlify : appelle l'API Gemini cote serveur (la cle reste cachee ici).
// Recoit { url, topic }, renvoie le diagnostic en JSON propre.
// Modele par defaut : gemini-3.6-flash (niveau gratuit disponible sur Google AI Studio).

const MODEL = "gemini-3.6-flash";

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  // Diagnostic : cle absente = cause n1 des echecs (variable non ajoutee ou site non redeploye).
  if (!process.env.GEMINI_API_KEY) {
    return {
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        error: "Cle GEMINI_API_KEY absente. Ajoutez-la dans les variables d'environnement Netlify, puis relancez un deploiement (Deploys > Trigger deploy > Deploy site).",
      }),
    };
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { body = {}; }
  const url = (body.url || "").trim();
  const topic = (body.topic || "").trim();
  if (!url) return { statusCode: 400, body: JSON.stringify({ error: "url manquante" }) };

  const sys =
    "Tu es un analyste spécialiste de la visibilité dans les moteurs de réponse IA (Google AI Overview, AI Mode, ChatGPT, Perplexity, Gemini), orienté éditeurs de presse et médias. " +
    "Tu évalues un site à partir de son URL. Utilise la recherche web pour te renseigner sur le site si utile. " +
    "Réponds UNIQUEMENT avec un objet JSON valide, sans aucun texte avant ou après, sans balises markdown, en français avec les accents corrects. " +
    "N'utilise jamais de tiret cadratin ni de tiret demi-cadratin. " +
    'Format exact (garde les clés en minuscules sans accent, mets les accents dans les valeurs): {"site":"nom du domaine","requete":"une requête type qu\'un lecteur poserait dans le secteur","score":nombre entre 0 et 100,' +
    '"signaux":[{"nom":"Données structurées","etat":"fort|moyen|faible","note":"une phrase courte"},{"nom":"Clarté du contenu","etat":"...","note":"..."},{"nom":"Présence de données et chiffres","etat":"...","note":"..."},{"nom":"Signaux d\'auteur et d\'autorité","etat":"...","note":"..."},{"nom":"Fraîcheur","etat":"...","note":"..."}],' +
    '"apercuIA":"une réponse IA plausible de 2 a 3 phrases a la requête","citation":{"verdict":"probable|partielle|improbable","raison":"une phrase"},' +
    '"recos":["reco 1","reco 2","reco 3","reco 4","reco 5"]}. ' +
    "Les recos sont des actions concrètes de type GEO adaptées à un éditeur.";

  const userMsg =
    "URL a analyser: " + url + ". " +
    (topic ? "Secteur ou sujet principal: " + topic + ". " : "") +
    "Renvoie le JSON.";

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
        // Ancrage sur Google Search. Si Gemini renvoie une erreur liee a cet outil,
        // supprimez la ligne "tools" ci-dessous.
        tools: [{ google_search: {} }],
      }),
    });

    const json = await resp.json();

    // Diagnostic : si Gemini refuse, on renvoie son message exact (modele inconnu, cle invalide, etc.).
    if (!resp.ok) {
      const detail = json && json.error && json.error.message ? json.error.message : "HTTP " + resp.status;
      return {
        statusCode: 502,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "Erreur Gemini : " + detail }),
      };
    }

    const parts =
      (json.candidates &&
        json.candidates[0] &&
        json.candidates[0].content &&
        json.candidates[0].content.parts) || [];
    const text = parts.map(function (p) { return p.text || ""; }).join("\n").trim();

    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) {
      return {
        statusCode: 502,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "Reponse Gemini illisible (pas de JSON). Debut: " + text.slice(0, 160) }),
      };
    }

    const parsed = JSON.parse(text.slice(start, end + 1));
    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(parsed),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "Exception fonction : " + (e && e.message ? e.message : String(e)) }),
    };
  }
};
