// Fonction Netlify : envoie le lead dans le Google Sheet (via l'URL du script Google).
// Recoit { email, url, site, score, consent }.

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let d;
  try { d = JSON.parse(event.body || "{}"); } catch (e) { d = {}; }

  // Garde-fou minimal : email plausible et consentement requis.
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email || "");
  if (!emailOk || !d.consent) {
    return { statusCode: 400, body: JSON.stringify({ error: "email ou consentement invalide" }) };
  }

  try {
    await fetch(process.env.SHEET_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: d.email,
        url: d.url || "",
        site: d.site || "",
        score: d.score || "",
        consent: d.consent ? "oui" : "non",
      }),
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: "enregistrement impossible" }) };
  }
};
