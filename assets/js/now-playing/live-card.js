const V = new URL(import.meta.url).searchParams.get("v") || "0";
const { bust } = await import(`./load.js?v=${encodeURIComponent(V)}`);
const state = await import(bust(import.meta.url, "./state.js"));

const shared = await import(bust(import.meta.url, "./shared.js"));
const { nowPlayingContainer, escapeHtml, normalizeMediaText } = shared;

export function formatClock(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function artistsLabel(artists) {
  if (Array.isArray(artists)) return artists.filter(Boolean).join(", ");
  return String(artists || "");
}

export function computeLiveProgress() {
  if (!state.liveSnap) return { progress: 0, duration: 0, pct: 0 };
  const duration = Math.max(0, Number(state.liveSnap.duration_ms) || 0);
  let progress = Math.max(0, Number(state.liveSnap.progress_ms) || 0);
  if (state.liveSnap.is_playing) {
    progress += Math.max(0, Date.now() - (state.liveSnap.fetched_at || Date.now()));
  }
  if (duration > 0) progress = Math.min(progress, duration);
  const pct = duration > 0 ? Math.min(100, (progress / duration) * 100) : 0;
  return { progress, duration, pct };
}

export function liveCardSelector() {
  return ".now-playing-card.spotify-live, .now-playing-card.audiobook-live, .now-playing-card.plex-live";
}

export function applyLiveProgressDom() {
  const $card = nowPlayingContainer.find(liveCardSelector()).not(".error");
  if (!$card.length || !state.liveSnap) return;
  const { progress, duration, pct } = computeLiveProgress();
  $card.find(".spotify-progress-fill").css("width", `${pct}%`);
  $card.find(".spotify-elapsed").text(formatClock(progress));
  $card.find(".spotify-duration").text(formatClock(duration));
}

export function formatLiveMessage(payload, opts) {
  const options = opts || {};
  const sourceClass = options.sourceClass || "spotify-live";
  const statusPlaying = options.statusPlaying || "Now Playing";
  const statusPaused = options.statusPaused || "Paused";
  const attribution = options.attribution || "Data from Spotify";
  const fallbackUrl = options.fallbackUrl || "https://open.spotify.com";
  const linkable = options.linkable !== false;

  const track = payload.track || {};
  const songName = track.name || "";
  const artistName = artistsLabel(track.artists);
  const albumName = track.chapter || track.album || "";
  const albumArt = track.art_url || "";
  const trackUrl = linkable ? track.url || fallbackUrl : "";
  const isPlaying = !!payload.is_playing;
  const statusClass = isPlaying ? "playing" : "paused";
  const statusText = isPlaying ? statusPlaying : statusPaused;
  const safeName = escapeHtml(songName);
  const safeArtist = escapeHtml(artistName);
  const safeAlbum = escapeHtml(albumName);
  const safeArt = escapeHtml(albumArt);
  const safeUrl = escapeHtml(trackUrl);
  const artKey = escapeHtml(
    `${normalizeMediaText(artistName)}|${normalizeMediaText(songName)}`
  );
  const { progress, duration, pct } = (() => {
    const durationMs = Number(payload.duration_ms) || Number(track.duration_ms) || 0;
    let progressMs = Number(payload.progress_ms) || 0;
    if (isPlaying && payload.fetched_at) {
      progressMs += Math.max(0, Date.now() - payload.fetched_at);
    }
    if (durationMs > 0) progressMs = Math.min(progressMs, durationMs);
    return {
      progress: progressMs,
      duration: durationMs,
      pct: durationMs > 0 ? Math.min(100, (progressMs / durationMs) * 100) : 0
    };
  })();

  const trackInner = `
                            <div class="track-name" data-sound-hover>${safeName}</div>
                            <div class="track-byline">
                                <div class="track-artist">${safeArtist}</div>
                                <div class="track-album"${albumName ? "" : " hidden"}>${safeAlbum}</div>
                            </div>`;
  const trackBlock = linkable
    ? `<a href="${safeUrl}" target="_blank" rel="noopener" class="track-link">${trackInner}
                        </a>`
    : `<div class="track-link track-link--nolink">${trackInner}
                        </div>`;
  const liveBlock = linkable
    ? `<a href="${safeUrl}" target="_blank" rel="noopener" class="now-playing-live" data-sound-hover>${escapeHtml(attribution)}</a>`
    : `<span class="now-playing-live now-playing-live--nolink">${escapeHtml(attribution)}</span>`;

  return `
        <div class="now-playing-card ${sourceClass} ${statusClass}">
            <div class="now-playing-card-bg" aria-hidden="true"><div class="now-playing-card-bg-wash"></div></div>
            <div class="now-playing-artwork"${albumArt ? ` data-art-url="${safeArt}" data-art-for="${artKey}"` : ` data-art-for="${artKey}"`}>
              ${
                albumArt
                  ? `<img class="now-playing-art-layer now-playing-art-front is-visible" src="${safeArt}" alt="${safeName}" decoding="async" fetchpriority="high" referrerpolicy="no-referrer" />
              <img class="now-playing-art-layer now-playing-art-back" alt="" decoding="async" referrerpolicy="no-referrer" aria-hidden="true" />`
                  : `<img class="now-playing-art-layer now-playing-art-front" alt="" decoding="async" referrerpolicy="no-referrer" />
              <img class="now-playing-art-layer now-playing-art-back" alt="" decoding="async" referrerpolicy="no-referrer" aria-hidden="true" />`
              }
              <canvas class="dither-overlay-canvas" aria-hidden="true"></canvas>
            </div>
            <div class="now-playing-content">
                <div class="now-playing-main">
                    <div class="now-playing-status">
                        <span class="status-text">${statusText}</span>
                    </div>
                    <div class="now-playing-track">
                        ${trackBlock}
                    </div>
                    <div class="spotify-progress" aria-hidden="true">
                        <div class="spotify-progress-track">
                            <div class="spotify-progress-fill" style="width:${pct}%"></div>
                        </div>
                        <div class="spotify-progress-footer">
                            <span class="spotify-elapsed">${formatClock(progress)}</span>
                            <div class="spotify-progress-center">
                                <div class="now-playing-plays" hidden></div>
                            </div>
                            <div class="spotify-progress-end">
                                <span class="spotify-duration">${formatClock(duration)}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            ${liveBlock}
        </div>
    `;
}

export function patchLiveCardInPlace(payload, opts) {
  const options = opts || {};
  const cardClass = options.cardClass || "spotify-live";
  const statusPlaying = options.statusPlaying || "Now Playing";
  const statusPaused = options.statusPaused || "Paused";
  const attribution = options.attribution || "Data from Spotify";
  const fallbackUrl = options.fallbackUrl || "https://open.spotify.com";
  const linkable = options.linkable !== false;

  const $card = nowPlayingContainer.find(`.now-playing-card.${cardClass}`).not(".error");
  if (!$card.length) return false;

  const track = payload.track || {};
  const songName = track.name || "";
  const artistName = artistsLabel(track.artists);
  const albumName = track.chapter || track.album || "";
  const isPlaying = !!payload.is_playing;

  $card.toggleClass("playing", isPlaying).toggleClass("paused", !isPlaying);
  $card.find(".status-text").text(isPlaying ? statusPlaying : statusPaused);
  $card.find(".track-name").text(songName);
  $card.find(".track-artist").text(artistName);
  const $album = $card.find(".track-album");
  if (albumName) $album.text(albumName).prop("hidden", false);
  else $album.text("").prop("hidden", true);

  if (linkable) {
    const trackUrl = track.url || fallbackUrl;
    $card.find("a.track-link, a.now-playing-live").attr("href", trackUrl);
  }
  $card.find(".now-playing-live").text(attribution);

  applyLiveProgressDom();
  return true;
}
