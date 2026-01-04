// index.js – Pronunciation Backend (multipart/form-data) für Koyeb
import express from "express";
import cors from "cors";
import multer from "multer";

const app = express();
const PORT = Number(process.env.PORT || 8000);

// Security
const PRONOUNCE_SECRET = process.env.PRONOUNCE_SECRET || "CHANGE_ME";

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

app.options("*", (req, res) => res.sendStatus(204));

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "pronounce-backend" });
});

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

    // DUMMY SCORE (später Azure)
    const overallScore = Math.floor(60 + Math.random() * 40);
    let grade = "good";
    if (overallScore < 75) grade = "needs_practice";
    if (overallScore < 65) grade = "poor";

    return res.json({
      ok: true,
      mode: "multipart",
      overallScore,
      grade,
      file: {
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
      },
      details: { targetText, language },
    });
  } catch (err) {
    console.error("[pronounce-backend] /pronounce error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[pronounce-backend] listening on :${PORT} (DEPLOY_v15_MULTIPART)`);
});
