const formidable = require("formidable");
const fs = require("fs");
const path = require("path");

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "x-anthropic-key, x-groq-key, Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const anthropicKey = req.headers["x-anthropic-key"] || "";
  const groqKey      = req.headers["x-groq-key"] || "";

  if (!anthropicKey.startsWith("sk-ant")) {
    return res.status(400).json({ error: "Clé Anthropic invalide (doit commencer par sk-ant)" });
  }
  if (!groqKey.startsWith("gsk_")) {
    return res.status(400).json({ error: "Clé Groq invalide (doit commencer par gsk_)" });
  }

  const form = formidable({ maxFileSize: 25 * 1024 * 1024, keepExtensions: true, uploadDir: "/tmp" });

  let fields, files;
  try {
    [fields, files] = await new Promise((resolve, reject) => {
      form.parse(req, (err, f, fi) => { if (err) reject(err); else resolve([f, fi]); });
    });
  } catch (e) {
    return res.status(400).json({ error: "Erreur parsing fichier : " + e.message });
  }

  const audioArr = files.audio;
  const audioFile = Array.isArray(audioArr) ? audioArr[0] : audioArr;
  if (!audioFile) return res.status(400).json({ error: "Aucun fichier audio reçu." });

  const filePath = audioFile.filepath || audioFile.path;
  if (!filePath || !fs.existsSync(filePath)) return res.status(400).json({ error: "Fichier audio introuvable." });

  const agentName   = String(Array.isArray(fields.agentName)   ? fields.agentName[0]   : fields.agentName   || "Agent");
  const companyName = String(Array.isArray(fields.companyName) ? fields.companyName[0] : fields.companyName || "Prospect");
  const leadInfo    = String(Array.isArray(fields.leadInfo)    ? fields.leadInfo[0]    : fields.leadInfo    || "");

  let transcript = "";
  try {
    const Groq = require("groq-sdk");
    const groq = new Groq.default({ apiKey: groqKey });
    const result = await groq.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "whisper-large-v3-turbo",
      language: "fr",
      response_format: "text",
    });
    transcript = typeof result === "string" ? result : (result.text || "");
  } catch (e) {
    try { fs.unlinkSync(filePath); } catch (_) {}
    return res.status(500).json({ error: "Erreur Groq : " + e.message });
  }
  try { fs.unlinkSync(filePath); } catch (_) {}
  if (!transcript.trim()) return res.status(500).json({ error: "Transcription vide." });

  try {
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic.default({ apiKey: anthropicKey });
    const prompt = `Tu es un coach expert en cold call B2B pour Scalinity.\n\nTranscription — agent: ${agentName}, prospect: ${companyName}:\n---\n${transcript}\n---\n${leadInfo ? `\nInfos lead:\n${leadInfo}` : ""}\n\nRetourne UNIQUEMENT un JSON valide sans texte autour.\n\n{"transcript_formate":"...","resume":"...","points_positifs":["..."],"points_amelioration":["..."],"objections":["..."],"score_global":72,"score_accroche":65,"score_qualification":80,"score_conversion":55,"resultat":"...","recommandation":"...","duree":"..."}`;

    const msg = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });
    const raw = msg.content.map(c => c.text || "").join("").trim();
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
