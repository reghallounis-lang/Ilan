const fs = require("fs");
const crypto = require("crypto");

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function extractBoundary(contentType) {
  const match = contentType.match(/boundary=([^\s;]+)/);
  return match ? match[1] : null;
}

function parseMultipartBody(body, boundary) {
  const parts = {};
  const sep = Buffer.from(`--${boundary}`);
  let start = 0;
  const segments = [];
  for (let i = 0; i <= body.length - sep.length; i++) {
    if (body.slice(i, i + sep.length).equals(sep)) {
      if (start > 0) segments.push(body.slice(start, i - 2));
      start = i + sep.length + 2;
    }
  }
  for (const seg of segments) {
    const headerEnd = seg.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headerStr = seg.slice(0, headerEnd).toString();
    const content = seg.slice(headerEnd + 4);
    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const fileMatch = headerStr.match(/filename="([^"]+)"/);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    if (fileMatch) {
      parts[name] = { filename: fileMatch[1], data: content };
    } else {
      parts[name] = content.toString().trim();
    }
  }
  return parts;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "x-anthropic-key, x-groq-key, Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const anthropicKey = req.headers["x-anthropic-key"] || "";
  const groqKey = req.headers["x-groq-key"] || "";
  if (!anthropicKey.startsWith("sk-ant")) return res.status(400).json({ error: "Clé Anthropic invalide" });
  if (!groqKey.startsWith("gsk_")) return res.status(400).json({ error: "Clé Groq invalide" });

  const contentType = req.headers["content-type"] || "";
  const boundary = extractBoundary(contentType);
  if (!boundary) return res.status(400).json({ error: "Content-Type multipart manquant" });

  let body;
  try { body = await parseMultipart(req); }
  catch (e) { return res.status(400).json({ error: "Erreur lecture body : " + e.message }); }

  const parts = parseMultipartBody(body, boundary);
  if (!parts.audio || !parts.audio.data) return res.status(400).json({ error: "Fichier audio manquant" });

  const agentName = parts.agentName || "Agent";
  const companyName = parts.companyName || "Prospect";
  const leadInfo = parts.leadInfo || "";
  const fileBuffer = parts.audio.data;
  const fileName = parts.audio.filename || "audio.mp3";

  // 1. Groq Whisper
  let transcript = "";
  try {
    const b2 = "----FormBoundary" + crypto.randomBytes(8).toString("hex");
    const CRLF = "\r\n";
    const groqBody = Buffer.concat([
      Buffer.from(`--${b2}${CRLF}Content-Disposition: form-data; name="file"; filename="${fileName}"${CRLF}Content-Type: audio/mpeg${CRLF}${CRLF}`),
      fileBuffer,
      Buffer.from(`${CRLF}--${b2}${CRLF}Content-Disposition: form-data; name="model"${CRLF}${CRLF}whisper-large-v3-turbo`),
      Buffer.from(`${CRLF}--${b2}${CRLF}Content-Disposition: form-data; name="language"${CRLF}${CRLF}fr`),
      Buffer.from(`${CRLF}--${b2}${CRLF}Content-Disposition: form-data; name="response_format"${CRLF}${CRLF}text`),
      Buffer.from(`${CRLF}--${b2}--${CRLF}`),
    ]);
    const groqRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${groqKey}`, "Content-Type": `multipart/form-data; boundary=${b2}` },
      body: groqBody,
    });
    const groqText = await groqRes.text();
    if (!groqRes.ok) return res.status(500).json({ error: "Erreur Groq : " + groqText });
    transcript = groqText;
  } catch (e) {
    return res.status(500).json({ error: "Erreur Groq : " + e.message });
  }

  if (!transcript.trim()) return res.status(500).json({ error: "Transcription vide." });

  // 2. Claude — deux appels séparés pour éviter les problèmes JSON

  // 2a. Recherche infos entreprise
  let companyInfo = { secteur: "NC", employes: "NC", chiffre_affaires: "NC", siret: "NC", site: "NC", adresse: "NC" };
  try {
    const infoRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        messages: [{ role: "user", content: `Donne-moi les informations publiques sur l'entreprise "${companyName}" en France. Retourne UNIQUEMENT ce JSON sans texte autour: {"secteur":"secteur activite","employes":"nb employes","chiffre_affaires":"CA ou NC","siret":"SIRET ou NC","site":"site web ou NC","adresse":"adresse ou NC"}` }],
      }),
    });
    const infoData = await infoRes.json();
    if (infoRes.ok) {
      const raw = infoData.content.map(c => c.text || "").join("").trim();
      const match = raw.match(/\{[\s\S]*?\}/);
      if (match) companyInfo = JSON.parse(match[0]);
    }
  } catch (e) { /* garde les valeurs NC par défaut */ }

  // 2b. Analyse de l'appel
  try {
    const prompt = `Tu es un assistant qui rédige des notes de prospection commerciale en français.

Transcription d'un appel — agent: ${agentName}, prospect chez: ${companyName}:
---
${transcript}
---
${leadInfo ? `Infos connues:\n${leadInfo}` : ""}

Retourne UNIQUEMENT ce JSON valide sans texte autour, sans backticks, sans commentaires:
{"resume":"J ai echange avec [prenom nom], [poste] au sein de [entreprise]. [Description detaillee de l appel, sujets abordes, informations collectees, interet exprime, suite donnee]","points_positifs":["point 1","point 2","point 3"],"points_amelioration":["etape 1","etape 2"],"objections":["objection 1"],"score_global":72,"score_accroche":65,"score_qualification":80,"score_conversion":55,"resultat":"visio bookee ou rappel a planifier ou pas interesse ou message vocal","recommandation":"interet et receptivite du prospect","duree":"duree estimee"}`;

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const claudeData = await claudeRes.json();
    if (!claudeRes.ok) return res.status(500).json({ error: "Erreur Claude : " + JSON.stringify(claudeData.error) });

    const raw = claudeData.content.map(c => c.text || "").join("").trim();
    const match = raw.match(/\{[\s\S]*\}/);
    const analysis = JSON.parse(match ? match[0] : raw);

    return res.status(200).json({
      transcript,
      analysis: { ...analysis, company_info: companyInfo },
      meta: { agentName, companyName, date: new Date().toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" }) },
    });
  } catch (e) {
    return res.status(500).json({ error: "Erreur Claude : " + e.message });
  }
};
