const V = new URL(import.meta.url).searchParams.get("v") || "0";
const { bust } = await import(`./load.js?v=${encodeURIComponent(V)}`);

const shared = await import(bust(import.meta.url, "./shared.js"));
const {
  nowPlayingContainer,
  normalizeMediaText,
  scoreMediaMatch,
  prefersReducedMotion,
  registerGradientReset
} = shared;

// Last.fm's generic grey star when no cover exists
const LASTFM_PLACEHOLDER_RE = /\/2a96cbd8b46e442fc41c2b86b821562f\./i;
const LASTFM_CDN_RE = /lastfm(?:-img)?\.freetls\.fastly\.net/i;
const artLookupCache = new Map();
const artMissCache = new Map();
const artFailUrls = new Set();
const gradientCache = new Map();
const ART_MISS_TTL_MS = 2 * 60 * 1000;
/** Blob URLs currently allocated for art - only revoke after they leave the DOM. */
const artObjectUrls = new Set();

export function preloadImage(url) {
  if (!url || preloadImage._seen?.has(url)) return;
  if (!preloadImage._seen) preloadImage._seen = new Set();
  preloadImage._seen.add(url);
  const img = new Image();
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  img.src = url;
}

export function artCacheKey(track) {
  const artist = (track && track.artist && track.artist["#text"]) || "";
  const name = (track && track.name) || "";
  return `${normalizeMediaText(artist)}|${normalizeMediaText(name)}`;
}

export function isBlobArtUrl(url) {
  return !!url && String(url).startsWith("blob:");
}

export function rememberArtObjectUrl(url) {
  if (isBlobArtUrl(url)) artObjectUrls.add(url);
}

export function releaseArtObjectUrl(url) {
  if (!isBlobArtUrl(url) || !artObjectUrls.has(url)) return;
  try {
    URL.revokeObjectURL(url);
  } catch (e) {
    /* ignore */
  }
  artObjectUrls.delete(url);
}

/** Last.fm CDN often 200s for fetch but fails as bare <img>; proxy keeps <img> working. */
export function toDisplayArtUrl(url) {
  if (!url || isMissingAlbumArt(url)) return "";
  if (artFailUrls.has(url)) return "";
  if (LASTFM_CDN_RE.test(url)) {
    return (
      "https://wsrv.nl/?url=" +
      encodeURIComponent(url) +
      "&w=300&h=300&fit=cover&output=jpg"
    );
  }
  return url;
}

export function probeImgUrl(url) {
  return new Promise((resolve) => {
    if (!url) return resolve(false);
    const img = new Image();
    img.referrerPolicy = "no-referrer";
    img.decoding = "async";
    const finish = (ok) => {
      img.onload = null;
      img.onerror = null;
      resolve(!!ok);
    };
    img.onload = () => finish(img.naturalWidth > 0);
    img.onerror = () => finish(false);
    img.src = url;
  });
}

export async function fetchAsObjectUrl(url) {
  if (!url) return "";
  try {
    const res = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!res.ok) return "";
    const blob = await res.blob();
    if (!blob.type || !blob.type.startsWith("image/")) return "";
    const objectUrl = URL.createObjectURL(blob);
    rememberArtObjectUrl(objectUrl);
    return objectUrl;
  } catch (e) {
    return "";
  }
}

/** Make a URL actually paint in an <img>. Prefer proxy/blob over dead Last.fm hotlink. */
export async function materializeDisplayArtUrl(url) {
  if (!url || isMissingAlbumArt(url) || artFailUrls.has(url)) return "";

  const direct = toDisplayArtUrl(url);
  if (direct && (await probeImgUrl(direct))) return direct;

  const blobUrl = await fetchAsObjectUrl(url);
  if (blobUrl && (await probeImgUrl(blobUrl))) return blobUrl;
  if (blobUrl) releaseArtObjectUrl(blobUrl);

  if (direct !== url) {
    const proxied = toDisplayArtUrl(url);
    if (proxied && (await probeImgUrl(proxied))) return proxied;
  }

  artFailUrls.add(url);
  return "";
}

export function cacheStableArtUrl(cacheKey, url) {
  // Never cache ephemeral blob: URLs - they get revoked and poison later paints
  if (!url || isBlobArtUrl(url)) return;
  artLookupCache.set(cacheKey, url);
}

