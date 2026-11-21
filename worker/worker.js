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

// ---------- Neural voices (Microsoft Edge "Read aloud" service, free) ----------
const EDGE_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const EDGE_VER = "1-130.0.2849.68";
async function secMsGec() {
  let ticks = Math.floor(Date.now() / 1000) + 11644473600;
  ticks -= ticks % 300;
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(BigInt(ticks) * 10000000n) + EDGE_TOKEN));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}
const xesc = s => s.replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));
const uuid = () => crypto.randomUUID().replace(/-/g, "");
const ts = () => new Date().toUTCString().replace("GMT", "GMT+0000 (Coordinated Universal Time)");

async function edgeTTS(text, voice, rate) {
  const url = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${EDGE_TOKEN}&Sec-MS-GEC=${await secMsGec()}&Sec-MS-GEC-Version=${EDGE_VER}&ConnectionId=${uuid()}`;
  const resp = await fetch(url, { headers: {
    Upgrade: "websocket",
    Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
    Pragma: "no-cache", "Cache-Control": "no-cache",
  } });
  const ws = resp.webSocket;
  if (!ws) throw new Error("ws " + resp.status);
  ws.accept();
  const chunks = [];
  const done = new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error("timeout")), 25000);
    ws.addEventListener("message", ev => {
      const d = ev.data;
      if (typeof d === "string") { if (d.includes("Path:turn.end")) { clearTimeout(timer); res(); } return; }
      const u8 = new Uint8Array(d);
      const hl = (u8[0] << 8) | u8[1];
      const head = new TextDecoder().decode(u8.slice(2, 2 + hl));
      if (head.includes("Path:audio")) chunks.push(u8.slice(2 + hl));
    });
    ws.addEventListener("close", () => { clearTimeout(timer); res(); });
    ws.addEventListener("error", e => { clearTimeout(timer); rej(new Error("ws error")); });
  });
  ws.send(`X-Timestamp:${ts()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
    '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}');
  const lang = voice.split("-").slice(0, 2).join("-");
  ws.send(`X-RequestId:${uuid()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts()}Z\r\nPath:ssml\r\n\r\n` +
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'><voice name='${xesc(voice)}'><prosody pitch='+0Hz' rate='${rate}' volume='+0%'>${xesc(text)}</prosody></voice></speak>`);
  await done;
  try { ws.close(); } catch (e) {}
  const len = chunks.reduce((a, c) => a + c.length, 0);
  if (!len) throw new Error("no audio");
  const out = new Uint8Array(len); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export default {
  async fetch(req) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    if (url.pathname === "/tts") {
      const text = (url.searchParams.get("text") || "").slice(0, 2500).trim();
      const voice = url.searchParams.get("voice") || "en-US-AriaNeural";
      let r = parseInt(url.searchParams.get("rate") || "0", 10); if (!(r >= -50 && r <= 100)) r = 0;
      if (!text || !/^[a-z]{2,3}-[A-Z]{2}(-[A-Za-z]+)?-[A-Za-z]+Neural$/.test(voice)) return json({ error: "bad_request" }, 400);
      try {
        const audio = await edgeTTS(text, voice, (r >= 0 ? "+" : "") + r + "%");
        return new Response(audio, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=86400", ...CORS } });
      } catch (e) { return json({ error: "tts_failed", detail: String(e && e.message || e) }, 502); }
    }
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
      try { segments = (await gtranslate(segments, lang)).filter(x => x.text); translated = true; via = "google"; } catch (e) { via = "error: " + (e && e.message || e); }
    }
    return json({ ...base, lang: translated ? lang : own, original: own, translated, via, segments });
  },
};
