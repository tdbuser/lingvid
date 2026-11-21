// Lingvid helper — Cloudflare Worker (free plan).
// GET /?v=VIDEO_ID&lang=uz  → { title, description, lang, translated, segments:[{t,text}] }
// Fetches YouTube captions server-side (browsers can't, because of CORS).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json; charset=utf-8", ...CORS } });

const CLIENTS = [
  { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 34,
    ua: "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip" },
  { clientName: "IOS", clientVersion: "20.10.4", deviceModel: "iPhone16,2",
    ua: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3 like Mac OS X)" },
  { clientName: "WEB", clientVersion: "2.20250301.00.00",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0 Safari/537.36" },
];

async function player(v) {
  for (const c of CLIENTS) {
    try {
      const { ua, ...client } = c;
      const r = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": ua, "Accept-Language": "en" },
        body: JSON.stringify({ videoId: v, context: { client: { ...client, hl: "en", gl: "US" } } }),
      });
      if (!r.ok) continue;
      const d = await r.json();
      const tracks = d?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (tracks && tracks.length) return { d, tracks, ua };
      if (d?.videoDetails && !tracks) return { d, tracks: [], ua };
    } catch (e) { /* try next client */ }
  }
  return null;
}

function pickTrack(tracks) {
  // prefer manual track over auto ("asr"); keep video's own language
  return tracks.find(t => t.kind !== "asr") || tracks[0];
}

const pad = n => String(n).padStart(2, "0");
const fmt = ms => { const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`; };

async function captions(baseUrl, ua, tlang) {
  const u = new URL(baseUrl);
  u.searchParams.set("fmt", "json3");
  if (tlang) u.searchParams.set("tlang", tlang);
  const r = await fetch(u.toString(), { headers: { "User-Agent": ua } });
  if (!r.ok) return null;
  const t = await r.text();
  if (!t) return null;
  const d = JSON.parse(t);
  const out = [];
  for (const e of d.events || []) {
    if (!e.segs) continue;
    const text = e.segs.map(s => s.utf8 || "").join("").replace(/\s+/g, " ").trim();
    if (text) out.push({ t: fmt(e.tStartMs || 0), text });
  }
  return out;
}

// Fallback: Google Translate public endpoint (free, no key). Translates in chunks, keeps line order.
async function gtranslate(segments, tl) {
  const out = segments.map(x => ({ ...x }));
  let i = 0;
  while (i < out.length) {
    let j = i, len = 0;
    while (j < out.length && len + out[j].text.length + 1 < 3500) { len += out[j].text.length + 1; j++; }
    if (j === i) j = i + 1;
    const q = out.slice(i, j).map(x => x.text.replace(/\n/g, " ")).join("\n");
    const r = await fetch("https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t&tl=" + encodeURIComponent(tl), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: "q=" + encodeURIComponent(q),
    });
    if (!r.ok) throw new Error("gt " + r.status);
    const d = await r.json();
    const lines = (d[0] || []).map(p => p[0] || "").join("").split("\n");
    if (lines.length === j - i) lines.forEach((t, k) => { out[i + k].text = t.trim(); });
    else throw new Error("gt lines");
    i = j;
  }
  return out;
}

export default {
  async fetch(req) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const v = url.searchParams.get("v") || "";
    const lang = (url.searchParams.get("lang") || "").toLowerCase();
    if (!/^[A-Za-z0-9_-]{11}$/.test(v)) return json({ error: "bad_video_id" }, 400);

    const p = await player(v);
    if (!p) return json({ error: "youtube_unavailable" }, 502);
    const det = p.d.videoDetails || {};
    const base = { title: det.title || "", description: det.shortDescription || "", channel: det.author || "" };
    if (!p.tracks.length) return json({ ...base, error: "no_captions", segments: [] }, 200);

    const tr = pickTrack(p.tracks);
    const own = (tr.languageCode || "").split("-")[0];
    let segments = null, translated = false;
    if (lang && lang !== own) {
      try { segments = await captions(tr.baseUrl, p.ua, lang); translated = !!(segments && segments.length); } catch (e) {}
    }
    if (!segments || !segments.length) {
      try { segments = await captions(tr.baseUrl, p.ua, ""); } catch (e) {}
    }
    if (!segments || !segments.length) return json({ ...base, error: "captions_blocked", segments: [] }, 200);
    let via = translated ? "youtube" : "";
    if (lang && lang !== own && !translated) {
      try { segments = await gtranslate(segments, lang); translated = true; via = "google"; } catch (e) {}
    }
    return json({ ...base, lang: translated ? lang : own, original: own, translated, via, segments });
  },
};
