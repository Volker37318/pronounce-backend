// index.js – Pronunciation Backend (multipart/form-data) für Koyeb
// STRICT via Whisper-Transkript: Wenn targetText="Danke" und gesprochen wird "essen" -> strictOk=false -> overallScore=0

import express from "express";
import cors from "cors";
import multer from "multer";

const app = express();
const PORT = Number(process.env.PORT || 8000);

// Security
const PRONOUNCE_SECRET = process.env.PRONOUNCE_SECRET || "CHANGE_ME";

// CORS allowlist (Komma-separiert). Wenn leer -> "*" (wie bisher)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").trim();

// Whisper proxy (Koyeb service)
const WHISPER_URL =
  process.env.WHISPER_URL ||
  "https://dramatic-roseline-contentconnect-academy-7daf9931.koyeb.app/whisper";

// Upload: in-memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (!ALLOWED_ORIGINS) return cb(null, true);
      const allowed = ALLOWED_ORIGINS
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (allowed.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked"));
    },
    methods: ["POST", "OPTIONS", "GET"],
    allowedHeaders: ["Content-Type", "x-pronounce-secret"],
    credentials: false,
  })
);

// IMPORTANT: Preflight must always succeed
app.options("*", (req, res) => res.sendStatus(204));

app.get("/health", async (req, res) => {
  res.json({
    ok: true,
    service: "pronounce-backend",
    mode: "whisper_strict",
    whisperUrl: WHISPER_URL,
    allowedOrigins: ALLOWED_ORIGINS
      ? ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
      : ["*"],
  });
});

// ---------- helpers ----------
function norm(s) {
  // normalize for strict compare (single word)
  return String(s || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Whisper call (multipart)
async function transcribeWithWhisper({ audioBuffer, filename, mimetype, language }) {
  const fd = new FormData();

  // Viele Whisper-Proxies erwarten "audio". Manche "file".
  // Wir senden "audio" (wie dein Frontend) – das ist am wahrscheinlichsten.
  const blob = new Blob([audioBuffer], { type: mimetype || "application/octet-stream" });
  fd.append("audio", blob, filename || "speech.webm");

  // Optional: Sprache (wenn dein Proxy es nutzt)
  if (language) fd.append("language", String(language));

  const r = await fetch(WHISPER_URL, { method: "POST", body: fd });
  const txt = await r.text();

  let j = null;
  try { j = JSON.parse(txt); } catch { j = null; }

  if (!r.ok) {
    throw new Error(`Whisper HTTP ${r.status}: ${txt}`);
  }

  // Proxy-Formate: {text:"..."} oder {transcript:"..."} oder plain string
  const transcript =
    (j && (j.text || j.transcript || j.result)) ? String(j.text || j.transcript || j.result)
    : (typeof txt === "string" ? txt : "");

  return transcript.trim();
}

// Erwartet FormData:
// - targetText (string)
// - language (string)
// - audio (file)  -> Feldname MUSS "audio" heißen
app.post("/pronounce", upload.single("audio"), async (req, res) => {
  try {
    const clientSecret = req.headers["x-pronounce-secret"];
    if (clientSecret !== PRONOUNCE_SECRET) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
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

    const recognizedText = await transcribeWithWhisper({
      audioBuffer: file.buffer,
      filename: file.originalname || "speech.webm",
      mimetype: file.mimetype || "audio/webm",
      language,
    });

    const strictOk = norm(recognizedText) === norm(targetText);

    // Score: strikt. (Du willst: falsches Wort => 0)
    const overallScore = strictOk ? 100 : 0;

    return res.json({
      ok: true,
      mode: "whisper_strict",
      overallScore,
      grade: strictOk ? "good" : "poor",

      strictOk,
      recognizedText,
      referenceText: targetText,

      file: {
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
      },
      details: { targetText, language },
      debug: { whisperUrl: WHISPER_URL },
    });
  } catch (err) {
    console.error("[pronounce-backend] /pronounce error:", err);
    res.status(500).json({ ok: false, error: String(err?.message || "Server error") });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[pronounce-backend] listening on :${PORT} (DEPLOY_v17_WHISPER_STRICT_MATCH)`);
});
