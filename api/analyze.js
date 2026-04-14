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
  if (!boundary) re
