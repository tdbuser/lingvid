# Lingvid

Watch any YouTube video and read it at the same time: the player stays on top, a clear written guide sits below — with contents, folding sections and time links that jump the video to the right moment.

The guide itself is written by the Lingvid app in Claude (search, recipe/instruction/lesson detection, meaning-based translation into Uzbek or Russian, Word export). Its "▶ Video bilan" button opens this page with the guide in the link.

Live: https://tdbuser.github.io/lingvid/

## Auto text helper (optional, free)
`worker/worker.js` is a Cloudflare Worker (free plan) that fetches a video's captions — optionally auto-translated by YouTube — so the site can get the text without leaving the page. Deploy it, then set `const WORKER="https://<name>.<account>.workers.dev/"` in `index.html`.
