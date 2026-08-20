// Transmet le lead à la feuille de calcul Google.
// Reçoit les deux scores, la thématique et l'état des robots.

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  let d;
  try { d = JSON.parse(event.body || "{}"); } catch (e) { d = {}; }

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email || "");
  if (!emailOk || !d.consent) {
    return { statusCode: 400, body: JSON.stringify({ error: "Adresse ou consentement invalide." }) };
  }

  const nb = function (v) { return (v === 0 || v) ? v : ""; };

  try {
    await fetch(process.env.SHEET_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: d.email,
        url: d.url || "",
        site: d.site || "",
        theme: d.theme || "",
        scoreCitabilite: nb(d.scoreCitabilite),
        scoreAudience: nb(d.scoreAudience),
        pagesLues: d.pagesLues || 0,
        robotsBloques: nb(d.robotsBloques),
        robotsTotal: nb(d.robotsTotal),
        consent: d.consent ? "oui" : "non",
      }),
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: "Enregistrement impossible." }) };
  }
};
