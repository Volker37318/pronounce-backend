import express from "express";
import multer from "multer";

const app = express();

/**
 * Marker hochsetzen, damit du in /health sofort siehst, dass es live ist.
 */
const DEPLOY_MARKER = "DEPLOY_2026-01-03_v13_FORMDATA_PRIMARY_FALLBACK_BASE64";

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
  x = x.replace(/^["']+|["']+$/g, "");
  x = x.replace(/\/+$/g, "");
  return x;
}

const allowedOrigins = String(ALLOWED_ORIGINS || "")
  .split(",")
  .map(normOrigin)
  .filter(Boolean);

const azureRegion = String(AZURE_SPEECH_REGION || "").trim().toLowerCase();

function isAllowedOrigin(origin) {
  const o = normOrigin(origin);
  if (!o) return true;
  if (allowedOrigins.length === 0) return true;
  return allowedOrigins.includes(o);
}

/**
 * ✅ CORS ganz am Anfang
 */
app.use((req, res, next) => {
  const originRaw = req.headers.origin;
  const origin = normOrigin(originRaw);

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-pronounce-secret");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (!origin) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    return res.status(403).send("CORS blocked");
  }

  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// ✅ Nur text/plain + json parsen (multipart wird von multer verarbeitet)
app.use(express.text({ type: "text/plain", limit: "30mb" }));
app.use(express.json({ limit: "30mb" }));

// Parser-Fehler sauber als JSON zurückgeben
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

/* -------------------------
   Multipart/FormData (wie seite3.js Prinzip)
-------------------------- */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
});

function isMultipart(req) {
  const ct = String(req.headers["content-type"] || "").toLowerCase();
  return ct.startsWith("multipart/form-data");
}

// Multer nur anwenden, wenn wirklich multipart
function maybeUpload(req, res, next) {
  if (!isMultipart(req)) return next();
  return upload.single("audio")(req, res, next);
}

/* -------------------------
   Helpers
-------------------------- */

function base64ToBuffer(audioBase64) {
  if (typeof audioBase64 !== "string" || audioBase64.length < 10) {
    throw new Error("audioBase64 missing or invalid");
  }
  const cleaned = audioBase64.replace(/^data:.*;base64,/, "");
  return Buffer.from(cleaned, "base64");
}

function detectMimeFromDataUrl(audioBase64) {
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

async function callAzurePronunciation({ audioBuf, audioMime, targetText, language, enableMiscue = true }) {
  if (!AZURE_SPEECH_KEY || !azureRegion) {
    return {
      ok: false,
      status: 500,
      body: { ok: false, error: "Missing env. Required: AZURE_SPEECH_KEY, AZURE_SPEECH_REGION", marker: DEPLOY_MARKER },
    };
  }

  const mime = String(audioMime || "").toLowerCase();

  // webm ist bei Azure Pronunciation i.d.R. problematisch -> hier bewusst blocken
  if (mime.includes("webm")) {
    return {
      ok: false,
      status: 400,
      body: { ok: false, error: "Unsupported audio container: audio/webm. Send WAV/PCM (16k mono) or OGG/Opus.", mime, marker: DEPLOY_MARKER },
    };
  }

  const contentType = mime.includes("ogg")
    ? "audio/ogg; codecs=opus"
    : "audio/wav; codecs=audio/pcm; samplerate=16000";

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
    return {
      ok: false,
      status: 502,
      body: { ok: false, error: "Azure request failed", azureStatus: azureResp.status, azureBody: json, marker: DEPLOY_MARKER },
    };
  }

  return { ok: true, status: 200, body: json };
}

/* -------------------------
   /pronounce
   Primär: FormData (audio file) wie seite3.js Prinzip
   Fallback: JSON/text mit audioBase64
-------------------------- */

app.post("/pronounce", maybeUpload, async (req, res) => {
  try {
    // ✅ Secret nur prüfen, wenn serverseitig gesetzt
    const serverSecret = String(PRONOUNCE_SECRET || "").trim();
    const secret = String(req.headers["x-pronounce-secret"] || "").trim();
    if (serverSecret && secret !== serverSecret) {
      return res.status(401).json({ ok: false, error: "Unauthorized (bad secret)", marker: DEPLOY_MARKER });
    }

    // -------------------------
    // A) multipart/form-data
    // -------------------------
    if (isMultipart(req)) {
      const targetText = String(req.body?.targetText || "").trim();
      const language = String(req.body?.language || "").trim();
      const audioMime = String(req.body?.audioMime || req.file?.mimetype || "audio/wav").toLowerCase();

      if (!targetText || !language || !req.file?.buffer) {
        return res.status(400).json({
          ok: false,
          error: "Missing fields. Required: targetText, language, audio(file)",
          marker: DEPLOY_MARKER,
        });
      }

      const audioBuf = req.file.buffer;
      if (!audioBuf || audioBuf.length < 2000) {
        return res.status(400).json({ ok: false, error: "Audio too short/empty", marker: DEPLOY_MARKER });
      }

      const azure = await callAzurePronunciation({
        audioBuf,
        audioMime,
        targetText,
        language,
        enableMiscue: true,
      });

      if (!azure.ok) return res.status(azure.status).json(azure.body);

      const json = azure.body;
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
    }

    // -------------------------
    // B) Fallback: JSON/text audioBase64
    // -------------------------
    if (typeof req.body === "string") {
      try { req.body = JSON.parse(req.body); } catch {}
    }

    const { targetText, language, audioBase64, enableMiscue, audioMime } = req.body || {};
    if (!targetText || !language || !audioBase64) {
      return res.status(400).json({
        ok: false,
        error: "Missing fields. Required: targetText, language, audioBase64",
        marker: DEPLOY_MARKER,
      });
    }

    const mimeFromDataUrl = detectMimeFromDataUrl(audioBase64);
    const mime = (audioMime || mimeFromDataUrl || "").toLowerCase();

    const audioBuf = base64ToBuffer(audioBase64);
    if (!audioBuf || audioBuf.length < 2000) {
      return res.status(400).json({ ok: false, error: "Audio too short/empty", marker: DEPLOY_MARKER });
    }

    const azure = await callAzurePronunciation({
      audioBuf,
      audioMime: mime,
      targetText,
      language,
      enableMiscue,
    });

    if (!azure.ok) return res.status(azure.status).json(azure.body);

    const json = azure.body;
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
 * ✅ NUR EIN Listen-Start
 */
const PORT_NUM = Number(process.env.PORT || PORT || 8000);
app.listen(PORT_NUM, "0.0.0.0", () => {
  console.log(`[pronounce-backend] listening on :${PORT_NUM} (${DEPLOY_MARKER})`);
});

