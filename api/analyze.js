const formidable = require("formidable");
const fs = require("fs");

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

  const form = formidable({ maxFileSize: 25 * 1024 * 1024, keepExtensions: true, uploadDir: "/tmp" });
  let fields, files;
  try {
    [fields, files] = await new Promise((resolve, reject) => {
      form.parse(req, (err, f, fi) => { if (err) reject(err); else resolve([f, fi]); });
    });
  } catch (e) {
    return res.status(400).json({ error: "Erreur parsing : " + e.message });
  }

  const audioArr = files.audio;
  const audioFile = Array.isArray(audioArr) ? audioArr[0] : audioArr;
  if (!audioFile) return res.status(400).json({ error: "Aucun fichier audio reçu." });
  const filePath = audioFile.filepath || audioFile.path;
  if (!filePath || !fs.existsSync(filePath)) return res.status(400).json({ error: "Fichier audio introuvable." });

  const agentName = String(Array.isArray(fields.agentName) ? fields.agentName[0] : fields.agentName || "Agent");
  const companyName = String(Array.isArray(fields.companyName) ? fields.companyName[0] : fields.companyName || "Prospect");
  const leadInfo = String(Array.isArray(fields.leadInfo) ? fields.leadInfo[0] : fields.leadInfo || "");

  // 1. Transcription Groq Whisper via fetch direct
  let transcript = "";
  try {
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = audioFile.originalFilename || audioFile.name || "audio.mp3";
    const FormData = (await import("node:stream")).default || require("stream");

    // Use native FormData with Blob
    const { FormData: FD } = await import("formdata-node");
    const fd = new FD();
    fd.append("file", new Blob([fileBuffer]), fileName);
    fd.append("model", "whisper-large-v3-turbo");
    fd.append("language", "fr");
    fd.append("response_format", "text");

    const groqRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${groqKey}` },
      body: fd,
    });

    if (!groqRes.ok) {
      const err = await groqRes.text();
      throw new Error(err);
    }
    transcript = await groqRes.text();
  } catch (e) {
    try { fs.unlinkSync(filePath); } catch (_) {}
    return res.status(500).json({ error: "Erreur Groq : " + e.message });
  }
  try { fs.unlinkSync(filePath); } catch (_) {}
  if (!transcript.trim()) return res.status(500).json({ error: "Transcription vide." });

  // 2. Analyse Claude via fetch direct
  try {
    const prompt = `Tu es un coach expert en cold call B2B pour Scalinity.\n\nTranscription — agent: ${agentName}, prospect: ${companyName}:\n---\n${transcript}\n---\n${leadInfo ? `\nInfos lead:\n${leadInfo}` : ""}\n\nRetourne UNIQUEMENT un JSON valide sans texte autour, sans backticks.\n\n{"transcript_formate":"avec AE: et Prospect:","resume":"3-4 phrases","points_positifs":["p1","p2","p3"],"points_amelioration":["p1","p2"],"objections":["o1"],"score_global":72,"score_accroche":65,"score_qualification":80,"score_conversion":55,"resultat":"visio bookée | rappel à planifier | pas intéressé | message vocal","recommandation":"conseil","duree":"durée"}`;

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
    if (!claudeRes.ok) throw new Error(claudeData.error?.message || "Erreur Claude");

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