/** Sync only - Last.fm URL or memory cache. Never hits iTunes/Deezer. */
export function applyImmediateArt(track) {
  if (!track) return "";
  if (track._albumArt) {
    if (isBlobArtUrl(track._albumArt) && !artObjectUrls.has(track._albumArt)) {
      track._albumArt = "";
    } else {
      preloadImage(track._albumArt);
      return track._albumArt;
    }
  }

  const cacheKey = artCacheKey(track);
  if (artLookupCache.has(cacheKey)) {
    const cached = artLookupCache.get(cacheKey);
    if (isBlobArtUrl(cached)) {
      artLookupCache.delete(cacheKey);
    } else {
      track._albumArt = cached;
      preloadImage(track._albumArt);
      return track._albumArt;
    }
  }

  const lastfmUrl = getLastFmImageUrl(track);
  if (!isMissingAlbumArt(lastfmUrl) && !artFailUrls.has(lastfmUrl)) {
    const displayUrl = toDisplayArtUrl(lastfmUrl) || lastfmUrl;
    cacheStableArtUrl(cacheKey, displayUrl);
    artMissCache.delete(cacheKey);
    track._albumArt = displayUrl;
    preloadImage(displayUrl);
    return displayUrl;
  }

  track._albumArt = "";
  return "";
}

export async function raceArtworkFallbacks(artist, name) {
  const probes = [
    fetchItunesArtwork(artist, name),
    fetchDeezerArtwork(artist, name)
  ].map(async (probe) => {
    const url = await probe;
    if (!url) throw new Error("empty");
    return url;
  });

  try {
    return await Promise.any(probes);
  } catch (err) {
    return "";
  }
}

export function isMissingAlbumArt(url) {
  return !url || LASTFM_PLACEHOLDER_RE.test(url);
}

export function getLastFmImageUrl(track) {
  const images = track && track.image;
  if (!Array.isArray(images) || !images.length) return "";

  // Prefer largest usable URL from the API payload
  for (let i = images.length - 1; i >= 0; i--) {
    const url = (images[i]["#text"] || "").trim();
    if (url) return url;
  }
  return "";
}


