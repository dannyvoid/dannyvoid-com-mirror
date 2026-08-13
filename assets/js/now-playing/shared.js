/** DOM helpers, clocks, text normalize, #now-playing root. */

let resetGradientStateFn = () => {};

export function registerGradientReset(fn) {
  resetGradientStateFn = typeof fn === "function" ? fn : () => {};
}

export const nowPlayingContainer = $("#now-playing");

export function displayMessage(message) {
  // Remount wipes .now-playing-card-bg washes - force the next sync to repaint.
  resetGradientStateFn();
  nowPlayingContainer.html(message);
}

export function displayError(message) {
  displayMessage(`<strong class="bold-text2">x ${message}</strong><br /><br />`);
}

export function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function normalizeMediaText(str) {
  return String(str || "")
    .toLowerCase()
    // Strip ASCII + curly apostrophes (U+2018/U+2019)
    .replace(/['\u2018\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function scoreMediaMatch(wantArtist, wantTrack, itemArtist, itemTrack) {
  let score = 0;
  if (itemArtist === wantArtist) score += 3;
  else if (itemArtist.includes(wantArtist) || wantArtist.includes(itemArtist)) score += 1;
  if (itemTrack === wantTrack) score += 3;
  else if (itemTrack.includes(wantTrack) || wantTrack.includes(itemTrack)) score += 1;
  return score;
}

export function formatTimeString(date) {
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

export function getAlbumName(track) {
  const album = track && track.album;
  if (!album) return "";
  return String(album["#text"] || album.title || "").trim();
}

export function getArtistName(track) {
  const artist = track && track.artist;
  if (!artist) return "";
  return String(artist["#text"] || artist.name || "").trim();
}

export function formatPlayCount(n) {
  const num = parseInt(n, 10);
  if (!Number.isFinite(num) || num < 1) return "";
  return num.toLocaleString("en-US") + (num === 1 ? " play" : " plays");
}

export function getTrackIdentity(track) {
  const nowPlaying = !!(track && track["@attr"] && track["@attr"].nowplaying);
  return `${track.name}|${getArtistName(track)}|${nowPlaying}`;
}

/** Art ownership key - ignores now-playing flag so status flips don't remount covers. */
export function trackArtKey(track) {
  if (!track) return "";
  return `${normalizeMediaText(getArtistName(track))}|${normalizeMediaText(track.name)}`;
}

export async function fetchJsonWithTimeout(url, timeoutMs = 3000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      cache: "no-store",
      credentials: "same-origin"
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
