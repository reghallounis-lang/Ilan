const { formidable } = require("formidable");
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
  const leadInfo