export function upgradeItunesArtworkUrl(url) {
  if (!url) return "";
  return String(url)
    .replace(/^http:\/\//i, "https://")
    .replace(/\/\d+x\d+bb\./, "/300x300bb.")
    .replace(/100x100bb/, "300x300bb")
    .replace(/60x60bb/, "300x300bb");
}


export function jsonpRequest(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const cbName = `_artJsonp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const script = document.createElement("script");
    let settled = false;

    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      try {
        delete window[cbName];
      } catch (e) {
        window[cbName] = undefined;
      }
      if (script.parentNode) script.parentNode.removeChild(script);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      cleanup();
      reject(new Error("JSONP timeout"));
    }, timeoutMs);

    window[cbName] = (data) => {
      if (settled) return;
      cleanup();
      resolve(data);
    };

    script.onerror = () => {
      if (settled) return;
      cleanup();
      reject(new Error("JSONP failed"));
    };

    script.async = true;
    script.src = url + (url.includes("?") ? "&" : "?") + "callback=" + cbName;
    document.head.appendChild(script);
  });
}

export async function fetchItunesArtwork(artist, track) {
  const term = `${artist} ${track}`.trim();
  if (!term) return "";

  const endpoint =
    "https://itunes.apple.com/search?media=music&entity=song&limit=8&term=" +
    encodeURIComponent(term);
  const response = await fetch(endpoint);
  if (!response.ok) throw new Error("iTunes search failed");

  const data = await response.json();
  const results = Array.isArray(data.results) ? data.results : [];
  if (!results.length) return "";

  const wantArtist = normalizeMediaText(artist);
  const wantTrack = normalizeMediaText(track);
  let best = null;
  let bestScore = -1;

  for (const item of results) {
    if (!item.artworkUrl100) continue;
    const score = scoreMediaMatch(
      wantArtist,
      wantTrack,
      normalizeMediaText(item.artistName),
      normalizeMediaText(item.trackName)
    );
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  if (!best || bestScore < 2) best = results.find((item) => item.artworkUrl100) || null;
  return best ? upgradeItunesArtworkUrl(best.artworkUrl100) : "";
}

export async function fetchDeezerArtwork(artist, track) {
  const term = `${artist} ${track}`.trim();
  if (!term) return "";

  // Deezer blocks browser CORS fetch; JSONP works and finds catalogs iTunes misses
  const endpoint =
    "https://api.deezer.com/search/track?limit=8&output=jsonp&q=" +
    encodeURIComponent(term);
  const data = await jsonpRequest(endpoint);
  const results = Array.isArray(data && data.data) ? data.data : [];
  if (!results.length) return "";

  const wantArtist = normalizeMediaText(artist);
  const wantTrack = normalizeMediaText(track);
  let best = null;
  let bestScore = -1;

  for (const item of results) {
    const cover =
      (item.album && (item.album.cover_medium || item.album.cover_big || item.album.cover)) || "";
    if (!cover) continue;
    const score = scoreMediaMatch(
      wantArtist,
      wantTrack,
      normalizeMediaText(item.artist && item.artist.name),
      normalizeMediaText(item.title)
    );
    if (score > bestScore) {
      bestScore = score;
      best = cover;
    }
  }

  if ((!best || bestScore < 2) && results[0] && results[0].album) {
    best =
      results[0].album.cover_medium ||
      results[0].album.cover_big ||
      results[0].album.cover ||
      "";
  }

  return best || "";
}

export async function resolveAlbumArt(track) {
  const cacheKey = artCacheKey(track);
  applyImmediateArt(track);

  // Already have a URL that paints - keep it
  if (track._albumArt && (await probeImgUrl(track._albumArt))) {
    cacheStableArtUrl(cacheKey, track._albumArt);
    return track._albumArt;
  }

  // Cached/immediate URL is dead (e.g. revoked blob) - drop it
  if (track._albumArt) {
    if (isBlobArtUrl(track._albumArt)) releaseArtObjectUrl(track._albumArt);
    artLookupCache.delete(cacheKey);
    track._albumArt = "";
  }

  // Rematerialize from the raw Last.fm CDN URL (proxy / blob)
  const rawLastFm = getLastFmImageUrl(track);
  if (rawLastFm && !isMissingAlbumArt(rawLastFm) && !artFailUrls.has(rawLastFm)) {
    const usable = await materializeDisplayArtUrl(rawLastFm);
    if (usable) {
      cacheStableArtUrl(cacheKey, usable);
      track._albumArt = usable;
      return usable;
    }
    artFailUrls.add(rawLastFm);
  }

  track._albumArt = "";

  const artist = (track && track.artist && track.artist["#text"]) || "";
  const name = (track && track.name) || "";

  const missedAt = artMissCache.get(cacheKey);
  if (missedAt && Date.now() - missedAt < ART_MISS_TTL_MS) {
    return "";
  }

  const fallback = await raceArtworkFallbacks(artist, name);
  const usableFallback = fallback ? await materializeDisplayArtUrl(fallback) : "";

  if (usableFallback) {
    cacheStableArtUrl(cacheKey, usableFallback);
    artMissCache.delete(cacheKey);
    preloadImage(usableFallback);
  } else {
    artMissCache.set(cacheKey, Date.now());
  }

  track._albumArt = usableFallback;
  return usableFallback;
}

export function getAlbumArtUrl(track) {
  if (track && typeof track._albumArt === "string") return track._albumArt;
  const lastfmUrl = getLastFmImageUrl(track);
  return isMissingAlbumArt(lastfmUrl) ? "" : lastfmUrl;
}

export function rgbCss(r, g, b, a = 1) {
  const rr = Math.max(0, Math.min(255, r | 0));
  const gg = Math.max(0, Math.min(255, g | 0));
  const bb = Math.max(0, Math.min(255, b | 0));
  return a < 1 ? `rgba(${rr}, ${gg}, ${bb}, ${a})` : `rgb(${rr}, ${gg}, ${bb})`;
}

export function colorDistance(a, b) {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return dr * dr + dg * dg + db * db;
}

/** Reject near-black / near-white / muddy greys for gradient stops. */
const PALETTE_MIN_LUM = 52;
const PALETTE_MAX_LUM = 190;
const PALETTE_MIN_SAT = 0.28;
const PALETTE_MIN_CHROMA = 36; // max(rgb) - min(rgb)
const PALETTE_TARGET_SAT = 0.62;
const PALETTE_MIN_DISTANCE = 3200;

export function luminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function rgbSat(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

export function rgbChroma(r, g, b) {
  return Math.max(r, g, b) - Math.min(r, g, b);
}

export function isUsablePaletteColor(r, g, b, sat) {
  const lum = luminance(r, g, b);
  if (lum < PALETTE_MIN_LUM || lum > PALETTE_MAX_LUM) return false;
  if (sat < PALETTE_MIN_SAT) return false;
  if (rgbChroma(r, g, b) < PALETTE_MIN_CHROMA) return false;
  return true;
}

/** Push a color away from grey toward its dominant hue. */
export function punchSaturation(color, targetSat = PALETTE_TARGET_SAT) {
  let { r, g, b } = color;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max <= 0) return { r: 0, g: 0, b: 0, sat: 0 };

  let sat = (max - min) / max;
  if (sat >= targetSat) {
    return {
      r: Math.round(r),
      g: Math.round(g),
      b: Math.round(b),
      sat
    };
  }

  if (sat < 0.02) {
    // True grey: invent a mild cool/warm bias from channel noise so punch has a hue
    const bias = 0.55;
    if (r >= g && r >= b) {
      g *= 1 - bias * targetSat;
      b *= 1 - bias * targetSat;
    } else if (g >= r && g >= b) {
      r *= 1 - bias * targetSat;
      b *= 1 - bias * targetSat;
    } else {
      r *= 1 - bias * targetSat;
      g *= 1 - bias * targetSat;
    }
  } else {
    // Expand distance from the peak channel to hit target saturation
    const scale = targetSat / sat;
    r = max - (max - r) * scale;
    g = max - (max - g) * scale;
    b = max - (max - b) * scale;
  }

  const before = luminance(color.r, color.g, color.b);
  const after = luminance(r, g, b);
  if (after > 1) {
    const keep = before / after;
    r *= keep;
    g *= keep;
    b *= keep;
  }

  return {
    r: Math.round(Math.max(0, Math.min(255, r))),
    g: Math.round(Math.max(0, Math.min(255, g))),
    b: Math.round(Math.max(0, Math.min(255, b))),
    sat: rgbSat(r, g, b)
  };
}

export function clampPaletteColor(color) {
  let { r, g, b } = color;
  let lum = luminance(r, g, b);

  if (lum < PALETTE_MIN_LUM) {
    const lift = (PALETTE_MIN_LUM - lum) / 255;
    r = Math.min(255, r + (255 - r) * lift * 1.25);
    g = Math.min(255, g + (255 - g) * lift * 1.25);
    b = Math.min(255, b + (255 - b) * lift * 1.25);
  } else if (lum > PALETTE_MAX_LUM) {
    const drop = (lum - PALETTE_MAX_LUM) / 255;
    r *= 1 - drop * 1.1;
    g *= 1 - drop * 1.1;
    b *= 1 - drop * 1.1;
  }

  return punchSaturation({
    r: Math.max(0, Math.min(255, r)),
    g: Math.max(0, Math.min(255, g)),
    b: Math.max(0, Math.min(255, b))
  });
}

export function pickPaletteFromPixels(data) {
  const buckets = new Map();

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const sat = rgbSat(r, g, b);
    if (!isUsablePaletteColor(r, g, b, sat)) continue;

    const key = `${r >> 4},${g >> 4},${b >> 4}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { r: 0, g: 0, b: 0, n: 0, sat: 0 };
      buckets.set(key, bucket);
    }
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    bucket.n += 1;
    bucket.sat += sat;
  }

  // Soft pass: if cover is almost all grey, loosen sat so we still get *something*
  let rankedSource = [...buckets.values()];
  if (!rankedSource.length) {
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 200) continue;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const lum = luminance(r, g, b);
      if (lum < PALETTE_MIN_LUM || lum > PALETTE_MAX_LUM) continue;
      const sat = rgbSat(r, g, b);
      if (sat < 0.1 || rgbChroma(r, g, b) < 18) continue;
      const key = `${r >> 4},${g >> 4},${b >> 4}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { r: 0, g: 0, b: 0, n: 0, sat: 0 };
        buckets.set(key, bucket);
      }
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      bucket.n += 1;
      bucket.sat += sat;
    }
    rankedSource = [...buckets.values()];
  }

  const ranked = rankedSource
    .map((bucket) => {
      const n = bucket.n;
      const sat = bucket.sat / n;
      const color = clampPaletteColor({
        r: bucket.r / n,
        g: bucket.g / n,
        b: bucket.b / n
      });
      const mid = 1 - Math.abs(luminance(color.r, color.g, color.b) - 118) / 118;
      // Accents over area: chroma dominates, pixel count is only a weak tie-break
      const chroma = rgbChroma(color.r, color.g, color.b) / 255;
      return {
        ...color,
        sat: color.sat || sat,
        score:
          Math.pow(Math.max(color.sat, sat), 1.65) *
          (0.35 + chroma) *
          (0.45 + 0.55 * Math.max(0, mid)) *
          Math.log2(2 + n)
      };
    })
    .filter((c) => isUsablePaletteColor(c.r, c.g, c.b, c.sat) || c.sat >= 0.22)
    .sort((a, b) => b.score - a.score);

  const picked = [];
  for (const color of ranked) {
    if (picked.every((p) => colorDistance(p, color) > PALETTE_MIN_DISTANCE)) {
      picked.push(color);
    }
    if (picked.length >= 3) break;
  }

  while (picked.length < 3) {
    const last = picked[picked.length - 1] || {
      r: 48,
      g: 140,
      b: 180,
      sat: 0.55
    };
    const shift = 0.28 * (picked.length + 1);
    const variant = clampPaletteColor({
      r: last.r * (1 - shift) + last.b * shift,
      g: last.g * (1 - shift * 0.45) + last.r * shift * 0.55,
      b: last.b * (1 - shift) + last.g * shift
    });
    picked.push(variant);
  }

  return picked.map((c) => clampPaletteColor(c));
}

export function mixColor(a, b, t) {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t
  };
}

/** Darken without washing toward neutral grey - keep the sampled hue. */
export function softenColor(color, amount) {
  const dark = {
    r: color.r * 0.18,
    g: color.g * 0.18,
    b: color.b * 0.18
  };
  return mixColor(color, dark, amount);
}

export function buildArtGradient(colors) {
  // Less softening = more contrast from the art accents
  const c0 = softenColor(colors[0], 0.12);
  const c1 = softenColor(colors[1], 0.18);
  const c2 = softenColor(colors[2], 0.28);
  const stops = 12;
  const parts = [];

  for (let i = 0; i <= stops; i++) {
    const t = i / stops;
    // Smooth ease so mid tones don't form a hard band
    const eased = t * t * (3 - 2 * t);
    const color =
      eased < 0.5
        ? mixColor(c0, c1, eased * 2)
        : mixColor(c1, c2, (eased - 0.5) * 2);
    const alpha = 1;
    parts.push(
      `${rgbCss(color.r, color.g, color.b, alpha)} ${(t * 100).toFixed(1)}%`
    );
  }

  return {
    image: `linear-gradient(115deg, ${parts.join(", ")})`,
    fallback: rgbCss(
      Math.round(c1.r * 0.42),
      Math.round(c1.g * 0.42),
      Math.round(c1.b * 0.42)
    )
  };
}

export function unwrapWsrvUrl(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url, window.location.origin);
    if (
      parsed.hostname === "wsrv.nl" ||
      parsed.hostname.endsWith(".wsrv.nl")
    ) {
      const inner = parsed.searchParams.get("url");
      if (inner) return inner;
    }
  } catch (e) {
    /* keep original */
  }
  return url;
}

export async function fetchArtBlob(url) {
  async function blobFrom(fetchUrl) {
    const res = await fetch(fetchUrl, { mode: "cors", credentials: "omit" });
    if (!res.ok) throw new Error("art fetch failed");
    return res.blob();
  }

  // Never nest wsrv proxies - display URLs are often already proxied
  const source = unwrapWsrvUrl(url) || url;

  if (String(source).startsWith("blob:")) {
    return blobFrom(source);
  }

  // Palette only needs a stamp-sized sample - much faster than the full cover
  const tiny =
    "https://wsrv.nl/?url=" +
    encodeURIComponent(source) +
    "&w=32&h=32&fit=cover&output=jpg";

  try {
    return await blobFrom(tiny);
  } catch (e) {
    try {
      return await blobFrom(source);
    } catch (err) {
      const proxy =
        "https://wsrv.nl/?url=" +
        encodeURIComponent(source) +
        "&w=64&h=64&fit=cover&output=jpg";
      return blobFrom(proxy);
    }
  }
}

export async function sampleAlbumGradient(url) {
  if (!url) return null;
  if (gradientCache.has(url)) return gradientCache.get(url);

  const pending = (async () => {
    const blob = await fetchArtBlob(url);
    const bitmap = await createImageBitmap(blob);
    const size = 32;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, size, size);
    bitmap.close();

    const { data } = ctx.getImageData(0, 0, size, size);
    return buildArtGradient(pickPaletteFromPixels(data));
  })();

  gradientCache.set(url, pending);
  try {
    const gradient = await pending;
    gradientCache.set(url, gradient);
    return gradient;
  } catch (err) {
    gradientCache.delete(url);
    throw err;
  }
}

let gradientToken = 0;
let lastGradientArtUrl = "";
const ART_CROSSFADE_MS = 500;
const GRADIENT_CROSSFADE_MS = 280;

export function getCardBackgroundEls() {
  const $card = nowPlayingContainer.find(".now-playing-card").not(".error");
  if (!$card.length) return null;

  let $bg = $card.children(".now-playing-card-bg");
  if (!$bg.length) {
    $card.prepend(
      '<div class="now-playing-card-bg" aria-hidden="true"><div class="now-playing-card-bg-wash"></div></div>'
    );
    $bg = $card.children(".now-playing-card-bg");
  }

  let $wash = $bg.children(".now-playing-card-bg-wash:not(.is-leaving)").last();
  if (!$wash.length) {
    $bg.prepend('<div class="now-playing-card-bg-wash"></div>');
    $wash = $bg.children(".now-playing-card-bg-wash").last();
  }

  return { $card, $bg, $wash };
}

export function cardArtUrl($card) {
  if (!$card || !$card.length) return "";
  const $art = $card.find(".now-playing-artwork");
  return (
    $art.attr("data-art-url") ||
    $art.find("img.now-playing-art-front").attr("src") ||
    $art.find("img").first().attr("src") ||
    ""
  );
}

export async function syncCardBackground(artUrl) {
  const initial = getCardBackgroundEls();
  if (!initial) return;

  let url = artUrl || "";
  if (!url) {
    url = cardArtUrl(initial.$card) || "";
  }

  if (!url) {
    lastGradientArtUrl = "";
    initial.$bg.children(".now-playing-card-bg-wash").css({
      opacity: "0",
      backgroundImage: "none"
    });
    initial.$bg.css({ opacity: "0", backgroundColor: "" });
    return;
  }

  const activeImage = initial.$wash.css("background-image");
  const washPainted = activeImage && activeImage !== "none";

  // Same cover and wash still present - keep the drifting layer alive (polls hit this a lot)
  if (url === lastGradientArtUrl && washPainted) {
    initial.$bg.css("opacity", "1");
    return;
  }

  const token = ++gradientToken;

  try {
    const gradient = await sampleAlbumGradient(url);
    if (token !== gradientToken || !gradient) return;

    const live = getCardBackgroundEls();
    if (!live) return;

    const currentSrc = cardArtUrl(live.$card);
    if (currentSrc && currentSrc !== url) return;

    live.$bg.css("background-color", gradient.fallback);
    live.$bg.css("opacity", "1");

    const $active = live.$wash;
    const liveActiveImage = $active.css("background-image");
    const hasActiveWash = liveActiveImage && liveActiveImage !== "none";

    if (!hasActiveWash || prefersReducedMotion()) {
      live.$bg.children(".now-playing-card-bg-wash.is-leaving, .now-playing-card-bg-wash.is-incoming").remove();
      $active
        .removeClass("is-incoming is-leaving is-shown")
        .css({ backgroundImage: gradient.image, opacity: "1" });
      lastGradientArtUrl = url;
      return;
    }

    // Dual-wash crossfade: incoming over outgoing (snappy vs art fade)
    live.$bg.children(".now-playing-card-bg-wash.is-incoming").remove();
    const $next = $(
      '<div class="now-playing-card-bg-wash is-incoming" aria-hidden="true"></div>'
    );
    $next.css("background-image", gradient.image);
    live.$bg.append($next);

    requestAnimationFrame(() => {
      if (token !== gradientToken) return;
      requestAnimationFrame(() => {
        if (token !== gradientToken) return;
        $active.addClass("is-leaving");
        $next.addClass("is-shown");
      });
    });

    window.setTimeout(() => {
      if (token !== gradientToken) return;
      const els = getCardBackgroundEls();
      if (!els) return;
      els.$bg.children(".now-playing-card-bg-wash.is-leaving").remove();
      els.$bg
        .children(".now-playing-card-bg-wash.is-incoming")
        .removeClass("is-incoming is-shown")
        .css("opacity", "1");
      lastGradientArtUrl = url;
    }, GRADIENT_CROSSFADE_MS);
  } catch (err) {
    if (token !== gradientToken) return;
    const live = getCardBackgroundEls();
    if (!live) return;
    // Never fall back to bare grey/black - keep any wash already on the card
    const keepImage = live.$wash.css("background-image");
    if (keepImage && keepImage !== "none") {
      live.$bg.css("opacity", "1");
      return;
    }
    console.warn("Album gradient sample failed:", err);
  }
}

export function ensureArtLayers($art) {
  if (!$art.length) return null;

  let $front = $art.children("img.now-playing-art-front");
  let $back = $art.children("img.now-playing-art-back");

  if (!$front.length) {
    const $legacy = $art.children("img").not(".now-playing-art-back").first();
    if ($legacy.length) {
      $legacy.addClass("now-playing-art-layer now-playing-art-front is-visible");
      $front = $legacy;
    } else {
      $art.prepend(
        '<img class="now-playing-art-layer now-playing-art-front" alt="" decoding="async" referrerpolicy="no-referrer" />'
      );
      $front = $art.children("img.now-playing-art-front");
    }
  } else {
    $front.addClass("now-playing-art-layer");
  }

  if (!$back.length) {
    $front.after(
      '<img class="now-playing-art-layer now-playing-art-back" alt="" decoding="async" referrerpolicy="no-referrer" aria-hidden="true" />'
    );
    $back = $art.children("img.now-playing-art-back");
  } else {
    $back.addClass("now-playing-art-layer");
  }

  if (!$art.find(".dither-overlay-canvas").length) {
    $art.append('<canvas class="dither-overlay-canvas" aria-hidden="true"></canvas>');
  }

  return { $front, $back };
}

export function bindArtError($img) {
  $img.off("error.nowPlayingArt");
  $img.on("error.nowPlayingArt", () => {
    const failed = $img.attr("src");
    if (failed) artFailUrls.add(failed);
    document.dispatchEvent(
      new CustomEvent("now-playing:art-error", { detail: { src: failed || "" } })
    );
  });
}

let artSwapSeq = 0;
let artSwapTimer = 0;

export function clearArtSwapTimer() {
  if (artSwapTimer) {
    window.clearTimeout(artSwapTimer);
    artSwapTimer = 0;
  }
}

export function artLayers($art) {
  return $art.children("img.now-playing-art-layer");
}

export function forceArtReflow($art) {
  if ($art[0]) void $art[0].offsetWidth;
}

export function getDisplayedArtUrl($art) {
  if (!$art || !$art.length) return "";
  const $showing = $art.children("img.now-playing-art-layer.is-visible").last().length
    ? $art.children("img.now-playing-art-layer.is-visible").last()
    : $art.children("img.now-playing-art-front").first();
  return ($showing.attr("src") || "") || ($art.attr("data-art-url") || "");
}

export function isDisplayedArtBroken($art) {
  if (!$art || !$art.length) return true;
  const $showing = $art.children("img.now-playing-art-layer.is-visible").last().length
    ? $art.children("img.now-playing-art-layer.is-visible").last()
    : $art.children("img.now-playing-art-front").first();
  if (!$showing.length) return true;
  const el = $showing[0];
  const src = $showing.attr("src") || "";
  if (!src) return true;
  return !(el.complete && el.naturalWidth > 0);
}

/** Drop every layer src immediately - never keep a prior cover as a fallback paint. */
export function clearArtLayers($art) {
  if (!$art.length) return;
  clearArtSwapTimer();
  $art.removeClass("is-art-swapping").removeAttr("data-art-swap");

  const stale = [];
  artLayers($art).each(function () {
    const s = this.getAttribute("src");
    if (s) stale.push(s);
    $(this)
      .off("load.nowPlayingArtFade error.nowPlayingArtFade error.nowPlayingArt")
      .removeClass("is-visible is-outgoing")
      .removeAttr("src")
      .attr({ alt: "", "aria-hidden": "true" });
  });

  const prev = $art.attr("data-art-url");
  if (prev) stale.push(prev);
  $art.attr("data-art-url", "");

  const layers = ensureArtLayers($art);
  if (layers) {
    layers.$front
      .removeClass("now-playing-art-back is-visible is-outgoing")
      .addClass("now-playing-art-layer now-playing-art-front")
      .removeAttr("aria-hidden");
    layers.$back
      .removeClass("now-playing-art-front is-visible is-outgoing")
      .addClass("now-playing-art-layer now-playing-art-back")
      .attr("aria-hidden", "true");
  }

  stale.forEach((url) => releaseArtObjectUrl(url));
  forceArtReflow($art);
}

/**
 * Show cover art for a track. Never crossfades from a previous track's cover -
 * old pixels are cleared first, then the new image fades in alone.
 */
export function swapAlbumArt($artOrImg, newSrc, alt, options) {
  const opts = options || {};
  const ownerKey = opts.ownerKey || "";
  const $art = $artOrImg.hasClass("now-playing-artwork")
    ? $artOrImg
    : $artOrImg.closest(".now-playing-artwork");
  if (!$art.length) return;
  if (!ensureArtLayers($art)) return;

  const displayedSrc = getDisplayedArtUrl($art);
  const currentOwner = $art.attr("data-art-for") || "";

  // Already showing the right cover for this track
  if (
    newSrc &&
    displayedSrc === newSrc &&
    !isDisplayedArtBroken($art) &&
    (!ownerKey || currentOwner === ownerKey)
  ) {
    if (ownerKey) $art.attr("data-art-for", ownerKey);
    $art.attr("data-art-url", newSrc);
    syncCardBackground(newSrc);
    return;
  }

  const seq = ++artSwapSeq;
  clearArtLayers($art);
  if (ownerKey) $art.attr("data-art-for", ownerKey);
  else $art.removeAttr("data-art-for");

  $art.attr("data-art-url", newSrc || "");
  $art.attr("data-art-swap", String(seq));
  syncCardBackground(newSrc || "");

  if (!newSrc) {
    $art.removeAttr("data-art-swap");
    document.dispatchEvent(new CustomEvent("now-playing:art-updated"));
    return;
  }

  const layers = ensureArtLayers($art);
  if (!layers) return;
  const $front = layers.$front;

  $front
    .off("load.nowPlayingArtFade error.nowPlayingArtFade")
    .removeAttr("crossorigin")
    .attr({
      referrerpolicy: "no-referrer",
      fetchpriority: "high",
      alt: alt || ""
    });
  bindArtError($front);

  const reveal = () => {
    if (seq !== artSwapSeq || $art.attr("data-art-swap") !== String(seq)) return;
    if (ownerKey && $art.attr("data-art-for") !== ownerKey) return;
    if ($front[0].naturalWidth < 1) return;

    if (prefersReducedMotion()) {
      $front.addClass("is-visible");
      $art.removeClass("is-art-swapping").removeAttr("data-art-swap");
      document.dispatchEvent(new CustomEvent("now-playing:art-updated"));
      return;
    }

    $art.addClass("is-art-swapping");
    forceArtReflow($art);
    requestAnimationFrame(() => {
      if (seq !== artSwapSeq || $art.attr("data-art-swap") !== String(seq)) return;
      $front.addClass("is-visible");
      clearArtSwapTimer();
      artSwapTimer = window.setTimeout(() => {
        if (seq !== artSwapSeq) return;
        $art.removeClass("is-art-swapping").removeAttr("data-art-swap");
        document.dispatchEvent(new CustomEvent("now-playing:art-updated"));
      }, ART_CROSSFADE_MS);
    });
  };

  preloadImage(newSrc);
  if ($front[0].complete && $front.attr("src") === newSrc && $front[0].naturalWidth > 0) {
    reveal();
  } else {
    $front.one("load.nowPlayingArtFade", reveal);
    $front.one("error.nowPlayingArtFade", () => {
      if (seq !== artSwapSeq || $art.attr("data-art-swap") !== String(seq)) return;
      // Failed load - stay empty for this track; do NOT resurrect the previous cover
      $front.removeClass("is-visible").removeAttr("src");
      $art.removeClass("is-art-swapping").removeAttr("data-art-swap");
      $art.attr("data-art-url", "");
      syncCardBackground("");
    });
    $front.attr("src", newSrc);
  }
}

export function resetGradientState() {
  lastGradientArtUrl = "";
}

registerGradientReset(resetGradientState);
