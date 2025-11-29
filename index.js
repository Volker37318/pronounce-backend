import express from "express";
import cors from "cors";

const app = express();
app.use(express.json({ limit: "15mb" }));

// Marker damit du sofort siehst, ob Koyeb wirklich den neuen Code fährt:
const DEPLOY_MARKER = "DEPLOY_2025-11-29_v4";

const {
  PORT = "8000",
  AZURE_SPEECH_KEY,
  AZURE_SPEECH_REGION,
  PRONOUNCE_SECRET,
  ALLOWED_ORIGINS = ""
} = process.env;

// Region normalized (wichtig für Endpoint!):
const azureRegion = (AZURE_SPEECH_REGION || "").trim().toLowerCase();

const allowedOrigins = ALLOWED_ORIGINS.split(",").map(s => s.trim()).filter(Boolean);

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
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

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "pronounce-backend",
    marker: DEPLOY_MARKER,
    env: {
      hasPRONOUNCE_SECRET: !!(PRONOUNCE_SECRET || "").trim(),
      hasAZURE_SPEECH_KEY: !!(AZURE_SPEECH_KEY || "").trim(),
      azureRegion: azureRegion || "(missing)",
      allowedOrigins
    }
  });
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

  // Wichtig: MediaRecorder liefert in Chrome oft audio/webm;codecs=opus
  if (mime.includes("webm")) return "audio/webm; codecs=opus";
  if (mime.includes("ogg")) return "audio/ogg; codecs=opus";
  if (mime.includes("wav")) return "audio/wav; codecs=audio/pcm; samplerate=16000";

  return mime;
}

function buildPronHeader({ referenceText, enableMiscue = true }) {
  // MS Docs: REST short-audio accepts True/False strings for EnableMiscue. :contentReference[oaicite:0]{index=0}
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
    // Secret check
    const secret = String(req.headers["x-pronounce-secret"] || "").trim();
    const serverSecret = String(PRONOUNCE_SECRET || "").trim();
    if (!serverSecret || secret !== serverSecret) {
      return res.status(401).json({ ok: false, error: "Unauthorized (bad secret)" });
    }

    const { targetText, language, audioBase64, enableMiscue } = req.body || {};
    if (!targetText || !language || !audioBase64) {
      return res.status(400).json({
        ok: false,
        error: "Missing fields. Required: targetText, language, audioBase64"
      });
    }

    if (!AZURE_SPEECH_KEY || !azureRegion) {
      return res.status(500).json({
        ok: false,
        error: "Missing env. Required: AZURE_SPEECH_KEY, AZURE_SPEECH_REGION"
      });
    }

    const audioBuf = base64ToBuffer(audioBase64);
    if (!audioBuf || audioBuf.length < 2000) {
      return res.status(400).json({ ok: false, error: "Audio too short/empty" });
    }

    const detected = detectContentType(audioBase64);
    const contentType =
      detected === "audio/webm; codecs=opus"
        ? "audio/webm; codecs=opus"
        : detected === "audio/ogg; codecs=opus"
          ? "audio/ogg; codecs=opus"
          : "audio/wav; codecs=audio/pcm; samplerate=16000";

    const endpoint =
      `https://${azureRegion}.stt.speech.microsoft.com` +
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
        "Ocp-Apim-Subscription-Key": String(AZURE_SPEECH_KEY).trim(),
        "Pronunciation-Assessment": pronHeader
      },
      body: audioBuf
    });

    const raw = await azureResp.text();
    let json;
    try { json = JSON.parse(raw); } catch { json = { raw }; }

    // Azure errors sauber sichtbar machen (und NICHT als 401 an Browser durchreichen)
    if (!azureResp.ok) {
      const hint =
        azureResp.status === 401
          ? "Azure 401: Key/Region passen nicht zur Speech-Ressource (oder falscher Key)."
          : azureResp.status === 400
            ? "Azure 400: oft Audioformat/Codec/zu lange oder ungültige Daten."
            : "Siehe azureBody.";

      return res.status(502).json({
        ok: false,
        error: "Azure request failed",
        azureStatus: azureResp.status,
        hint,
        azureBody: json
      });
    }

    // Pronunciation scores sitzen typischerweise in NBest[0].PronunciationAssessment
    const best = extractBest(json);
    const pa = best?.PronunciationAssessment || {};

    const overallScore = Math.round(Number(pa?.PronScore ?? pa?.AccuracyScore ?? 0));

    return res.json({
      ok: true,
      overallScore,
      grade: pickGrade(overallScore),
      details: {
        targetText,
        language,
        recognizedText: best?.Lexical || best?.Display || json?.DisplayText || "",
        scores: {
          pronScore: pa?.PronScore ?? null,
          accuracyScore: pa?.AccuracyScore ?? null,
          fluencyScore: pa?.FluencyScore ?? null,
          completenessScore: pa?.CompletenessScore ?? null,
          prosodyScore: pa?.ProsodyScore ?? null
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
  console.log(`[pronounce-backend] listening on :${PORT} (${DEPLOY_MARKER})`);
});
