import express from "express";

const app = express();

/**
 * Version/Marker: ändere den Marker ruhig bei jedem Deploy,
 * damit du in /health sofort siehst, was live ist.
 */
const DEPLOY_MARKER = "DEPLOY_2026-01-03_v11_CORS_OK_SINGLE_LISTEN";

const {
  PORT = "8000",
  AZURE_SPEECH_KEY,
  AZURE_SPEECH_REGION,
  PRONOUNCE_SECRET,
  ALLOWED_ORIGINS = "",
} = process.env;

/** Normalisiert Origins: trim, Quotes entfernen, trailing slash entfernen */
function normOrigin(s) {
  let x = String(s || "").trim();
  x = x.replace(/^["']+|["']+$/g, ""); // remove surrounding quotes
  x = x.replace(/\/+$/g, "");          // remove trailing slash
  return x;
}

const allowedOrigins = String(ALLOWED_ORIGINS || "")
  .split(",")
  .map(normOrigin)
  .filter(Boolean);

const azureRegion = String(AZURE_SPEECH_REGION || "").trim().toLowerCase();

function isAllowedOrigin(origin) {
  const o = normOrigin(origin);
  if (!o) return true;                    // no Origin header => allow
  if (allowedOrigins.length === 0) return true; // if not configured => allow all
  return allowedOrigins.includes(o);
}

/**
 * ✅ CORS MUSS ganz am Anfang stehen, damit auch Fehlerantworten CORS-Header haben.
 * ✅ Bei erlaubter Origin spiegeln wir die Origin zurück.
 */
app.use((req, res, next) => {
  const originRaw = req.headers.origin;
  const origin = normOrigin(originRaw);

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-pronounce-secret");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (!origin) {
    // z.B. direkte Navigation / server-to-server
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (isAllowedOrigin(origin)) {
    // IMPORTANT: reflect origin (not "*") for browsers
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    // keine Allow-Origin Header setzen!
    return res.status(403).send("CORS blocked");
  }

  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// ✅ Erst text/plain erlauben (reduziert Preflight/komplizierte Clients)
app.use(express.text({ type: "text/plain", limit: "30mb" }));
// ✅ Dann JSON parser (falls doch application/json kommt)
app.use(express.json({ limit: "30mb" }));

// Parser-Fehler sauber als JSON zurückgeben (CORS-Header sind schon gesetzt)
app.use((err, req, res, next) => {
  if (!err) return next();
  const msg = String(err?.message || err);

  const isTooLarge =
    err?.type === "entity.too.large" ||
    /too large|entity too large|request entity too large/i.test(msg);

  return res.status(isTooLarge ? 413 : 400).json({
    ok: false,
    error: isTooLarge ? "Payload too large (audio too long)" : "Bad JSON / body parse error",
    details: msg,
    marker: DEPLOY_MARKER,
  });
});

app.get("/", (_req, res) => {
  res.type("text/plain").send("pronounce-backend ok");
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
      allowedOrigins,
    },
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
    EnableMiscue: enableMiscue ? "True" : "False",
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

/* -------------------------
   Ich/Ach Gate – Helper
-------------------------- */

function isIchLautWord(targetText) {
  const w = String(targetText || "").trim().toLowerCase();
  if (!w.includes("ch")) return false;
  if (w.includes("sch")) return false;
  return /(?:i|ie|ei|e|ä|ö|ü|eu|äu)ch/.test(w);
}

function extractIchLautScore(best) {
  const words = Array.isArray(best?.Words) ? best.Words : [];
  let minScore = null;

  for (const w of words) {
    const phs = Array.isArray(w?.Phonemes) ? w.Phonemes : [];
    for (const p of phs) {
      const ph = String(p?.Phoneme || "");
      const s = Number(p?.PronunciationAssessment?.AccuracyScore);
      if (!Number.isFinite(s)) continue;

      if (/ç|C/.test(ph)) {
        minScore = (minScore === null) ? s : Math.min(minScore, s);
      }
    }
  }
  return minScore;
}

app.post("/pronounce", async (req, res) => {
  try {
    // ✅ text/plain -> JSON selbst parsen
    if (typeof req.body === "string") {
      try { req.body = JSON.parse(req.body); } catch {}
    }

    const serverSecret = String(PRONOUNCE_SECRET || "").trim();
    const secret = String(req.headers["x-pronounce-secret"] || "").trim();

    // ✅ Secret nur prüfen, wenn serverseitig gesetzt
    if (serverSecret && secret !== serverSecret) {
      return res.status(401).json({ ok: false, error: "Unauthorized (bad secret)", marker: DEPLOY_MARKER });
    }

    const { targetText, language, audioBase64, enableMiscue, audioMime } = req.body || {};
    if (!targetText || !language || !audioBase64) {
      return res.status(400).json({
        ok: false,
        error: "Missing fields. Required: targetText, language, audioBase64",
        marker: DEPLOY_MARKER,
      });
    }

    if (!AZURE_SPEECH_KEY || !azureRegion) {
      return res.status(500).json({
        ok: false,
        error: "Missing env. Required: AZURE_SPEECH_KEY, AZURE_SPEECH_REGION",
        marker: DEPLOY_MARKER,
      });
    }

    const mimeFromDataUrl = detectMime(audioBase64);
    const mime = (audioMime || mimeFromDataUrl || "").toLowerCase();

    if (mime.includes("webm")) {
      return res.status(400).json({
        ok: false,
        error: "Unsupported audio container: audio/webm. Send WAV/PCM (16k mono) or OGG/Opus.",
        mime,
        marker: DEPLOY_MARKER,
      });
    }

    const contentType = mime.includes("ogg")
      ? "audio/ogg; codecs=opus"
      : "audio/wav; codecs=audio/pcm; samplerate=16000";

    const audioBuf = base64ToBuffer(audioBase64);
    if (!audioBuf || audioBuf.length < 2000) {
      return res.status(400).json({ ok: false, error: "Audio too short/empty", marker: DEPLOY_MARKER });
    }

    const endpoint =
      `https://${azureRegion}.stt.speech.microsoft.com` +
      `/speech/recognition/conversation/cognitiveservices/v1` +
      `?language=${encodeURIComponent(language)}` +
      `&format=detailed`;

    const pronHeader = buildPronHeader({
      referenceText: String(targetText).trim(),
      enableMiscue: enableMiscue !== false,
    });

    const azureResp = await fetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": contentType,
        "Ocp-Apim-Subscription-Key": String(AZURE_SPEECH_KEY).trim(),
        "Pronunciation-Assessment": pronHeader,
      },
      body: audioBuf,
    });

    const raw = await azureResp.text();
    let json;
    try { json = JSON.parse(raw); } catch { json = { raw }; }

    if (!azureResp.ok) {
      return res.status(502).json({
        ok: false,
        error: "Azure request failed",
        azureStatus: azureResp.status,
        azureBody: json,
        marker: DEPLOY_MARKER,
      });
    }

    const best = extractBest(json);
    const pa = best?.PronunciationAssessment || {};

    const accuracyScore = Number(pa?.AccuracyScore);
    const pronScore = Number(pa?.PronScore);
    const overallScore = Math.round(
      Number.isFinite(pronScore) ? pronScore :
      (Number.isFinite(accuracyScore) ? accuracyScore : 0)
    );

    const PASS_THRESHOLD = 80;
    let passed = Number.isFinite(accuracyScore)
      ? (accuracyScore >= PASS_THRESHOLD)
      : (overallScore >= PASS_THRESHOLD);

    const ichLautExpected = isIchLautWord(targetText);
    const ICH_PHONEME_MIN = 70;

    let ichLautScore = null;
    let ichLautError = false;

    if (ichLautExpected) {
      ichLautScore = extractIchLautScore(best);
      if (Number.isFinite(ichLautScore) && ichLautScore < ICH_PHONEME_MIN) {
        ichLautError = true;
        passed = false;
      }
    }

    return res.json({
      ok: true,
      passed,
      overallScore,
      grade: pickGrade(overallScore),
      flags: { ichLautExpected, ichLautError, ichLautScore },
      details: {
        targetText,
        language,
        recognizedText: best?.Lexical || best?.Display || json?.DisplayText || "",
        scores: {
          pronScore: Number.isFinite(pronScore) ? pronScore : null,
          accuracyScore: Number.isFinite(accuracyScore) ? accuracyScore : null,
          fluencyScore: pa?.FluencyScore ?? null,
          completenessScore: pa?.CompletenessScore ?? null,
          prosodyScore: pa?.ProsodyScore ?? null,
        },
        words: Array.isArray(best?.Words) ? best.Words : [],
        recognitionStatus: json?.RecognitionStatus ?? null,
      },
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: String(err?.message || err),
      marker: DEPLOY_MARKER,
    });
  }
});

/**
 * ✅ IMPORTANT: Nur EIN Listen-Start. Kein Retry, kein Doppelstart.
 * Koyeb managed Deploy/Rolling/Restart selbst.
 */
const PORT_NUM = Number(process.env.PORT || PORT || 8000);

app.listen(PORT_NUM, "0.0.0.0", () => {
  console.log(`[pronounce-backend] listening on :${PORT_NUM} (${DEPLOY_MARKER})`);
});

