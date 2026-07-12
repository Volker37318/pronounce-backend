DIAGNOSE-VERSION – keine Bewertungsänderung

WO EINBAUEN:
GitHub > Repository: pronounce-backend

1. index.js im Repository durch diese index.js ersetzen.
2. package.json nur ersetzen, falls deine GitHub-Datei davon abweicht.
3. Commit speichern.
4. Koyeb deployt automatisch.
5. Danach /health öffnen und prüfen:
   DEPLOY_2026-07-12_v15_PHONEM_DIAG_ONLY

TESTWÖRTER:
ich
nicht
möchten
Acht
Bach

Die bestehende Bewertung bleibt unverändert.
Neu sind nur:
- Koyeb-Logs mit dem Präfix [PHONEM_DIAG]
- diagnostics.words in der JSON-Antwort
