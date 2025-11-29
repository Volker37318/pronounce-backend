import express from "express";
import cors from "cors";

const app = express();
app.use(express.json({ limit: "15mb" }));

const {
  PORT = "8000",
  AZURE_SPEECH_KEY,
  AZURE_SPEECH_REGION,
  PRONOUNCE_SECRET,
  ALLOWED_ORIGINS = ""
} = process.env;

const allowedOrigins = ALLOWED_ORIGINS.split(",").map(s => s.trim()).filter(Boolean);

const corsOptions = {
  origin: (origin, cb) => {
    // server-to-server / curl has no Origin
    if (!origin) return cb(null, true);

    // if not configured yet: allow for now
    if (allowedOrigins.length === 0) return cb(null, true);

    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-pronounce-secret"],
  maxAge: 86400
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.get("/health", (_, res) => {
  res.json({ ok: true, service: "pronounce-backend" });
});

function base64ToBuffer(audioBase64) {
  if (typeof audioBase64 !== "string" || audioBase64.length < 10) {
    throw new Error("audioBase64 missing or invalid");
  }
  const cleaned = audioBase64.replace(/^data:.*;base64,/, "");
  return Buffer.from(cleaned, "base64");
}

function detectContentType(audioBase64) {
  const m = /^data:([^;]+);base64,/.exec(audioBase64 || "");
  if (!m) return null;
  const mime = (m[1] || "").toLowerCase();
  if (mime.includes("ogg")) return "audio/ogg; codecs=opus";
  if (mime.includes("wav")) return "audio/wav; codecs=audio/pcm; samplerate=16000";
  return mime;
}

function buildPronHeader({ referenceText, enableMiscue = true }) {
  const payload = {
    ReferenceText: referenceText,
    GradingSystem: "HundredMark",
    Granularity: "Phoneme",
    Dimension: "Comprehensive",
    EnableMiscue: enableMiscue ? "True" : "False"
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

function pickGrade(score) {
  if (score >= 90) return "excellent";
  if (score >= 80) return "good";
  if (score >= 70) return "ok";
  return "try_again";
}

function extractBest(json) {
  const nbest = Array.isArray(json?.NBest) ? json.NBest : [];
  return nbest[0] || null;
}

app.post("/pronounce", async (req, res) => {
  try {
    const secret = req.headers["x-pronounce-secret"];
    if (!PRONOUNCE_SECRET || secret !== PRONOUNCE_SECRET) {
      return res.status(401).json({ ok: false, error: "Unauthorized (bad secret)" });
    }

    const { targetText, language, audioBase64, enableMiscue } = req.body || {};
    if (!targetText || !language || !audioBase64) {
      return res.status(400).json({
        ok: false,
        error: "Missing fields. Required: targetText, language, audioBase64"
      });
    }

    if (!AZURE_SPEECH_KEY || !AZURE_SPEECH_REGION) {
      return res.status(500).json({
        ok: false,
        error: "Missing env. Required: AZURE_SPEECH_KEY, AZURE_SPEECH_REGION"
      });
    }

    const audioBuf = base64ToBuffer(audioBase64);

    // Azure REST short-audio: accept OGG/OPUS 16k or WAV/PCM 16k (default to WAV)
    const detected = detectContentType(audioBase64);
    const contentType =
      detected === "audio/ogg; codecs=opus"
        ? "audio/ogg; codecs=opus"
        : "audio/wav; codecs=audio/pcm; samplerate=16000";

    const endpoint =
      `https://${AZURE_SPEECH_REGION}.stt.speech.microsoft.com` +
      `/speech/recognition/conversation/cognitiveservices/v1` +
      `?language=${encodeURIComponent(language)}` +
      `&format=detailed`;

    const pronHeader = buildPronHeader({
      referenceText: targetText,
      enableMiscue: enableMiscue !== false
    });

    const azureResp = await fetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": contentType,
        "Ocp-Apim-Subscription-Key": AZURE_SPEECH_KEY,
        "Pronunciation-Assessment": pronHeader
      },
      body: audioBuf
    });

    const raw = await azureResp.text();
    let json;
    try { json = JSON.parse(raw); } catch { json = { raw }; }

    if (!azureResp.ok) {
      return res.status(azureResp.status).json({
        ok: false,
        error: "Azure request failed",
        status: azureResp.status,
        azure: json
      });
    }

    const best = extractBest(json);
    const pronScore = Number(best?.PronScore ?? best?.PronunciationScore ?? best?.AccuracyScore ?? 0);
    const overallScore = Math.round(pronScore);

    return res.json({
      ok: true,
      overallScore,
      grade: pickGrade(overallScore),
      details: {
        targetText,
        language,
        recognizedText: best?.Display || json?.DisplayText || "",
        scores: {
          pronScore: best?.PronScore ?? null,
          accuracyScore: best?.AccuracyScore ?? null,
          fluencyScore: best?.FluencyScore ?? null,
          completenessScore: best?.CompletenessScore ?? null,
          prosodyScore: best?.ProsodyScore ?? null
        },
        words: Array.isArray(best?.Words) ? best.Words : [],
        recognitionStatus: json?.RecognitionStatus ?? null
      }
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.listen(Number(PORT), () => {
  console.log(`[pronounce-backend] listening on :${PORT}`);
});
