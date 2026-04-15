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
  const sep = Buffer.from("--" + boundary);
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
  if (!anthropicKey.startsWith("sk-ant")) return res.status(400).json({ error: "Cle Anthropic invalide" });
  if (!groqKey.startsWith("gsk_")) return res.status(400).json({ error: "Cle Groq invalide" });

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
  const fileBuffer = parts.audio.data;
  const fileName = parts.audio.filename || "audio.mp3";

  // 1. Groq Whisper
  let transcript = "";
  try {
    const b2 = "----FormBoundary" + crypto.randomBytes(8).toString("hex");
    const CRLF = "\r\n";
    const groqBody = Buffer.concat([
      Buffer.from("--" + b2 + CRLF + "Content-Disposition: form-data; name=\"file\"; filename=\"" + fileName + "\"" + CRLF + "Content-Type: audio/mpeg" + CRLF + CRLF),
      fileBuffer,
      Buffer.from(CRLF + "--" + b2 + CRLF + "Content-Disposition: form-data; name=\"model\"" + CRLF + CRLF + "whisper-large-v3-turbo"),
      Buffer.from(CRLF + "--" + b2 + CRLF + "Content-Disposition: form-data; name=\"language\"" + CRLF + CRLF + "fr"),
      Buffer.from(CRLF + "--" + b2 + CRLF + "Content-Disposition: form-data; name=\"response_format\"" + CRLF + CRLF + "text"),
      Buffer.from(CRLF + "--" + b2 + "--" + CRLF),
    ]);
    const groqRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + groqKey, "Content-Type": "multipart/form-data; boundary=" + b2 },
      body: groqBody,
    });
    const groqText = await groqRes.text();
    if (!groqRes.ok) return res.status(500).json({ error: "Erreur Groq : " + groqText });
    transcript = groqText;
  } catch (e) {
    return res.status(500).json({ error: "Erreur Groq : " + e.message });
  }

  if (!transcript.trim()) return res.status(500).json({ error: "Transcription vide." });

  // 2. Claude
  try {
    const prompt = "Tu es un coach expert en cold call B2B, exigeant et direct. Tu ne complimentes pas pour rien. Si l'appel est moyen, tu le dis clairement.\n\nAnalyse cet appel passe par " + agentName + " aupres de " + companyName + ".\n\nTranscription:\n---\n" + transcript + "\n---\n\nRetourne UNIQUEMENT ce JSON valide sans texte autour, sans backticks:\n{\"resume\":\"resume detaille en 10 phrases minimum : qui a appele qui et dans quel contexte, comment s est deroule l echange, quelles questions ont ete posees, quelles informations ont ete collectees, comment le prospect a reagi, quels sujets ont ete abordes, comment s est conclue la conversation, quel est le niveau d interet du prospect\",\"bantp\":{\"budget\":\"OUI ou NON - explication\",\"authority\":\"OUI ou NON - explication\",\"need\":\"OUI ou NON - explication\",\"timeline\":\"OUI ou NON - explication\",\"problematique\":\"OUI ou NON - explication\"},\"ratio_parole\":{\"agent\":40,\"prospect\":60,\"analyse\":\"commentaire direct sur ce ratio\"},\"mots_parasites\":{\"liste\":[\"euh\",\"voila\",\"du coup\"],\"compte\":{\"euh\":3,\"voila\":5},\"analyse\":\"commentaire direct sur les mots parasites\"},\"score_global\":72,\"score_accroche\":65,\"score_qualification\":80,\"score_ecoute\":70,\"score_closing\":55,\"points_forts\":[\"uniquement ce qui etait vraiment bien fait\"],\"axes_amelioration\":[\"ce qui etait clairement rate\"],\"tips\":[\"conseil actionnable 1\",\"conseil actionnable 2\",\"conseil actionnable 3\"],\"moment_cle\":\"moment decisif et pourquoi\",\"objectif_prioritaire\":\"UNE SEULE chose precise que l agent doit travailler en priorite pour son prochain appel\",\"resultat\":\"visio bookee ou rappel a planifier ou pas interesse ou message vocal\",\"note_coach\":\"feedback direct et honnete sans complaisance en 2-3 phrases\",\"duree\":\"duree estimee\"}";

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
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
      analysis,
      meta: {
        agentName,
        companyName,
        date: new Date().toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" }),
      },
    });
  } catch (e) {
    return res.status(500).json({ error: "Erreur Claude : " + e.message });
  }
};
