// index.js – Pronunciation Backend (multipart/form-data) für Koyeb
// FIX: echte Aussprachebewertung über Azure + "STRICT word match"
// Ergebnis: Wenn targetText="Danke" und gesprochen wird "essen" -> strictOk=false -> overallScore=0

import express from "express";
import cors from "cors";
import multer from "multer";
import sdk from "microsoft-cognitiveservices-speech-sdk";

const app = express();
const PORT = Number(process.env.PORT || 8000);

// Security
const PRONOUNCE_SECRET = process.env.PRONOUNCE_SECRET || "CHANGE_ME";

// Azure Speech
const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY || "";
const AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION || "";

// CORS allowlist (Komma-separiert). Wenn leer -> "*" (wie bisher)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").trim();

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
      const allowed = ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
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

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "pronounce-backend",
    env: {
      hasAZURE_SPEECH_KEY: !!AZURE_SPEECH_KEY,
      azureRegion: AZURE_SPEECH_REGION || null,
      hasPRONOUNCE_SECRET: !!PRONOUNCE_SECRET && PRONOUNCE_SECRET !== "CHANGE_ME",
      allowedOrigins: ALLOWED_ORIGINS ? ALLOWED_ORIGINS.split(",").map(s=>s.trim()).filter(Boolean) : ["*"],
    },
  });
});

// ---------- helpers ----------
function norm(s) {
  // normalize for strict compare (single word)
  // keep letters/numbers/spaces (unicode), remove punctuation
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

function extractAzureJsonResult(result) {
  try {
    const j = result?.properties?.getProperty(sdk.PropertyId.SpeechServiceResponse_JsonResult);
    return j || "";
  } catch {
    return "";
  }
}

function getAccuracyFromAzureJson(jsonStr) {
  try {
    const j = JSON.parse(jsonStr || "{}");
    const acc = j?.NBest?.[0]?.PronunciationAssessment?.AccuracyScore;
    return Number.isFinite(+acc) ? +acc : 0;
  } catch {
    return 0;
  }
}

function getWordsFromAzureJson(jsonStr) {
  try {
    const j = JSON.parse(jsonStr || "{}");
    return j?.NBest?.[0]?.Words || [];
  } catch {
    return [];
  }
}

async function assessWithAzure({ audioBuffer, targetText, language }) {
  if (!AZURE_SPEECH_KEY || !AZURE_SPEECH_REGION) {
    throw new Error("Azure Speech env missing (AZURE_SPEECH_KEY / AZURE_SPEECH_REGION)");
  }

  const refText = String(targetText || "").trim();
  const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_SPEECH_KEY, AZURE_SPEECH_REGION);
  speechConfig.speechRecognitionLanguage = String(language || "de-DE");

  // PushStream from buffer
  const pushStream = sdk.AudioInputStream.createPushStream();
  pushStream.write(audioBuffer);
  pushStream.close();

  const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
  const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

  // Pronunciation Assessment config
  const paConfig = new sdk.PronunciationAssessmentConfig(
    refText,
    sdk.PronunciationAssessmentGradingSystem.HundredMark,
    sdk.PronunciationAssessmentGranularity.Phoneme,
    true
  );
  paConfig.applyTo(recognizer);

  const result = await new Promise((resolve, reject) => {
    recognizer.recognizeOnceAsync(resolve, reject);
  });

  const recognizedText = (result?.text || "").toString();

  const azureJson = extractAzureJsonResult(result);
  const accuracyScore = getAccuracyFromAzureJson(azureJson);
  const words = getWordsFromAzureJson(azureJson);

  // STRICT: must match the target word
  const strictOk = norm(recognizedText) === norm(refText);
  const overallScore = strictOk ? Math.round(accuracyScore) : 0;

  return {
    recognizedText,
    referenceText: refText,
    strictOk,
    accuracyScore: Math.round(accuracyScore),
    overallScore,
    words,
    rawAzureJson: azureJson,
  };
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

    const audioBuffer = file.buffer;

    const result = await assessWithAzure({ audioBuffer, targetText, language });

    return res.json({
      ok: true,
      mode: "multipart",
      grade: gradeFrom(result.overallScore),
      overallScore: result.overallScore,

      strictOk: result.strictOk,
      recognizedText: result.recognizedText,
      referenceText: result.referenceText,
      accuracyScore: result.accuracyScore,

      file: {
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
      },

      details: { targetText, language },

      // optional debug
      words: result.words,
      rawAzureJson: result.rawAzureJson,
    });
  } catch (err) {
    console.error("[pronounce-backend] /pronounce error:", err);
    res.status(500).json({ ok: false, error: String(err?.message || "Server error") });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[pronounce-backend] listening on :${PORT} (DEPLOY_v16_AZURE_STRICT_MATCH)`);
});
