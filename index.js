// index.js – Pronounce Backend (STRICT word match via Whisper transcription)
// Ziel: Wenn targetText="Danke" und gesprochen wird "essen" -> strictOk=false -> overallScore=0
// Notes:
// - Works with browser MediaRecorder formats (webm/ogg/mp4) because Whisper can transcribe them.
// - This is "strict word match" (exactness). If you later want phoneme-based pronunciation scoring,
//   you need Azure Pronunciation Assessment + audio conversion to PCM WAV.

import express from "express";
import cors from "cors";
import multer from "multer";

const app = express();
const PORT = Number(process.env.PORT || 8000);

// ---- Security ----
const PRONOUNCE_SECRET = process.env.PRONOUNCE_SECRET || "CHANGE_ME";

// ---- CORS allowlist (comma-separated). If empty => allow all (like before) ----
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").trim();

// ---- Whisper Proxy (your Koyeb service) ----
// Example: https://dramatic-roseline-contentconnect-academy-7daf9931.koyeb.app/whisper
const WHISPER_PROXY_URL = (process.env.WHISPER_PROXY_URL || "").trim();
// Optional secret if your whisper proxy expects one (leave empty if not used)
const WHISPER_PROXY_SECRET = (process.env.WHISPER_PROXY_SECRET || "").trim();

// ---- Upload: in-memory ----
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

// ---------- helpers ----------
function norm(s) {
  // Normalize for strict compare: lowercase, unicode normalize, remove punctuation, collapse spaces
  return String(s || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function gradeFrom(score) {
  const s = Number(score) || 0;
  if (s >= 85) return "excellent";
  if (s >= 75) return "good";
  if (s >= 65) return "needs_practice";
  return "poor";
}

function parseAllowedOrigins() {
  if (!ALLOWED_ORIGINS) return null;
  return ALLOWED_ORIGINS.split(",").map(s => s.trim()).filter(Boolean);
}

// ---------- CORS (must also succeed for preflight) ----------
app.use(cors({
  origin: (origin, cb) => {
    // origin can be undefined for same-origin or some tools
    if (!origin) return cb(null, true);
    const allowed = parseAllowedOrigins();
    if (!allowed) return cb(null, true);
    if (allowed.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  methods: ["POST", "OPTIONS", "GET"],
  allowedHeaders: ["Content-Type", "x-pronounce-secret", "x-whisper-secret"],
  credentials: false,
}));

// Always answer OPTIONS (preflight) with 204
app.options("*", (req, res) => res.sendStatus(204));

// ---------- Health ----------
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "pronounce-backend",
    mode: "whisper_strict_match",
    env: {
      hasPRONOUNCE_SECRET: !!PRONOUNCE_SECRET && PRONOUNCE_SECRET !== "CHANGE_ME",
      allowedOrigins: parseAllowedOrigins() || ["*"],
      hasWHISPER_PROXY_URL: !!WHISPER_PROXY_URL,
      whisperProxyHost: WHISPER_PROXY_URL ? (() => {
        try { return new URL(WHISPER_PROXY_URL).host; } catch { return null; }
      })() : null,
      hasWHISPER_PROXY_SECRET: !!WHISPER_PROXY_SECRET,
    }
  });
});

// ---------- Whisper transcription ----------
async function transcribeWithWhisperProxy({ audioBuffer, mimetype }) {
  if (!WHISPER_PROXY_URL) {
    throw new Error("Missing WHISPER_PROXY_URL env var");
  }

  // Node 18+ has fetch/FormData/Blob available (undici)
  const fd = new FormData();
  // Whisper proxies commonly expect: field name "audio"
  const blob = new Blob([audioBuffer], { type: mimetype || "application/octet-stream" });
  fd.append("audio", blob, "speech." + (guessExt(mimetype) || "bin"));

  const headers = {};
  if (WHISPER_PROXY_SECRET) headers["x-whisper-secret"] = WHISPER_PROXY_SECRET;

  const res = await fetch(WHISPER_PROXY_URL, {
    method: "POST",
    headers,
    body: fd,
  });

  const txt = await res.text();
  if (!res.ok) {
    throw new Error(`Whisper proxy HTTP ${res.status}: ${txt}`);
  }

  // Try JSON first, then fallback to plain text
  try {
    const j = JSON.parse(txt);
    // common shapes: {text:"..."} or {ok:true,text:"..."} or {transcript:"..."}
    return String(j.text || j.transcript || j.result || "").trim();
  } catch {
    return String(txt || "").trim();
  }
}

function guessExt(m) {
  const s = String(m || "").toLowerCase();
  if (s.includes("webm")) return "webm";
  if (s.includes("ogg")) return "ogg";
  if (s.includes("wav")) return "wav";
  if (s.includes("mpeg") || s.includes("mp3")) return "mp3";
  if (s.includes("mp4") || s.includes("aac")) return "m4a";
  return "";
}

// ---------- Route: /pronounce ----------
app.post("/pronounce", upload.single("audio"), async (req, res) => {
  try {
    const clientSecret = req.headers["x-pronounce-secret"];
    if (clientSecret !== PRONOUNCE_SECRET) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const targetText = (req.body?.targetText || "").toString().trim();
    const language = (req.body?.language || "").toString().trim(); // kept for compatibility
    const file = req.file;

    if (!targetText || !language || !file) {
      return res.status(400).json({
        ok: false,
        error: "Missing fields",
        need: ["targetText", "language", "audio (file field name: audio)"],
        got: { targetText: !!targetText, language: !!language, audio: !!file },
      });
    }

    const recognizedText = await transcribeWithWhisperProxy({
      audioBuffer: file.buffer,
      mimetype: file.mimetype,
    });

    // STRICT: must match the target word
    const strictOk = norm(recognizedText) === norm(targetText);

    // Score logic:
    // - exact word => 100
    // - else => 0
    const overallScore = strictOk ? 100 : 0;

    return res.json({
      ok: true,
      mode: "whisper_strict_match",
      grade: gradeFrom(overallScore),
      overallScore,

      strictOk,
      recognizedText,
      referenceText: targetText,

      file: {
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
      },

      details: { targetText, language },
    });
  } catch (err) {
    console.error("[pronounce-backend] /pronounce error:", err);
    res.status(500).json({ ok: false, error: String(err?.message || "Server error") });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[pronounce-backend] listening on :${PORT} (DEPLOY_v16_WHISPER_STRICT_MATCH)`);
});
