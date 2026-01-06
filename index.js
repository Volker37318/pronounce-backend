// index.js — pronounce-backend STRICT v16 (Whisper transcript → exact word match)
// Node >= 18 (ESM). Buildpack friendly.

import express from "express";
import cors from "cors";
import multer from "multer";

const app = express();
const PORT = Number(process.env.PORT || 8000);

// ---- Security ----
const PRONOUNCE_SECRET = (process.env.PRONOUNCE_SECRET || "CHANGE_ME").trim();

// ---- CORS allowlist (comma-separated). If empty => allow all. ----
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").trim();

// ---- Whisper proxy (required) ----
// Must be FULL route, e.g. https://<service>.koyeb.app/whisper
const WHISPER_PROXY_URL = (process.env.WHISPER_PROXY_URL || "").trim();

// ---- Upload ----
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

// ---- Helpers ----
function allowedOrigin(origin) {
  if (!origin) return true;                 // server-to-server, curl, same-origin etc.
  if (!ALLOWED_ORIGINS) return true;        // allow all
  const allowed = ALLOWED_ORIGINS.split(",").map(s => s.trim()).filter(Boolean);
  return allowed.includes(origin);
}

function normWord(s) {
  // Strict-ish: lower, trim, collapse spaces, strip punctuation.
  // German specific: keep umlauts; also normalize ß <-> ss by mapping to same form.
  const t = String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[“”„"']/g, "")
    .replace(/[\.,;:!?()\[\]{}<>]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/ß/g, "ss");
  return t;
}

function transcriptToTokens(text) {
  const t = normWord(text);
  if (!t) return [];
  return t.split(" ").filter(Boolean);
}

function exactWordMatch(targetWord, transcriptText) {
  const target = normWord(targetWord);
  const tokens = transcriptToTokens(transcriptText);

  // Exact match if ANY token equals target OR transcript equals target exactly
  if (!target) return { ok: false, reason: "empty-target", transcript: transcriptText || "" };
  if (!transcriptText) return { ok: false, reason: "empty-transcript", transcript: "" };

  const full = normWord(transcriptText);
  const hit = (full === target) || tokens.includes(target);

  return { ok: hit, transcript: transcriptText, tokens };
}

// ---- CORS ----
app.use(
  cors({
    origin: (origin, cb) => {
      if (allowedOrigin(origin)) return cb(null, true);
      return cb(new Error("CORS blocked"));
    },
    methods: ["POST", "OPTIONS", "GET"],
    allowedHeaders: ["Content-Type", "x-pronounce-secret"],
    credentials: false,
  })
);

// IMPORTANT: explicit OPTIONS handler (preflight)
app.options("*", (req, res) => {
  // If cors() rejected earlier, Express won't reach here. For allowed origins, return 204.
  res.sendStatus(204);
});

// ---- Health ----
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "pronounce-backend",
    marker: "DEPLOY_v16_WHISPER_STRICT",
    env: {
      hasPRONOUNCE_SECRET: !!PRONOUNCE_SECRET && PRONOUNCE_SECRET !== "CHANGE_ME",
      hasWHISPER_PROXY_URL: !!WHISPER_PROXY_URL,
      allowedOrigins: ALLOWED_ORIGINS ? ALLOWED_ORIGINS.split(",").map(s => s.trim()).filter(Boolean) : ["*"],
    }
  });
});

// ---- Core route ----
// Expects multipart/form-data:
// - targetText (string)  [e.g. "Danke"]
// - language (string)    [e.g. "de-DE"]  (passed through to whisper proxy; depends on your proxy)
// - audio (file)         field name MUST be "audio"
app.post("/pronounce", upload.single("audio"), async (req, res) => {
  try {
    // Secret check
    const clientSecret = req.headers["x-pronounce-secret"];
    if (String(clientSecret || "") !== PRONOUNCE_SECRET) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    if (!WHISPER_PROXY_URL) {
      return res.status(500).json({ ok: false, error: "Missing WHISPER_PROXY_URL env var" });
    }

    const targetText = (req.body?.targetText || "").toString().trim();
    const language = (req.body?.language || "").toString().trim();
    const file = req.file;

    if (!targetText || !language || !file) {
      return res.status(400).json({
        ok: false,
        error: "Missing fields",
        need: ["targetText", "language", "audio (file field name: audio)"],
        got: { targetText: !!targetText, language: !!language, audio: !!file },
      });
    }

    // ---- Call Whisper proxy (your existing service) ----
    // We send multipart with field name "audio" (common for whisper proxies).
    const fd = new FormData();
    fd.append("language", language);
    // Many whisper proxies accept "model" or others; keep minimal.
    const blob = new Blob([file.buffer], { type: file.mimetype || "application/octet-stream" });
    fd.append("audio", blob, file.originalname || "speech.webm");

    const wRes = await fetch(WHISPER_PROXY_URL, { method: "POST", body: fd });
    const wTxt = await wRes.text();
    let wJson = null;
    try { wJson = JSON.parse(wTxt); } catch { wJson = null; }

    if (!wRes.ok) {
      return res.status(502).json({
        ok: false,
        error: "Whisper proxy failed",
        status: wRes.status,
        raw: wTxt?.slice(0, 800),
      });
    }

    // Whisper proxy response shape varies; try common fields.
    const transcript =
      (wJson && (wJson.text || wJson.transcript || wJson.result || wJson.data?.text)) ||
      (typeof wTxt === "string" ? wTxt : "");

    const m = exactWordMatch(targetText, transcript);
    const overallScore = m.ok ? 100 : 0;
    const grade = m.ok ? "good" : "poor";

    return res.json({
      ok: true,
      mode: "whisper_strict",
      overallScore,
      grade,
      transcript: m.transcript || "",
      tokens: m.tokens || [],
      targetText,
      language,
      file: {
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
      },
    });
  } catch (err) {
    console.error("[pronounce-backend] /pronounce error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[pronounce-backend] listening on :${PORT} (DEPLOY_v16_WHISPER_STRICT)`);
});
