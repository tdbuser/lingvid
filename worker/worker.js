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
    // Align by Google's own sentence pieces: a piece whose original ends with "\n" closes a line.
    const lines = [];
    let cur = "";
    for (const p of d[0] || []) {
      const tr = p[0] || "", orig = p[1] || "";
      cur += tr;
      if (/\n\s*$/.test(orig) || /\n\s*$/.test(tr)) { lines.push(cur.trim()); cur = ""; }
    }
    if (cur.trim()) lines.push(cur.trim());
    const n = j - i;
    if (lines.length === n) lines.forEach((t, k) => { out[i + k].text = t; });
    else {
      // counts differ: spread the translated text over the block so nothing is lost
      const all = lines.join(" ");
      out[i].text = all;
      for (let k = 1; k < n; k++) out[i + k].text = "";
    }
    i = j;
  }
  return out;
}

// ---------- Full analysis with Google Gemini (official API, free tier; key stored as secret GEMINI_KEY) ----------
const LANG_NAMES = { uz: "Uzbek (Latin script)", ru: "Russian", en: "English", tr: "Turkish", kk: "Kazakh", ky: "Kyrgyz", tg: "Tajik", az: "Azerbaijani", uk: "Ukrainian", ar: "Arabic", fa: "Persian", de: "German", fr: "French", es: "Spanish", it: "Italian", pt: "Portuguese", zh: "Chinese (Simplified)", ja: "Japanese", ko: "Korean", hi: "Hindi" };
async function analyze(v, lang, env) {
  const key = env && env.GEMINI_KEY;
  if (!key) return json({ error: "no_gemini_key" }, 500);
  const lname = LANG_NAMES[lang] || lang || "English";
  const prompt = `Watch this whole YouTube video (audio AND picture). Return JSON only, no markdown fences.
Write all translations by MEANING (natural ${lname}), not word by word. Never invent anything.
{
 "title": "video title translated into ${lname}",
 "language": "ISO code of the spoken language",
 "summary": "3-5 sentences in ${lname}",
 "guide": "the content as a clear guide in ${lname}, markdown: '## ' headings; for a recipe: ingredients as '- name — amount' and steps as '1. [m:ss] step'; for instructions: what you need, steps; otherwise: main points, conclusions",
 "speech": [ { "t": "m:ss", "orig": "exactly what is said, in the spoken language", "tr": "meaning translation into ${lname}" } ],
 "onscreen": [ { "t": "m:ss", "orig": "text shown on screen that is NOT spoken", "tr": "translation into ${lname}" } ]
}
speech: cover the WHOLE video in order, one item per sentence or short phrase (about 2-8 seconds), accurate start times. If nobody speaks, use an empty array.
onscreen: every caption, title, label or written amount that appears on screen; skip channel logos and watermarks.`;
  const model = (env && env.GEMINI_MODEL) || "gemini-flash-latest";
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ parts: [{ file_data: { file_uri: "https://www.youtube.com/watch?v=" + v, mime_type: "video/*" } }, { text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: 60000 },
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return json({ error: "gemini_" + r.status, detail: (d.error && d.error.message || "").slice(0, 300) }, 502);
  const txt = (((d.candidates || [])[0] || {}).content || {}).parts?.map(p => p.text || "").join("") || "";
  let out;
  try { out = JSON.parse(txt.replace(/^```(json)?|```$/g, "").trim()); } catch (e) { return json({ error: "gemini_bad_json", detail: txt.slice(0, 300) }, 502); }
  return json({ ok: true, lang, ...out });
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    if (url.pathname === "/analyze") {
      const v = url.searchParams.get("v") || "";
      const lang = (url.searchParams.get("lang") || "en").toLowerCase().replace(/[^a-z-]/g, "").slice(0, 8);
      if (!/^[A-Za-z0-9_-]{11}$/.test(v)) return json({ error: "bad_video_id" }, 400);
      const ck = new Request("https://lingvid-cache.local/a/" + v + "/" + lang);
      const hit = await caches.default.match(ck);
      if (hit) return new Response(hit.body, hit);
      const res = await analyze(v, lang, env);
      if (res.status === 200) {
        const body = await res.clone().text();
        await caches.default.put(ck, new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=604800", ...CORS } }));
      }
      return res;
    }
    const v = url.searchParams.get("v") || "";
    const lang = (url.searchParams.get("lang") || "").toLowerCase();
    if (!/^[A-Za-z0-9_-]{11}$/.test(v)) return json({ error: "bad_video_id" }, 400);

    // Cache: each video's captions are fetched from YouTube once, then served from Cloudflare's cache for 7 days.
    const cacheKey = new Request("https://lingvid-cache.local/v/" + v + "/" + (lang || "orig"));
    const cache = caches.default;
    if (!url.searchParams.has("fresh")) {
      const hit = await cache.match(cacheKey);
      if (hit) { const r = new Response(hit.body, hit); r.headers.set("X-Lingvid-Cache", "HIT"); return r; }
    }
    const res = await handleVideo(v, lang);
    try {
      const body = await res.clone().json();
      if (body && body.segments && body.segments.length) {
        const toStore = new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=604800", ...CORS } });
        await cache.put(cacheKey, toStore);
      }
    } catch (e) {}
    return res;
  },
};

async function handleVideo(v, lang) {
  {
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
      try { segments = (await gtranslate(segments, lang)).filter(x => x.text); translated = true; via = "google"; } catch (e) { via = "error: " + (e && e.message || e); }
    }
    return json({ ...base, lang: translated ? lang : own, original: own, translated, via, segments });
  }
}

