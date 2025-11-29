import express from "express";

const app = express();
app.use(express.json({ limit: "15mb" }));

const DEPLOY_MARKER = "DEPLOY_2025-11-29_v5";

const {
  PORT = "8000",
  AZURE_SPEECH_KEY,
  AZURE_SPEECH_REGION,
  PRONOUNCE_SECRET,
  ALLOWED_ORIGINS = ""
} = process.env;

const allowedOrigins = ALLOWED_ORIGINS.split(",").map(s => s.trim()).filter(Boolean);
const azureRegion = (AZURE_SPEECH_REGION || "").trim().toLowerCase();

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (allowedOrigins.length === 0) return true;
  return allowedOrigins.includes(origin);
}

/**
 * CORS: Header IMMER setzen (auch bei 401/403/500),
 * Preflight OPTIONS IMMER mit 204 beantworten.
 * => Browser blockiert nicht mehr und du siehst echte JSON-Fehler.
 */
app.use((req, res, next) => {
  const origin = req.headers.origin;

  // immer setzen:
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-pronounce-secret");
  res.setHeader("Access-Control-Max-Age", "86400");

  // Wichtig: Für Debug/Robustheit geben wir origin zurück, wenn vorhanden.
  // (Sicherheit kommt bei dir ohnehin über PRONOUNCE_SECRET.)
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  // Preflight:
  if (req.method === "OPTIONS") return res.status(204).end();

  // Optional: wenn du Origin wirklich strikt blocken willst, dann 403 (aber mit CORS-Header!)
  if (origin && !isAllowedOrigin(origin)) {
    return res.status(403).json({ ok: false, error: "CORS blocked", origin, allowedOrigins });
  }

  next();
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "pronounce-backend",
    marker: DEPLOY_MARKER,
    env: {
      hasPRONOUNCE_SECRET: !!String(PRONOUNCE_SECRET || "").trim(),
      hasAZURE_SPEECH_KEY: !!String(AZURE_SPEECH_KEY || "").trim(),
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

function detectMime(audioBase64) {
  const m = /^data:([^;]+);base64,/.exec(audioBase64 || "");
  if (!m) return null;
  return (m[1] || "").toLowerCase();
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
    // Secret check
    const serverSecret = String(PRONOUNCE_SECRET || "").trim();
    const secret = String(req.headers["x-pronounce-secret"] || "").trim();
    if (!serverSecret || secret !== serverSecret) {
      return res.status(401).json({ ok: false, error: "Unauthorized (bad secret)" });
    }

    const { targetText, language, audioBase64, enableMiscue, audioMime } = req.body || {};
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

    const mimeFromDataUrl = detectMime(audioBase64);
    const mime = (audioMime || mimeFromDataUrl || "").toLowerCase();

    // Ganz wichtig: Azure REST mag WebM oft nicht -> sauberer Fehlertext
    if (mime.includes("webm")) {
      return res.status(400).json({
        ok: false,
        error: "Unsupported audio container: audio/webm. Record as audio/ogg;codecs=opus or WAV/PCM.",
        mime
      });
    }

    const contentType = mime.includes("ogg")
      ? "audio/ogg; codecs=opus"
      : "audio/wav; codecs=audio/pcm; samplerate=16000";

    const audioBuf = base64ToBuffer(audioBase64);
    if (!audioBuf || audioBuf.length < 2000) {
      return res.status(400).json({ ok: false, error: "Audio too short/empty" });
    }

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

    if (!azureResp.ok) {
      return res.status(502).json({
        ok: false,
        error: "Azure request failed",
        azureStatus: azureResp.status,
        azureBody: json
      });
    }

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
