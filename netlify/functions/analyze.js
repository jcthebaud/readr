// Fonction Netlify : appelle l'API Gemini cote serveur (la cle reste cachee ici).
// Recoit { url, theme }, renvoie le diagnostic en JSON.
// Modele : gemini-3.5-flash-lite (couvert par le niveau gratuit Google AI Studio).

const MODEL = "gemini-3.5-flash-lite";

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
    "Tu es consultant senior en visibilite des contenus dans les moteurs de reponse IA (Google AI Overview et AI Mode, ChatGPT, Perplexity, Gemini).",
    "Tes interlocuteurs sont des directions marketing et produit de medias francais. Ils connaissent le SEO, l'audience, l'abonnement, le tunnel de conversion. Ils ne connaissent pas le jargon GEO.",
    "Tu analyses un site a partir de son URL et de sa thematique.",
    "",
    "REGLES DE REDACTION :",
    "- Francais professionnel, precis, sans jargon inutile. Vouvoiement.",
    "- Chaque phrase doit apporter une information. Pas de generalites, pas de remplissage.",
    "- Interdiction absolue du tiret cadratin et du tiret demi-cadratin. Utilise virgules, deux-points ou parentheses.",
    "- Pas de superlatifs marketing, pas de formules creuses du type revolution ou incontournable.",
    "- Chaque constat doit etre chiffre ou concret quand c'est possible.",
    "",
    "Reponds UNIQUEMENT par un objet JSON valide, sans texte avant ou apres, sans balises markdown.",
    "Les cles restent sans accent, les valeurs sont redigees en francais correctement accentue.",
    "",
    "Structure exacte :",
    "{",
    '"site":"nom du media",',
    '"score":nombre entre 0 et 100,',
    '"verdict":"une phrase de 15 mots maximum qui resume la situation",',
    '"enjeu":"2 phrases expliquant ce que ce score implique concretement pour leur trafic et leurs abonnements",',
    '"requete":"une question reelle qu un lecteur taperait sur ce sujet",',
    '"apercuIA":"la reponse que produirait une IA a cette question, 3 phrases, redigee comme un vrai AI Overview",',
    '"citation":{"verdict":"probable|partielle|improbable","raison":"pourquoi ce media serait cite ou non, 1 phrase concrete"},',
    '"signaux":[',
    '  {"nom":"nom du critere","etat":"fort|moyen|faible","constat":"ce qui est observe, 1 phrase factuelle","enjeu":"pourquoi cela compte pour la citation IA, 1 phrase","action":"quoi faire precisement, 1 phrase operationnelle"}',
    "],",
    '"recos":[',
    '  {"titre":"action en 6 mots maximum","detail":"comment la mettre en oeuvre concretement, 2 phrases","impact":"fort|moyen","delai":"court terme|moyen terme","responsable":"Redaction|Technique|Marketing|Produit"}',
    "]",
    "}",
    "",
    "Contraintes de contenu :",
    "- signaux : exactement 5 entrees. Utilise ces criteres : Structure et lisibilite machine, Donnees et chiffres cites, Autorite et signature des articles, Fraicheur et mise a jour, Profondeur thematique.",
    "- recos : exactement 6 entrees, classees de la plus prioritaire a la moins prioritaire.",
    "- Les recommandations doivent etre applicables par une redaction ou une equipe produit de media, pas par un expert technique isole.",
  ].join("\n");

  const userMsg =
    "Site a analyser : " + url + ". " +
    (theme ? "Thematique principale : " + theme + ". " : "") +
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
