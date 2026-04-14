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

  // 2. Claude — analyse + recherche infos entreprise en ligne
  try {
    const prompt = `Tu es un assistant qui rédige des notes de prospection commerciale professionnelles en français.

Transcription d'un appel commercial — agent: ${agentName}, prospect chez: ${companyName}:
---
${transcript}
---
${leadInfo ? `\nInfos lead connues:\n${leadInfo}` : ""}

Fais deux choses :

1. Recherche des informations publiques sur l'entreprise "${companyName}" (secteur d'activité, nombre d'employés, chiffre d'affaires, adresse, SIRET si disponible, site web). Utilise tes connaissances et ce qui est mentionné dans la transcription.

2. Rédige l'analyse de l'appel.

Règles pour le resume :
- Écrit à la première personne du singulier comme si l'agent rédigeait ses notes : "J'ai échangé avec Monsieur/Madame [prénom nom], [poste] au sein de [entreprise]..."
- Expliquer concrètement de quoi ils ont parlé, ce qui a été dit, les sujets abordés, l'intérêt exprimé, les informations collectées, la suite donnée

Retourne UNIQUEMENT un JSON valide sans texte autour, sans backticks :

{"company_info":{"secteur":"secteur d'activité trouvé","employes":"nombre d'employés","chiffre_affaires":"CA estimé ou NC","adresse":"adresse si trouvée ou NC","siret":"SIRET si trouvé ou NC","site":"site web si trouvé ou NC"},"transcript_formate":"avec AE: et Prospect: sur chaque ligne","resume":"J'ai échangé avec [prénom nom], [poste] au sein de [entreprise]. [Description détaillée de l'appel...]","points_positifs":["point 1","point 2","point 3"],"points_amelioration":["prochaine étape 1","prochaine étape 2"],"objections":["objection 1"],"score_global":72,"score_accroche":65,"score_qualification":80,"score_conversion":55,"resultat":"visio bookée | rappel à planifier | pas intéressé | message vocal","recommandation":"intérêt et réceptivité du prospect","duree":"durée estimée"}`;

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2500,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const claudeData = await claudeRes.json();
    if (!claudeRes.ok) return res.status(500).json({ error: "Erreur Claude : " + JSON.stringify(claudeData.error) });

    const raw = claudeData.content.map(c => c.text || "").join("").trim();
    const match = raw.match(/\{[\s\S]*\}/);
    const analysis = JSON.parse(match ? match[0] : raw);

    return res.status(200).json({
      transcript, analysis,
      meta: { agentName, companyName, date: new Date().toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" }) },
    });
  } catch (e) {
    return res.status(500).json({ error: "Erreur Claude : " + e.message });
  }
};
