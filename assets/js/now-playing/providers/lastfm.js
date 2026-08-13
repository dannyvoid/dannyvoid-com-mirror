const V = new URL(import.meta.url).searchParams.get("v") || "0";
const { bust } = await import(`../load.js?v=${encodeURIComponent(V)}`);
const state = await import(bust(import.meta.url, "../state.js"));

const shared = await import(bust(import.meta.url, "../shared.js"));
const art = await import(bust(import.meta.url, "../art.js"));

const {
  nowPlayingContainer,
  displayMessage,
  displayError,
  escapeHtml,
  formatTimeString,
  getAlbumName,
  getArtistName,
  formatPlayCount,
  getTrackIdentity,
  trackArtKey
} = shared;

const {
  applyImmediateArt,
  resolveAlbumArt,
  getAlbumArtUrl,
  syncCardBackground,
  swapAlbumArt,
  ensureArtLayers,
  isDisplayedArtBroken,
  getDisplayedArtUrl
} = art;

const username = "dannyvoid";
const api_key = "b34f8d58e1f90e5fd8d36b1a795c92d5";
const apiUrl = `https://ws.audioscrobbler.com/2.0/`;
export const sleepTime = 10000;
const maxRetries = 3;
const retryDelay = 2000;

export function getRecentTracksUrl() {
  return `${apiUrl}?method=user.getRecentTracks&user=${username}&api_key=${api_key}&format=json&limit=1`;
}

