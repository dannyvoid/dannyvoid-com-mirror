const V = new URL(import.meta.url).searchParams.get("v") || "0";
const { bust } = await import(`../load.js?v=${encodeURIComponent(V)}`);
const state = await import(bust(import.meta.url, "../state.js"));

const shared = await import(bust(import.meta.url, "../shared.js"));
const art = await import(bust(import.meta.url, "../art.js"));
const liveCard = await import(bust(import.meta.url, "../live-card.js"));
const lastfm = await import(bust(import.meta.url, "./lastfm.js"));

const { nowPlayingContainer, displayMessage, formatPlayCount, fetchJsonWithTimeout } =
  shared;
const { syncCardBackground } = art;
const {
  artistsLabel,
  formatPreviousLine,
  formatLiveMessage,
  patchLiveCardInPlace,
  applyLiveProgressDom
} = liveCard;
const { fetchTrackUserPlaycount, patchCardPlays } = lastfm;

export const id = "spotify";

export function fetchStatus() {
  return fetchJsonWithTimeout("/api/now-playing");
}

export function isActive(payload) {
  return !!(
    payload &&
    !payload.error &&
    payload.playing &&
    payload.track &&
    payload.track.name &&
    payload.is_playing
  );
}

export function isPausedPresent(payload) {
  return !!(
    payload &&
    !payload.error &&
    payload.playing &&
    payload.track &&
    payload.track.name &&
    !payload.is_playing
  );
}

export function activityAt(payload) {
  return Number(payload.activity_at) || Number(payload.fetched_at) || 0;
}

async function enrichSpotifyAside(track, previous, opts) {
  const options = opts || {};
  const artist = artistsLabel(track && track.artists);
  const name = track && track.name;
  const key = `${artist}|${name}`;
  state.setSpotifyAsideKey(key);

  if (!options.playsOnly) {
    const prevLabel = formatPreviousLine(previous);
    const $prev = nowPlayingContainer.find(".now-playing-previous").first();
    if ($prev.length) {
      if (prevLabel) $prev.text(prevLabel).prop("hidden", false);
      else $prev.text("").prop("hidden", true);
    }
    document.dispatchEvent(new CustomEvent("now-playing:updated"));
  }

  const $plays = nowPlayingContainer
    .find(".spotify-progress-center .now-playing-plays, .now-playing-plays")
    .first();
  const playsAlreadyShown =
    $plays.length &&
    !$plays.is("[hidden]") &&
    !!String($plays.text() || "").trim();
  if (options.retryPlays && playsAlreadyShown) return;

  try {
    const playcount = await fetchTrackUserPlaycount(artist, name).catch(() => "");
    if (state.spotifyAsideKey !== key || state.activeSource !== "spotify") return;
    const label = formatPlayCount(playcount);
    if (!label && options.retryPlays) return;
    patchCardPlays(label);
    document.dispatchEvent(new CustomEvent("now-playing:updated"));
  } catch (err) {
    console.warn("Spotify/Last.fm playcount enrich failed:", err);
  }
}

export async function apply(payload, ctx) {
  const track = payload.track;
  if (!track || !track.name) {
    ctx.enterLastFmFallback();
    return;
  }

  if (state.activeSource !== "spotify") {
    ctx.stopLastFmPolling();
    state.setActiveSource("spotify");
    state.setLiveTrackId("");
  }
  ctx.startLiveProgressTimer();
  ctx.setLiveSnap(payload);

  const trackId = track.id || `${track.name}|${artistsLabel(track.artists)}`;
  const trackChanged = trackId !== state.liveTrackId;
  const hasCard =
    nowPlayingContainer.find(".now-playing-card.spotify-live").not(".error").length >
    0;

  if (hasCard && !trackChanged) {
    patchLiveCardInPlace(payload, {
      cardClass: "spotify-live",
      attribution: "Data from Spotify"
    });
    const prevLabel = formatPreviousLine(payload.previous);
    const $prev = nowPlayingContainer.find(".now-playing-previous").first();
    if ($prev.length) {
      if (prevLabel) $prev.text(prevLabel).prop("hidden", false);
      else $prev.text("").prop("hidden", true);
    }
    syncCardBackground(track.art_url || "");
    enrichSpotifyAside(track, payload.previous, {
      playsOnly: true,
      retryPlays: true
    });
  } else {
    state.setLiveTrackId(trackId);
    state.setLastTrackIdentity(`spotify|${trackId}|${payload.is_playing ? 1 : 0}`);
    displayMessage(
      formatLiveMessage(payload, {
        sourceClass: "spotify-live",
        attribution: "Data from Spotify"
      })
    );
    syncCardBackground(track.art_url || "");
    document.dispatchEvent(new CustomEvent("now-playing:updated"));
    document.dispatchEvent(new CustomEvent("now-playing:art-updated"));
    enrichSpotifyAside(track, payload.previous);
  }

  applyLiveProgressDom();
}
