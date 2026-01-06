// index.js — Pronunciation Backend (multipart/form-data) für Koyeb
// STRICT via Whisper-Transkript: Wenn targetText="Danke" und gesprochen wird "essen" -> strictOk=false -> overallScore=0
//
// v17.2: robustes Upload-Handling + Text-Normalisierung (Satzzeichen/Whitespace), damit "Danke." == "Danke" zählt.
// Whisper-Proxy(s) erwarten teils multipart-Feldname "file" statt "audio".
// -> Wir senden beim Whisper-Call zuerst "audio" und bei "MulterError: Unexpected field" automatisch "file".

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
  process.env.WHISPER_PROXY_URL ||
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
app.options("*", (_req, res) => res.sendStatus(204));

app.get("/", (_req, res) => {
  res.type("text/plain").send("pronounce-backend ok");
});

app.get("/health", (_req, res) => {
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
  // normalize for strict compare (single word / short phrase)
  // - lower
  // - normalize unicode
  // - remove punctuation (incl. trailing ".", "!" etc.)
  // - collapse whitespace
  return String(s || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ") // keep letters/numbers/spaces only
    .replace(/\s+/g, " ")
    .trim();
}

function asTextFromWhisperResponse(txt) {
  let j = null;
  try { j = JSON.parse(txt); } catch { j = null; }
  if (j && (j.text || j.transcript || j.result)) return String(j.text || j.transcript || j.result).trim();
  return String(txt || "").trim();
}

// Whisper call (multipart) – robust: try different field names
async function transcribeWithWhisper({ audioBuffer, filename, mimetype, language }) {
  async function tryField(fieldName) {
    const fd = new FormData();
    const blob = new Blob([audioBuffer], { type: mimetype || "application/octet-stream" });

    // Viele Proxies erwarten: fieldName="file" ODER "audio"
    fd.append(fieldName, blob, filename || "speech.webm");

    // Optional: Sprache (wenn dein Proxy es nutzt)
    if (language) fd.append("language", String(language));

    const r = await fetch(WHISPER_URL, { method: "POST", body: fd });
    const txt = await r.text();

    if (!r.ok) {
      const err = new Error(`Whisper HTTP ${r.status}: ${txt}`);
      err._raw = txt;
      err._status = r.status;
      throw err;
    }

    return asTextFromWhisperResponse(txt);
  }

  // 1) first try "audio"
  try {
    return await tryField("audio");
  } catch (e) {
    const raw = String(e?._raw || e?.message || "");
    // 2) if Multer "Unexpected field", try "file"
    if (raw.includes("MulterError: Unexpected field")) {
      return await tryField("file");
    }
    // 3) otherwise rethrow
    throw e;
  }
}

// Erwartet FormData:
// - targetText (string)
// - language (string)
// - audio (file)  -> Feldname bevorzugt "audio" (Frontend)
// Optional akzeptieren wir auch "file" (z. B. alternative Clients)
app.post(
  "/pronounce",
  upload.fields([
    { name: "audio", maxCount: 1 },
    { name: "file", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const clientSecret = String(req.headers["x-pronounce-secret"] || "");
      if (clientSecret !== PRONOUNCE_SECRET) {
        return res.status(401).json({ ok: false, error: "Unauthorized" });
      }

      const targetText = (req.body?.targetText || "").toString().trim();
      const language = (req.body?.language || "").toString().trim();

      const f1 = req.files?.audio?.[0];
      const f2 = req.files?.file?.[0];
      const file = f1 || f2;

      if (!targetText || !language || !file?.buffer) {
        return res.status(400).json({
          ok: false,
          error: "Missing fields",
          need: ["targetText", "language", "audio (file field name: audio)"],
          got: {
            targetText: !!targetText,
            language: !!language,
            audio: !!f1,
            file: !!f2,
          },
        });
      }

      const recognizedText = await transcribeWithWhisper({
        audioBuffer: file.buffer,
        filename: file.originalname || "speech.webm",
        mimetype: file.mimetype || "audio/webm",
        language,
      });

      const strictOk = norm(recognizedText) === norm(targetText);

      // Score: strikt. (Falsches Wort => 0)
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
          fieldname: file.fieldname,
        },
        details: { targetText, language },
        debug: { whisperUrl: WHISPER_URL },
      });
    } catch (err) {
      console.error("[pronounce-backend] /pronounce error:", err);
      return res.status(500).json({ ok: false, error: String(err?.message || "Server error") });
    }
  }
);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[pronounce-backend] listening on :${PORT} (mode=whisper_strict)`);
});
