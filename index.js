import express from "express";

const app = express();

const DEPLOY_MARKER = "DEPLOY_2026-01-01_v8_TEXTPLAIN_NO_PREFLIGHT";

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
 * CORS ganz am Anfang (VOR Parser!), damit auch Fehler CORS-Header haben.
 */
app.use((req, res, next) => {
  const origin = req.headers.origin;

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-pronounce-secret");
  res.setHeader("Access-Control-Max-Age", "86400");

  // Header immer setzen (damit Browser nie "No Access-Control-Allow-Origin" sieht)
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  else res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method === "OPTIONS") return res.status(204).end();

  if (origin && !isAllowedOrigin(origin)) {
    return res.status(403).json({ ok: false, error: "CORS blocked", origin, allowedOrigins, marker: DEPLOY_MARKER });
  }

  next();
});

// ✅ Wichtig: zuerst text/plain erlauben (vermeidet Preflight-Probleme)
app.use(express.text({ type: "text/plain", limit: "30mb" }));

// Dann JSON parser (falls doch application/json kommt)
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
    marker: DEPLOY_MARKER
  });
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
    Granularity: "Phoneme",            // ✅ wichtig für Ich/Ach
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

/* -------------------------
   Ich/Ach Gate – Helper
-------------------------- */

// Ermittelt grob, ob im Wort ein „ich-Laut“ erwartet ist.
// (nach vorderen Vokalen / Diphthongen + "ch", aber nicht "sch")
function isIchLautWord(targetText) {
  const w = String(targetText || "").trim().toLowerCase();
  if (!w.includes("ch")) return false;
  if (w.includes("sch")) return false;
  return /(?:i|ie|ei|e|ä|ö|ü|eu|äu)ch/.test(w);
}

// Versucht, aus Azure-Phonem-Liste den Score für "ç" (oder "C") zu finden.
// Wir nehmen den MIN-Score, damit ein schlechtes "ch" sicher durchschlägt.
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
  return minScore; // null wenn nicht gefunden
}

app.post("/pronounce", async (req, res) => {
  try {
    // ✅ text/plain (ohne Preflight) -> JSON selbst parsen
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
        marker: DEPLOY_MARKER
      });
    }

    if (!AZURE_SPEECH_KEY || !azureRegion) {
      return res.status(500).json({
        ok: false,
        error: "Missing env. Required: AZURE_SPEECH_KEY, AZURE_SPEECH_REGION",
        marker: DEPLOY_MARKER
      });
    }

    const mimeFromDataUrl = detectMime(audioBase64);
    const mime = (audioMime || mimeFromDataUrl || "").toLowerCase();

    // ✅ Wir akzeptieren WAV/PCM (Frontend sendet WAV)
    if (mime.includes("webm")) {
      return res.status(400).json({
        ok: false,
        error: "Unsupported audio container: audio/webm. Send WAV/PCM (16k mono) or OGG/Opus.",
        mime,
        marker: DEPLOY_MARKER
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
        azureBody: json,
        marker: DEPLOY_MARKER
      });
    }

    const best = extractBest(json);
    const pa = best?.PronunciationAssessment || {};

    const accuracyScore = Number(pa?.AccuracyScore);
    const pronScore = Number(pa?.PronScore);
    const overallScore = Math.round(Number.isFinite(pronScore) ? pronScore : (Number.isFinite(accuracyScore) ? accuracyScore : 0));

    // ✅ Basis-Matrix: bestanden wenn Accuracy >= 80
    const PASS_THRESHOLD = 80;
    let passed = Number.isFinite(accuracyScore) ? (accuracyScore >= PASS_THRESHOLD) : (overallScore >= PASS_THRESHOLD);

    // ✅ Ich/Ach Gate
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
      flags: {
        ichLautExpected,
        ichLautError,
        ichLautScore
      },
      details: {
        targetText,
        language,
        recognizedText: best?.Lexical || best?.Display || json?.DisplayText || "",
        scores: {
          pronScore: Number.isFinite(pronScore) ? pronScore : null,
          accuracyScore: Number.isFinite(accuracyScore) ? accuracyScore : null,
          fluencyScore: pa?.FluencyScore ?? null,
          completenessScore: pa?.CompletenessScore ?? null,
          prosodyScore: pa?.ProsodyScore ?? null
        },
        words: Array.isArray(best?.Words) ? best.Words : [],
        recognitionStatus: json?.RecognitionStatus ?? null
      }
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err), marker: DEPLOY_MARKER });
  }
});

const PORT_NUM = Number(process.env.PORT || PORT || 8000);
const MAX_RETRIES = 30;
const RETRY_DELAY_MS = 500;

function listenWithRetry(attempt = 1) {
  const server = app.listen(PORT_NUM, () => {
    console.log(`[pronounce-backend] listening on :${PORT_NUM} (${DEPLOY_MARKER})`);
  });

  server.on("error", (err) => {
    if (err && err.code === "EADDRINUSE" && attempt < MAX_RETRIES) {
      console.warn(`[pronounce-backend] Port ${PORT_NUM} busy (EADDRINUSE). Retry ${attempt}/${MAX_RETRIES} in ${RETRY_DELAY_MS}ms...`);
      try { server.close(); } catch {}
      setTimeout(() => listenWithRetry(attempt + 1), RETRY_DELAY_MS);
      return;
    }
    console.error("[pronounce-backend] Fatal listen error:", err);
    process.exit(1);
  });
}

listenWithRetry();

