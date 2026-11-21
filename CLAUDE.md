# Lingvid — working rules

- `index.html` (site root) is the **STABLE** version the family uses. Never edit it directly.
- All new work goes into `beta/index.html` first (site: /lingvid/beta/).
- Only after the owner checks beta on a phone and says it works, copy beta → root and create a git tag `stable-YYYY-MM-DD-N`.
- Add features **one at a time**; after each, the owner tests beta before the next one.
- Karaoke must keep working: video on top, word-by-word highlight in sync, pause stops it. Re-test this after every change.
- Known good stable: tag `stable-1` (17:40 version, word-by-word karaoke).
