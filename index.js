// index.js – Pronunciation-Backend-Stubs für Koyeb
import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

// Einfacher Shared Secret als Kopierschutz
const PRONOUNCE_SECRET = process.env.PRONOUNCE_SECRET || "CHANGE_ME";

app.use(cors({
  origin: "*", // später: auf deine Netlify-Domain einschränken
  methods: ["POST", "OPTIONS"]
}));
app.use(express.json({ limit: "5mb" }));

// Health-Check
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "pronounce-backend" });
});

// zentrale Aussprache-Route
app.post("/pronounce", async (req, res) => {
  try {
    const clientSecret = req.headers["x-pronounce-secret"];
    if (clientSecret !== PRONOUNCE_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { targetText, language, audioBase64 } = req.body || {};

    if (!targetText || !language || !audioBase64) {
      return res.status(400).json({ error: "Missing fields" });
    }

    // TODO: Hier später Azure Pronunciation Assessment aufrufen.
    // Für jetzt: Dummy-Score zum Testen der Struktur.

    const overallScore = Math.floor(60 + Math.random() * 40); // 60–100
    let grade = "good";
    if (overallScore < 75) grade = "needs_practice";
    if (overallScore < 65) grade = "poor";

    return res.json({
      ok: true,
      overallScore,
      grade,
      details: {
        targetText,
        language
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.listen(PORT, () => {
  console.log(`Pronounce backend listening on port ${PORT}`);
});