export async function fetchLastFmData(retryCount = 0) {
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

const USER_INFO_TTL_MS = 12 * 60 * 1000;
let userInfoCache = { data: null, at: 0 };

export function formatLifetimeLine(user) {
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

export async function fetchUserInfo() {
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

export async function fetchTrackUserPlaycount(artist, trackName) {
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

export function patchCardAlbum(albumName) {
  const $album = nowPlayingContainer.find(".track-album");
  if (!$album.length) return;
  if (albumName) {
    $album.text(albumName).prop("hidden", false);
  } else {
    $album.text("").prop("hidden", true);
  }
}

export function patchCardPlays(playsLabel) {
  const $plays = nowPlayingContainer.find(
    ".spotify-progress-center .now-playing-plays, .now-playing-plays"
  ).first();
  if (!$plays.length) return;
  if (playsLabel) {
    $plays.text(playsLabel).prop("hidden", false);
  } else {
    $plays.text("").prop("hidden", true);
  }
}

export function patchCardLifetime(lifetimeLabel) {
  // Live origin cards reuse the footer slot for "Last: â€¦" - never write account scrobbles there
  if (state.isOriginLiveSource()) return;
  const $lifetime = nowPlayingContainer.find(".now-playing-lifetime");
  if (!$lifetime.length) return;
  if (lifetimeLabel) {
    $lifetime.text(lifetimeLabel).prop("hidden", false);
  } else {
    $lifetime.text("").prop("hidden", true);
  }
}

export async function enrichCardMeta(track) {
  if (state.isOriginLiveSource()) return;
  const identity = getTrackIdentity(track);
  const artist = getArtistName(track);
  const trackName = track && track.name;

  patchCardAlbum(getAlbumName(track));
  document.dispatchEvent(new CustomEvent("now-playing:updated"));

  try {
    const [playcount, user] = await Promise.all([
      fetchTrackUserPlaycount(artist, trackName).catch(() => ""),
      fetchUserInfo().catch(() => null)
    ]);

    // Drop stale Last.fm enrich once an origin live API owns the card (or track changed)
    if (state.isOriginLiveSource() || identity !== state.lastTrackIdentity) return;

    patchCardPlays(formatPlayCount(playcount));
    patchCardLifetime(formatLifetimeLine(user));
    document.dispatchEvent(new CustomEvent("now-playing:updated"));
  } catch (err) {
    console.warn("Last.fm meta enrich failed:", err);
  }
}

export function formatMessage(track) {
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
        <div class="now-playing-card ${statusClass}">
            <div class="now-playing-card-bg" aria-hidden="true"><div class="now-playing-card-bg-wash"></div></div>
            <div class="now-playing-artwork"${albumArt ? ` data-art-url="${safeArt}" data-art-for="${escapeHtml(trackArtKey(track))}"` : ` data-art-for="${escapeHtml(trackArtKey(track))}"`}>
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
                        <span class="now-playing-time"${timeString ? "" : " hidden"}>${escapeHtml(timeString)}</span>
                    </div>
                    <div class="now-playing-track">
                        <a href="https://last.fm/user/${username}" target="_blank" class="track-link">
                            <div class="track-name" data-sound-hover>${safeName}</div>
                            <div class="track-byline">
                                <div class="track-artist">${safeArtist}</div>
                                <div class="track-album"${albumName ? "" : " hidden"}>${safeAlbum}</div>
                            </div>
                        </a>
                        <div class="now-playing-aside">
                            <div class="now-playing-plays" hidden></div>
                            <div class="now-playing-lifetime" hidden></div>
                        </div>
                    </div>
                </div>
            </div>
            <a href="https://last.fm/user/${username}" target="_blank" rel="noopener" class="now-playing-live" data-sound-hover>Data from Last.fm</a>
        </div>
    `;
}

export function updateCardInPlace(track, options) {
  const opts = options || {};
  const updateArt = opts.art !== false;
  const songName = track.name;
  const artistName = getArtistName(track);
  const albumName = getAlbumName(track);
  const isPlaying = !!(track["@attr"] && track["@attr"].nowplaying);
  const albumArt = getAlbumArtUrl(track);
  const timeString = formatTimeString(track.date);
  const $card = nowPlayingContainer.find(".now-playing-card").not(".error");

  // Placeholder "Connecting..." card has no track structure - force a full render
  if (!$card.length || !$card.find(".now-playing-content").length || !$card.find(".track-name").length) {
    return false;
  }

  const $content = $card.find(".now-playing-content");
  let $main = $content.children(".now-playing-main");

  // Migrate older card markup into main once
  if (!$main.length) {
    const $status = $content.children(".now-playing-status").detach();
    const $track = $content.children(".now-playing-track").detach();
    const $timeLegacy = $content.find(".now-playing-time").first().detach();
    const $albumLegacy = $content.find(".track-album").first().detach();
    $content.find(".now-playing-aside, .track-album").remove();
    $content.empty().append('<div class="now-playing-main"></div>');
    $main = $content.children(".now-playing-main");
    if ($status.length) $main.append($status);
    if ($track.length) {
      if ($albumLegacy.length) $track.find(".track-link").append($albumLegacy);
      $main.append($track);
    }
    if ($status.length) {
      $status.append($timeLegacy.length ? $timeLegacy : '<span class="now-playing-time" hidden></span>');
    }
  }

  let $track = $main.children(".now-playing-track");
  if (!$track.length) {
    $track = $main.find(".now-playing-track").first();
  }

  // Aside lives beside the byline (not card-bottom absolute)
  let $aside = $track.children(".now-playing-aside");
  if (!$aside.length) {
    const $asideLegacy = $card
      .find(".now-playing-aside")
      .add($content.find(".now-playing-aside"))
      .first()
      .detach();
    $aside = $asideLegacy.length
      ? $asideLegacy
      : $(
          '<div class="now-playing-aside"><div class="now-playing-plays" hidden></div><div class="now-playing-lifetime" hidden></div></div>'
        );
    if ($track.length) {
      $track.append($aside);
    } else {
      $main.append($aside);
    }
  }
  // Remove any duplicate asides left on the card
  $card.children(".now-playing-aside").remove();
  $content.children(".now-playing-aside").remove();

  if (!$card.children(".now-playing-live").length) {
    $card.append(
      `<a href="https://last.fm/user/${username}" target="_blank" rel="noopener" class="now-playing-live" data-sound-hover>Data from Last.fm</a>`
    );
  }

  const $status = $main.find(".now-playing-status");
  let $time = $status.children(".now-playing-time");
  if (!$time.length) {
    // Move stray time nodes into the status row
    const $strayTime = $main.find(".now-playing-time").first().detach();
    $time = $strayTime.length ? $strayTime : $('<span class="now-playing-time" hidden></span>');
    if ($time.is("div")) {
      const label = $time.text();
      const hidden = $time.prop("hidden");
      $time = $('<span class="now-playing-time"></span>').text(label).prop("hidden", hidden);
    }
    $status.append($time);
  }
  $main.children(".now-playing-time").remove();

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

  if (!$aside.find(".now-playing-plays").length) {
    $aside.append('<div class="now-playing-plays" hidden></div>');
  }
  if (!$aside.find(".now-playing-lifetime").length) {
    $aside.append('<div class="now-playing-lifetime" hidden></div>');
  }

  const prevTitle = $card.find(".track-name").text();
  $card.removeClass("playing paused spotify-live").addClass(isPlaying ? "playing" : "paused");
  $card.find(".status-indicator").remove();
  $card.find(".spotify-progress").remove();
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

  let $art = $card.find(".now-playing-artwork");
  if (!$art.length) {
    $card.prepend(`
      <div class="now-playing-artwork">
        <img class="now-playing-art-layer now-playing-art-front" alt="" decoding="async" referrerpolicy="no-referrer" />
        <img class="now-playing-art-layer now-playing-art-back" alt="" decoding="async" referrerpolicy="no-referrer" aria-hidden="true" />
        <canvas class="dither-overlay-canvas" aria-hidden="true"></canvas>
      </div>
    `);
    $art = $card.find(".now-playing-artwork");
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

export async function updateLastFmData() {
  if (state.isOriginLiveSource()) return;
  const seq = state.bumpLastFmUpdateSeq();
  const recentTracks = await fetchLastFmData();
  if (seq !== state.lastFmUpdateSeq || state.isOriginLiveSource()) return;

  if (recentTracks.length === 0) {
    state.setLastTrackIdentity("");
    displayMessage(`
            <div class="now-playing-card error">
                <div class="now-playing-status">
                    <span class="status-text">Unable to load</span>
                </div>
            </div>
        `);
    document.dispatchEvent(new CustomEvent("now-playing:updated"));
    return;
  }

  const latestSong = recentTracks[0];
  // Paint immediately from Last.fm / cache - never block the UI on fallbacks
  applyImmediateArt(latestSong);
  const identity = getTrackIdentity(latestSong);
  const artKey = trackArtKey(latestSong);
  // Never in-place-patch a Spotify card - remount Last.fm markup instead
  const hasCard =
    nowPlayingContainer.find(".now-playing-card").not(".error").not(".spotify-live").length > 0;
  const trackChanged = identity !== state.lastTrackIdentity;
  const $art = nowPlayingContainer.find(".now-playing-artwork");
  const artBroken = isDisplayedArtBroken($art);

  if (hasCard && !trackChanged) {
    // Same track: refresh copy, only touch art if the current cover is broken
    updateCardInPlace(latestSong, { art: artBroken });
  } else if (hasCard && updateCardInPlace(latestSong, { art: true })) {
    state.setLastTrackIdentity(identity);
    document.dispatchEvent(new CustomEvent("now-playing:updated"));
  } else {
    state.setLastTrackIdentity(identity);
    displayMessage(formatMessage(latestSong));
    syncCardBackground(getAlbumArtUrl(latestSong));
    document.dispatchEvent(new CustomEvent("now-playing:updated"));
  }

  // Album / plays / lifetime - never block the card paint
  enrichCardMeta(latestSong);

  // Verify the cover actually paints (Last.fm CDN URLs often fail as bare <img>)
  const displayArt = await resolveAlbumArt(latestSong);
  if (seq !== state.lastFmUpdateSeq) return;
  if (getTrackIdentity(latestSong) !== state.lastTrackIdentity) return;
  if (trackArtKey(latestSong) !== artKey) return;
  if (!displayArt) return;

  latestSong._albumArt = displayArt;
  const liveArt = nowPlayingContainer.find(".now-playing-artwork");
  const showing = getDisplayedArtUrl(liveArt);
  const broken = isDisplayedArtBroken(liveArt);
  const ownerMismatch = (liveArt.attr("data-art-for") || "") !== artKey;

  // Never re-apply a previous track's cover. Clear+fade only when this track's paint is wrong.
  if (broken || !showing || ownerMismatch || (trackChanged && showing !== displayArt)) {
    updateCardInPlace(latestSong, { art: true });
  }
  document.dispatchEvent(new CustomEvent("now-playing:art-updated"));
}
