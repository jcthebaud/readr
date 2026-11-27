// Transmet le lead à la feuille de calcul Google.
// Reçoit les deux scores, la thématique et l'état des robots.
// Reçoit aussi l'ouverture d'un rapport par un lien direct envoyé par Readr : aucune
// adresse n'est alors demandée, la ligne porte « Lien direct » et le code du lien.

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  let d;
  try { d = JSON.parse(event.body || "{}"); } catch (e) { d = {}; }

  const ouverture = d.ouverture === true;
  const ref = String(d.ref || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24);
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email || "");
  if (!ouverture && (!emailOk || !d.consent)) {
    return { statusCode: 400, body: JSON.stringify({ error: "Adresse ou consentement invalide." }) };
  }

  const nb = function (v) { return (v === 0 || v) ? v : ""; };

  try {
    await fetch(process.env.SHEET_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: ouverture ? "" : d.email,
        url: d.url || "",
        site: d.site || "",
        theme: ouverture ? ("Lien direct" + (ref ? " : " + ref : "")) : (d.theme || ""),
        scoreCitabilite: nb(d.scoreCitabilite),
        scoreAudience: nb(d.scoreAudience),
        // Anciens noms des deux scores : le script de la feuille Google encore en ligne
        // les attend sous ces cles, et laissait sinon les colonnes de score vides.
        scoreAio: nb(d.scoreCitabilite),
        scoreLlm: nb(d.scoreAudience),
        pagesLues: d.pagesLues || 0,
        robotsBloques: nb(d.robotsBloques),
        robotsTotal: nb(d.robotsTotal),
        // Ouverture d'un lien direct : aucun accord n'a été donné. La valeur est laissée vide,
        // car le script de la feuille écrit « oui » dès qu'elle est renseignée.
        consent: ouverture ? "" : (d.consent ? "oui" : "non"),
      }),
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: "Enregistrement impossible." }) };
  }
};
