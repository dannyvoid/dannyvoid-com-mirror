const username = "dannyvoid";
const api_key = "b34f8d58e1f90e5fd8d36b1a795c92d5";
const apiUrl = `https://ws.audioscrobbler.com/2.0/`;
const sleepTime = 10000;
const maxRetries = 3;
const retryDelay = 2000;

const lastFmContainer = $("#lastfm");

function getRecentTracksUrl() {
  return `${apiUrl}?method=user.getRecentTracks&user=${username}&api_key=${api_key}&format=json&limit=1`;
}

function displayMessage(message) {
  lastFmContainer.html(message);
}

function displayError(message) {
  displayMessage(`<strong class="bold-text2">x ${message}</strong><br /><br />`);
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function fetchLastFmData(retryCount = 0) {
  try {
    const response = await fetch(getRecentTracksUrl());

    if (!response.ok) {
      if (response.status === 500 && retryCount < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        return fetchLastFmData(retryCount + 1);
      }
      throw new Error(`Last.fm API returned ${response.status}`);
    }

    const data = await response.json();

    if (data.error) {
      if (data.error === 8 && retryCount < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        return fetchLastFmData(retryCount + 1);
      }
      throw new Error(data.message || "Last.fm API error");
    }

    if (!data.recenttracks || !data.recenttracks.track) {
      throw new Error("Invalid response from Last.fm API");
    }

    return data.recenttracks.track;
  } catch (error) {
    console.error("Last.fm fetch error:", error);
    if (retryCount >= maxRetries) {
      displayError("Last.fm temporarily unavailable (backend error)");
    }
    return [];
  }
}

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

function preloadImage(url) {
  if (!url || preloadImage._seen?.has(url)) return;
  if (!preloadImage._seen) preloadImage._seen = new Set();
  preloadImage._seen.add(url);
  const img = new Image();
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  img.src = url;
}

function artCacheKey(track) {
  const artist = (track && track.artist && track.artist["#text"]) || "";
  const name = (track && track.name) || "";
  return `${normalizeMusicText(artist)}|${normalizeMusicText(name)}`;
}

function isBlobArtUrl(url) {
  return !!url && String(url).startsWith("blob:");
}

function rememberArtObjectUrl(url) {
  if (isBlobArtUrl(url)) artObjectUrls.add(url);
}

function releaseArtObjectUrl(url) {
  if (!isBlobArtUrl(url) || !artObjectUrls.has(url)) return;
  try {
    URL.revokeObjectURL(url);
  } catch (e) {
    /* ignore */
  }
  artObjectUrls.delete(url);
}

/** Last.fm CDN often 200s for fetch but fails as bare <img>; proxy keeps <img> working. */
function toDisplayArtUrl(url) {
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

function probeImgUrl(url) {
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

async function fetchAsObjectUrl(url) {
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
async function materializeDisplayArtUrl(url) {
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

function cacheStableArtUrl(cacheKey, url) {
  // Never cache ephemeral blob: URLs - they get revoked and poison later paints
  if (!url || isBlobArtUrl(url)) return;
  artLookupCache.set(cacheKey, url);
}

/** Sync only - Last.fm URL or memory cache. Never hits iTunes/Deezer. */
function applyImmediateArt(track) {
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

async function raceArtworkFallbacks(artist, name) {
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

function isMissingAlbumArt(url) {
  return !url || LASTFM_PLACEHOLDER_RE.test(url);
}

function getLastFmImageUrl(track) {
  const images = track && track.image;
  if (!Array.isArray(images) || !images.length) return "";

  // Prefer largest usable URL from the API payload
  for (let i = images.length - 1; i >= 0; i--) {
    const url = (images[i]["#text"] || "").trim();
    if (url) return url;
  }
  return "";
}

function normalizeMusicText(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function upgradeItunesArtworkUrl(url) {
  if (!url) return "";
  return String(url)
    .replace(/^http:\/\//i, "https://")
    .replace(/\/\d+x\d+bb\./, "/300x300bb.")
    .replace(/100x100bb/, "300x300bb")
    .replace(/60x60bb/, "300x300bb");
}

function scoreMusicMatch(wantArtist, wantTrack, itemArtist, itemTrack) {
  let score = 0;
  if (itemArtist === wantArtist) score += 3;
  else if (itemArtist.includes(wantArtist) || wantArtist.includes(itemArtist)) score += 1;
  if (itemTrack === wantTrack) score += 3;
  else if (itemTrack.includes(wantTrack) || wantTrack.includes(itemTrack)) score += 1;
  return score;
}

function jsonpRequest(url, timeoutMs = 8000) {
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

async function fetchItunesArtwork(artist, track) {
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

  const wantArtist = normalizeMusicText(artist);
  const wantTrack = normalizeMusicText(track);
  let best = null;
  let bestScore = -1;

  for (const item of results) {
    if (!item.artworkUrl100) continue;
    const score = scoreMusicMatch(
      wantArtist,
      wantTrack,
      normalizeMusicText(item.artistName),
      normalizeMusicText(item.trackName)
    );
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  if (!best || bestScore < 2) best = results.find((item) => item.artworkUrl100) || null;
  return best ? upgradeItunesArtworkUrl(best.artworkUrl100) : "";
}

async function fetchDeezerArtwork(artist, track) {
  const term = `${artist} ${track}`.trim();
  if (!term) return "";

  // Deezer blocks browser CORS fetch; JSONP works and finds catalogs iTunes misses
  const endpoint =
    "https://api.deezer.com/search/track?limit=8&output=jsonp&q=" +
    encodeURIComponent(term);
  const data = await jsonpRequest(endpoint);
  const results = Array.isArray(data && data.data) ? data.data : [];
  if (!results.length) return "";

  const wantArtist = normalizeMusicText(artist);
  const wantTrack = normalizeMusicText(track);
  let best = null;
  let bestScore = -1;

  for (const item of results) {
    const cover =
      (item.album && (item.album.cover_medium || item.album.cover_big || item.album.cover)) || "";
    if (!cover) continue;
    const score = scoreMusicMatch(
      wantArtist,
      wantTrack,
      normalizeMusicText(item.artist && item.artist.name),
      normalizeMusicText(item.title)
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

async function resolveAlbumArt(track) {
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

function getAlbumArtUrl(track) {
  if (track && typeof track._albumArt === "string") return track._albumArt;
  const lastfmUrl = getLastFmImageUrl(track);
  return isMissingAlbumArt(lastfmUrl) ? "" : lastfmUrl;
}

function rgbCss(r, g, b, a = 1) {
  const rr = Math.max(0, Math.min(255, r | 0));
  const gg = Math.max(0, Math.min(255, g | 0));
  const bb = Math.max(0, Math.min(255, b | 0));
  return a < 1 ? `rgba(${rr}, ${gg}, ${bb}, ${a})` : `rgb(${rr}, ${gg}, ${bb})`;
}

function colorDistance(a, b) {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return dr * dr + dg * dg + db * db;
}

function pickPaletteFromPixels(data) {
  const buckets = new Map();

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (lum < 16 || lum > 245) continue;

    const sat = max === 0 ? 0 : (max - min) / max;
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

  const ranked = [...buckets.values()]
    .map((bucket) => {
      const n = bucket.n;
      const sat = bucket.sat / n;
      return {
        r: Math.round(bucket.r / n),
        g: Math.round(bucket.g / n),
        b: Math.round(bucket.b / n),
        sat,
        score: n * (0.4 + sat)
      };
    })
    .sort((a, b) => b.score - a.score);

  const picked = [];
  for (const color of ranked) {
    if (picked.every((p) => colorDistance(p, color) > 2200)) {
      picked.push(color);
    }
    if (picked.length >= 3) break;
  }

  while (picked.length < 3) {
    const last = picked[picked.length - 1] || { r: 40, g: 40, b: 40, sat: 0 };
    picked.push({
      r: Math.round(last.r * 0.55),
      g: Math.round(last.g * 0.55),
      b: Math.round(last.b * 0.55),
      sat: last.sat
    });
  }

  return picked;
}

function mixColor(a, b, t) {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t
  };
}

function softenColor(color, amount) {
  return mixColor(color, { r: 18, g: 18, b: 18 }, amount);
}

function buildArtGradient(colors) {
  const c0 = softenColor(colors[0], 0.22);
  const c1 = softenColor(colors[1], 0.28);
  const c2 = softenColor(colors[2], 0.36);
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
      Math.round(c1.r * 0.45),
      Math.round(c1.g * 0.45),
      Math.round(c1.b * 0.45)
    )
  };
}

function unwrapWsrvUrl(url) {
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

async function fetchArtBlob(url) {
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

async function sampleAlbumGradient(url) {
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

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function getCardBackgroundEls() {
  const $card = lastFmContainer.find(".lastfm-card").not(".error");
  if (!$card.length) return null;

  let $bg = $card.children(".lastfm-card-bg");
  if (!$bg.length) {
    $card.prepend(
      '<div class="lastfm-card-bg" aria-hidden="true"><div class="lastfm-card-bg-wash"></div></div>'
    );
    $bg = $card.children(".lastfm-card-bg");
  }

  let $wash = $bg.children(".lastfm-card-bg-wash:not(.is-leaving)").last();
  if (!$wash.length) {
    $bg.prepend('<div class="lastfm-card-bg-wash"></div>');
    $wash = $bg.children(".lastfm-card-bg-wash").last();
  }

  return { $card, $bg, $wash };
}

function cardArtUrl($card) {
  if (!$card || !$card.length) return "";
  const $art = $card.find(".lastfm-artwork");
  return (
    $art.attr("data-art-url") ||
    $art.find("img.lastfm-art-front").attr("src") ||
    $art.find("img").first().attr("src") ||
    ""
  );
}

async function syncCardBackground(artUrl) {
  const initial = getCardBackgroundEls();
  if (!initial) return;

  if (!artUrl) {
    lastGradientArtUrl = "";
    initial.$bg.children(".lastfm-card-bg-wash").css({
      opacity: "0",
      backgroundImage: "none"
    });
    initial.$bg.css({ opacity: "0", backgroundColor: "" });
    return;
  }

  // Same cover as last applied wash - keep the drifting layer alive (polls hit this a lot)
  if (artUrl === lastGradientArtUrl) {
    initial.$bg.css("opacity", "1");
    return;
  }

  const token = ++gradientToken;

  try {
    const gradient = await sampleAlbumGradient(artUrl);
    if (token !== gradientToken || !gradient) return;

    const live = getCardBackgroundEls();
    if (!live) return;

    const currentSrc = cardArtUrl(live.$card);
    if (currentSrc && currentSrc !== artUrl) return;

    live.$bg.css("background-color", gradient.fallback);
    live.$bg.css("opacity", "1");

    const $active = live.$wash;
    const activeImage = $active.css("background-image");
    const hasActiveWash = activeImage && activeImage !== "none";

    if (!hasActiveWash || prefersReducedMotion()) {
      live.$bg.children(".lastfm-card-bg-wash.is-leaving, .lastfm-card-bg-wash.is-incoming").remove();
      $active
        .removeClass("is-incoming is-leaving is-shown")
        .css({ backgroundImage: gradient.image, opacity: "1" });
      lastGradientArtUrl = artUrl;
      return;
    }

    // Dual-wash crossfade: incoming over outgoing (snappy vs art fade)
    live.$bg.children(".lastfm-card-bg-wash.is-incoming").remove();
    const $next = $(
      '<div class="lastfm-card-bg-wash is-incoming" aria-hidden="true"></div>'
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
      els.$bg.children(".lastfm-card-bg-wash.is-leaving").remove();
      els.$bg
        .children(".lastfm-card-bg-wash.is-incoming")
        .removeClass("is-incoming is-shown")
        .css("opacity", "1");
      lastGradientArtUrl = artUrl;
    }, GRADIENT_CROSSFADE_MS);
  } catch (err) {
    if (token !== gradientToken) return;
    const live = getCardBackgroundEls();
    if (!live) return;
    const currentSrc = cardArtUrl(live.$card);
    if (currentSrc && currentSrc !== artUrl) return;
    live.$wash.css("background-image", "none");
    live.$bg.css({ opacity: "0", backgroundColor: "" });
  }
}

const USER_INFO_TTL_MS = 12 * 60 * 1000;
let userInfoCache = { data: null, at: 0 };

function formatTimeString(date) {
  if (!date) return "";

  const dateObj = new Date(parseInt(date.uts, 10) * 1000);
  const now = new Date();
  const diffMinutes = Math.floor((now - dateObj) / 60000);

  if (diffMinutes < 1) return "Just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffMinutes < 1440) return `${Math.floor(diffMinutes / 60)}h ago`;

  return dateObj.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  });
}

function getAlbumName(track) {
  const album = track && track.album;
  if (!album) return "";
  return String(album["#text"] || album.title || "").trim();
}

function getArtistName(track) {
  const artist = track && track.artist;
  if (!artist) return "";
  return String(artist["#text"] || artist.name || "").trim();
}

function formatPlayCount(n) {
  const num = parseInt(n, 10);
  if (!Number.isFinite(num) || num < 1) return "";
  return num.toLocaleString("en-US") + (num === 1 ? " play" : " plays");
}

function formatLifetimeLine(user) {
  if (!user) return "";
  const plays = parseInt(user.playcount, 10);
  const registeredRaw =
    user.registered && (user.registered.unixtime || user.registered["#text"]);
  const year = registeredRaw
    ? new Date(parseInt(registeredRaw, 10) * 1000).getFullYear()
    : "";
  const parts = [];
  if (Number.isFinite(plays) && plays > 0) {
    parts.push(plays.toLocaleString("en-US") + " scrobbles");
  }
  if (year) parts.push("since " + year);
  return parts.join(" ");
}

async function fetchUserInfo() {
  if (userInfoCache.data && Date.now() - userInfoCache.at < USER_INFO_TTL_MS) {
    return userInfoCache.data;
  }

  const response = await fetch(
    `${apiUrl}?method=user.getInfo&user=${encodeURIComponent(username)}&api_key=${api_key}&format=json`
  );
  if (!response.ok) throw new Error("user.getInfo failed");
  const data = await response.json();
  if (data.error || !data.user) throw new Error(data.message || "user.getInfo error");

  userInfoCache = { data: data.user, at: Date.now() };
  return data.user;
}

async function fetchTrackUserPlaycount(artist, trackName) {
  if (!artist || !trackName) return "";

  const response = await fetch(
    `${apiUrl}?method=track.getInfo&api_key=${api_key}&format=json&username=${encodeURIComponent(
      username
    )}&artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(
      trackName
    )}&autocorrect=1`
  );
  if (!response.ok) throw new Error("track.getInfo failed");
  const data = await response.json();
  if (data.error || !data.track) return "";
  return data.track.userplaycount || "";
}

function patchCardAlbum(albumName) {
  const $album = lastFmContainer.find(".track-album");
  if (!$album.length) return;
  if (albumName) {
    $album.text(albumName).prop("hidden", false);
  } else {
    $album.text("").prop("hidden", true);
  }
}

function patchCardPlays(playsLabel) {
  const $plays = lastFmContainer.find(".lastfm-plays");
  if (!$plays.length) return;
  if (playsLabel) {
    $plays.text(playsLabel).prop("hidden", false);
  } else {
    $plays.text("").prop("hidden", true);
  }
}

function patchCardLifetime(lifetimeLabel) {
  const $lifetime = lastFmContainer.find(".lastfm-lifetime");
  if (!$lifetime.length) return;
  if (lifetimeLabel) {
    $lifetime.text(lifetimeLabel).prop("hidden", false);
  } else {
    $lifetime.text("").prop("hidden", true);
  }
}

async function enrichCardMeta(track) {
  const identity = getTrackIdentity(track);
  const artist = getArtistName(track);
  const trackName = track && track.name;

  patchCardAlbum(getAlbumName(track));
  document.dispatchEvent(new CustomEvent("lastfm:updated"));

  try {
    const [playcount, user] = await Promise.all([
      fetchTrackUserPlaycount(artist, trackName).catch(() => ""),
      fetchUserInfo().catch(() => null)
    ]);

    if (identity !== lastTrackIdentity) return;

    patchCardPlays(formatPlayCount(playcount));
    patchCardLifetime(formatLifetimeLine(user));
    document.dispatchEvent(new CustomEvent("lastfm:updated"));
  } catch (err) {
    console.warn("Last.fm meta enrich failed:", err);
  }
}

function formatMessage(track) {
  const songName = track.name;
  const artistName = getArtistName(track);
  const albumName = getAlbumName(track);
  const isPlaying = !!(track["@attr"] && track["@attr"].nowplaying);
  const albumArt = getAlbumArtUrl(track);
  const timeString = formatTimeString(track.date);
  const statusClass = isPlaying ? "playing" : "paused";
  const statusText = isPlaying ? "Now Playing" : "Last Played";
  const safeName = escapeHtml(songName);
  const safeArtist = escapeHtml(artistName);
  const safeAlbum = escapeHtml(albumName);
  const safeArt = escapeHtml(albumArt);

  return `
        <div class="lastfm-card ${statusClass}">
            <div class="lastfm-card-bg" aria-hidden="true"><div class="lastfm-card-bg-wash"></div></div>
            <div class="lastfm-artwork"${albumArt ? ` data-art-url="${safeArt}" data-art-for="${escapeHtml(trackArtKey(track))}"` : ` data-art-for="${escapeHtml(trackArtKey(track))}"`}>
              ${
                albumArt
                  ? `<img class="lastfm-art-layer lastfm-art-front is-visible" src="${safeArt}" alt="${safeName}" decoding="async" fetchpriority="high" referrerpolicy="no-referrer" />
              <img class="lastfm-art-layer lastfm-art-back" alt="" decoding="async" referrerpolicy="no-referrer" aria-hidden="true" />`
                  : `<img class="lastfm-art-layer lastfm-art-front" alt="" decoding="async" referrerpolicy="no-referrer" />
              <img class="lastfm-art-layer lastfm-art-back" alt="" decoding="async" referrerpolicy="no-referrer" aria-hidden="true" />`
              }
              <canvas class="dither-overlay-canvas" aria-hidden="true"></canvas>
            </div>
            <div class="lastfm-content">
                <div class="lastfm-main">
                    <div class="lastfm-status">
                        <span class="status-indicator"></span>
                        <span class="status-text">${statusText}</span>
                        <span class="lastfm-time"${timeString ? "" : " hidden"}>${escapeHtml(timeString)}</span>
                    </div>
                    <div class="lastfm-track">
                        <a href="https://last.fm/user/${username}" target="_blank" class="track-link">
                            <div class="track-name" data-sound-hover>${safeName}</div>
                            <div class="track-byline">
                                <div class="track-artist">${safeArtist}</div>
                                <div class="track-album"${albumName ? "" : " hidden"}>${safeAlbum}</div>
                            </div>
                        </a>
                        <div class="lastfm-aside">
                            <div class="lastfm-plays" hidden></div>
                            <div class="lastfm-lifetime" hidden></div>
                        </div>
                    </div>
                </div>
            </div>
            <a href="https://last.fm/user/${username}" target="_blank" rel="noopener" class="lastfm-live" data-sound-hover>Data from Last.fm</a>
        </div>
    `;
}

function getTrackIdentity(track) {
  const nowPlaying = !!(track && track["@attr"] && track["@attr"].nowplaying);
  return `${track.name}|${getArtistName(track)}|${nowPlaying}`;
}

/** Art ownership key - ignores now-playing flag so status flips don't remount covers. */
function trackArtKey(track) {
  if (!track) return "";
  return `${normalizeMusicText(getArtistName(track))}|${normalizeMusicText(track.name)}`;
}

function ensureArtLayers($art) {
  if (!$art.length) return null;

  let $front = $art.children("img.lastfm-art-front");
  let $back = $art.children("img.lastfm-art-back");

  if (!$front.length) {
    const $legacy = $art.children("img").not(".lastfm-art-back").first();
    if ($legacy.length) {
      $legacy.addClass("lastfm-art-layer lastfm-art-front is-visible");
      $front = $legacy;
    } else {
      $art.prepend(
        '<img class="lastfm-art-layer lastfm-art-front" alt="" decoding="async" referrerpolicy="no-referrer" />'
      );
      $front = $art.children("img.lastfm-art-front");
    }
  } else {
    $front.addClass("lastfm-art-layer");
  }

  if (!$back.length) {
    $front.after(
      '<img class="lastfm-art-layer lastfm-art-back" alt="" decoding="async" referrerpolicy="no-referrer" aria-hidden="true" />'
    );
    $back = $art.children("img.lastfm-art-back");
  } else {
    $back.addClass("lastfm-art-layer");
  }

  if (!$art.find(".dither-overlay-canvas").length) {
    $art.append('<canvas class="dither-overlay-canvas" aria-hidden="true"></canvas>');
  }

  return { $front, $back };
}

function bindArtError($img) {
  $img.off("error.lastfmArt");
  $img.on("error.lastfmArt", () => {
    const failed = $img.attr("src");
    if (failed) artFailUrls.add(failed);
    document.dispatchEvent(
      new CustomEvent("lastfm:art-error", { detail: { src: failed || "" } })
    );
  });
}

let artSwapSeq = 0;
let artSwapTimer = 0;

function clearArtSwapTimer() {
  if (artSwapTimer) {
    window.clearTimeout(artSwapTimer);
    artSwapTimer = 0;
  }
}

function artLayers($art) {
  return $art.children("img.lastfm-art-layer");
}

function forceArtReflow($art) {
  if ($art[0]) void $art[0].offsetWidth;
}

function getDisplayedArtUrl($art) {
  if (!$art || !$art.length) return "";
  const $showing = $art.children("img.lastfm-art-layer.is-visible").last().length
    ? $art.children("img.lastfm-art-layer.is-visible").last()
    : $art.children("img.lastfm-art-front").first();
  return ($showing.attr("src") || "") || ($art.attr("data-art-url") || "");
}

function isDisplayedArtBroken($art) {
  if (!$art || !$art.length) return true;
  const $showing = $art.children("img.lastfm-art-layer.is-visible").last().length
    ? $art.children("img.lastfm-art-layer.is-visible").last()
    : $art.children("img.lastfm-art-front").first();
  if (!$showing.length) return true;
  const el = $showing[0];
  const src = $showing.attr("src") || "";
  if (!src) return true;
  return !(el.complete && el.naturalWidth > 0);
}

/** Drop every layer src immediately - never keep a prior cover as a fallback paint. */
function clearArtLayers($art) {
  if (!$art.length) return;
  clearArtSwapTimer();
  $art.removeClass("is-art-swapping").removeAttr("data-art-swap");

  const stale = [];
  artLayers($art).each(function () {
    const s = this.getAttribute("src");
    if (s) stale.push(s);
    $(this)
      .off("load.lastfmArtFade error.lastfmArtFade error.lastfmArt")
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
      .removeClass("lastfm-art-back is-visible is-outgoing")
      .addClass("lastfm-art-layer lastfm-art-front")
      .removeAttr("aria-hidden");
    layers.$back
      .removeClass("lastfm-art-front is-visible is-outgoing")
      .addClass("lastfm-art-layer lastfm-art-back")
      .attr("aria-hidden", "true");
  }

  stale.forEach((url) => releaseArtObjectUrl(url));
  forceArtReflow($art);
}

/**
 * Show cover art for a track. Never crossfades from a previous track's cover -
 * old pixels are cleared first, then the new image fades in alone.
 */
function swapAlbumArt($artOrImg, newSrc, alt, options) {
  const opts = options || {};
  const ownerKey = opts.ownerKey || "";
  const $art = $artOrImg.hasClass("lastfm-artwork")
    ? $artOrImg
    : $artOrImg.closest(".lastfm-artwork");
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
    document.dispatchEvent(new CustomEvent("lastfm:art-updated"));
    return;
  }

  const layers = ensureArtLayers($art);
  if (!layers) return;
  const $front = layers.$front;

  $front
    .off("load.lastfmArtFade error.lastfmArtFade")
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
      document.dispatchEvent(new CustomEvent("lastfm:art-updated"));
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
        document.dispatchEvent(new CustomEvent("lastfm:art-updated"));
      }, ART_CROSSFADE_MS);
    });
  };

  preloadImage(newSrc);
  if ($front[0].complete && $front.attr("src") === newSrc && $front[0].naturalWidth > 0) {
    reveal();
  } else {
    $front.one("load.lastfmArtFade", reveal);
    $front.one("error.lastfmArtFade", () => {
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

function updateCardInPlace(track, options) {
  const opts = options || {};
  const updateArt = opts.art !== false;
  const songName = track.name;
  const artistName = getArtistName(track);
  const albumName = getAlbumName(track);
  const isPlaying = !!(track["@attr"] && track["@attr"].nowplaying);
  const albumArt = getAlbumArtUrl(track);
  const timeString = formatTimeString(track.date);
  const $card = lastFmContainer.find(".lastfm-card").not(".error");

  // Placeholder "Connecting..." card has no track structure - force a full render
  if (!$card.length || !$card.find(".lastfm-content").length || !$card.find(".track-name").length) {
    return false;
  }

  const $content = $card.find(".lastfm-content");
  let $main = $content.children(".lastfm-main");

  // Migrate older card markup into main once
  if (!$main.length) {
    const $status = $content.children(".lastfm-status").detach();
    const $track = $content.children(".lastfm-track").detach();
    const $timeLegacy = $content.find(".lastfm-time").first().detach();
    const $albumLegacy = $content.find(".track-album").first().detach();
    $content.find(".lastfm-meta, .lastfm-aside, .track-album").remove();
    $content.empty().append('<div class="lastfm-main"></div>');
    $main = $content.children(".lastfm-main");
    if ($status.length) $main.append($status);
    if ($track.length) {
      if ($albumLegacy.length) $track.find(".track-link").append($albumLegacy);
      $main.append($track);
    }
    if ($status.length) {
      $status.append($timeLegacy.length ? $timeLegacy : '<span class="lastfm-time" hidden></span>');
    }
  }

  let $track = $main.children(".lastfm-track");
  if (!$track.length) {
    $track = $main.find(".lastfm-track").first();
  }

  // Aside lives beside the byline (not card-bottom absolute)
  let $aside = $track.children(".lastfm-aside");
  if (!$aside.length) {
    const $asideLegacy = $card
      .find(".lastfm-aside")
      .add($content.find(".lastfm-aside"))
      .first()
      .detach();
    $aside = $asideLegacy.length
      ? $asideLegacy
      : $(
          '<div class="lastfm-aside"><div class="lastfm-plays" hidden></div><div class="lastfm-lifetime" hidden></div></div>'
        );
    if ($track.length) {
      $track.append($aside);
    } else {
      $main.append($aside);
    }
  }
  // Remove any duplicate asides left on the card
  $card.children(".lastfm-aside").remove();
  $content.children(".lastfm-aside").remove();

  if (!$card.children(".lastfm-live").length) {
    $card.append(
      `<a href="https://last.fm/user/${username}" target="_blank" rel="noopener" class="lastfm-live" data-sound-hover>Data from Last.fm</a>`
    );
  }

  const $status = $main.find(".lastfm-status");
  let $time = $status.children(".lastfm-time");
  if (!$time.length) {
    // Move stray time nodes into the status row
    const $strayTime = $main.find(".lastfm-time").first().detach();
    $time = $strayTime.length ? $strayTime : $('<span class="lastfm-time" hidden></span>');
    if ($time.is("div")) {
      const label = $time.text();
      const hidden = $time.prop("hidden");
      $time = $('<span class="lastfm-time"></span>').text(label).prop("hidden", hidden);
    }
    $status.append($time);
  }
  $main.children(".lastfm-time").remove();

  const $link = $main.find(".track-link");
  let $byline = $link.children(".track-byline");
  if (!$byline.length) {
    const $artist = $link.children(".track-artist").detach();
    const $album = $link.children(".track-album").detach();
    $byline = $('<div class="track-byline"></div>');
    $byline.append($artist.length ? $artist : '<div class="track-artist"></div>');
    $byline.append($album.length ? $album : '<div class="track-album" hidden></div>');
    $link.append($byline);
  }
  if (!$byline.find(".track-album").length) {
    $byline.append('<div class="track-album" hidden></div>');
  }
  $aside.find(".track-album").remove();

  if (!$aside.find(".lastfm-plays").length) {
    $aside.append('<div class="lastfm-plays" hidden></div>');
  }
  if (!$aside.find(".lastfm-lifetime").length) {
    $aside.append('<div class="lastfm-lifetime" hidden></div>');
  }

  const prevTitle = $card.find(".track-name").text();
  $card.removeClass("playing paused").addClass(isPlaying ? "playing" : "paused");
  $card.find(".status-text").text(isPlaying ? "Now Playing" : "Last Played");
  $card.find(".track-name").text(songName);
  $card.find(".track-artist").text(artistName);
  patchCardAlbum(albumName);
  if (prevTitle !== songName) patchCardPlays("");

  if (timeString) {
    $time.text(timeString).prop("hidden", false);
  } else {
    $time.text("").prop("hidden", true);
  }

  let $art = $card.find(".lastfm-artwork");
  if (!$art.length) {
    $card.prepend(`
      <div class="lastfm-artwork">
        <img class="lastfm-art-layer lastfm-art-front" alt="" decoding="async" referrerpolicy="no-referrer" />
        <img class="lastfm-art-layer lastfm-art-back" alt="" decoding="async" referrerpolicy="no-referrer" aria-hidden="true" />
        <canvas class="dither-overlay-canvas" aria-hidden="true"></canvas>
      </div>
    `);
    $art = $card.find(".lastfm-artwork");
  }

  ensureArtLayers($art);

  const artOwner = trackArtKey(track);
  if (updateArt) {
    if (albumArt) {
      swapAlbumArt($art, albumArt, songName, { ownerKey: artOwner });
    } else {
      swapAlbumArt($art, "", "", { ownerKey: artOwner });
    }
  }

  return true;
}

let lastTrackIdentity = "";
let lastFmUpdateSeq = 0;

async function updateLastFmData() {
  const seq = ++lastFmUpdateSeq;
  const recentTracks = await fetchLastFmData();
  if (seq !== lastFmUpdateSeq) return;

  if (recentTracks.length === 0) {
    lastTrackIdentity = "";
    displayMessage(`
            <div class="lastfm-card error">
                <div class="lastfm-status">
                    <span class="status-text">Unable to load</span>
                </div>
            </div>
        `);
    document.dispatchEvent(new CustomEvent("lastfm:updated"));
    return;
  }

  const latestSong = recentTracks[0];
  // Paint immediately from Last.fm / cache - never block the UI on fallbacks
  applyImmediateArt(latestSong);
  const identity = getTrackIdentity(latestSong);
  const artKey = trackArtKey(latestSong);
  const hasCard = lastFmContainer.find(".lastfm-card").not(".error").length > 0;
  const trackChanged = identity !== lastTrackIdentity;
  const $art = lastFmContainer.find(".lastfm-artwork");
  const artBroken = isDisplayedArtBroken($art);

  if (hasCard && !trackChanged) {
    // Same track: refresh copy, only touch art if the current cover is broken
    updateCardInPlace(latestSong, { art: artBroken });
  } else if (hasCard && updateCardInPlace(latestSong, { art: true })) {
    lastTrackIdentity = identity;
    document.dispatchEvent(new CustomEvent("lastfm:updated"));
  } else {
    lastTrackIdentity = identity;
    displayMessage(formatMessage(latestSong));
    syncCardBackground(getAlbumArtUrl(latestSong));
    document.dispatchEvent(new CustomEvent("lastfm:updated"));
  }

  // Album / plays / lifetime - never block the card paint
  enrichCardMeta(latestSong);

  // Verify the cover actually paints (Last.fm CDN URLs often fail as bare <img>)
  const displayArt = await resolveAlbumArt(latestSong);
  if (seq !== lastFmUpdateSeq) return;
  if (getTrackIdentity(latestSong) !== lastTrackIdentity) return;
  if (trackArtKey(latestSong) !== artKey) return;
  if (!displayArt) return;

  latestSong._albumArt = displayArt;
  const liveArt = lastFmContainer.find(".lastfm-artwork");
  const showing = getDisplayedArtUrl(liveArt);
  const broken = isDisplayedArtBroken(liveArt);
  const ownerMismatch = (liveArt.attr("data-art-for") || "") !== artKey;

  // Never re-apply a previous track's cover. Clear+fade only when this track's paint is wrong.
  if (broken || !showing || ownerMismatch || (trackChanged && showing !== displayArt)) {
    updateCardInPlace(latestSong, { art: true });
  }
  document.dispatchEvent(new CustomEvent("lastfm:art-updated"));
}

function updatePage() {
  updateLastFmData();
  setInterval(updateLastFmData, sleepTime);
}

updatePage();
