const V = new URL(import.meta.url).searchParams.get("v") || "0";
const { bust } = await import(`../load.js?v=${encodeURIComponent(V)}`);
const state = await import(bust(import.meta.url, "../state.js"));

const shared = await import(bust(import.meta.url, "../shared.js"));
const art = await import(bust(import.meta.url, "../art.js"));
const liveCard = await import(bust(import.meta.url, "../live-card.js"));

const { nowPlayingContainer, displayMessage, fetchJsonWithTimeout } = shared;
const { syncCardBackground } = art;
const {
  artistsLabel,
  formatLiveMessage,
  patchLiveCardInPlace,
  applyLiveProgressDom
} = liveCard;

export const id = "plex";

export function fetchStatus() {
  return fetchJsonWithTimeout("/api/plex/now-playing");
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

export function activityAt(payload) {
  return Number(payload.activity_at) || Number(payload.fetched_at) || 0;
}

export async function apply(payload, ctx) {
  const track = payload.track;
  if (!track || !track.name) {
    ctx.enterLastFmFallback();
    return;
  }

  if (state.activeSource !== "plex") {
    ctx.stopLastFmPolling();
    state.setActiveSource("plex");
    state.setLiveTrackId("");
  }
  ctx.startLiveProgressTimer();
  ctx.setLiveSnap(payload);

  const trackId = track.id || `${track.name}|${artistsLabel(track.artists)}`;
  const trackChanged = trackId !== state.liveTrackId;
  const hasCard =
    nowPlayingContainer.find(".now-playing-card.plex-live").not(".error").length > 0;

  const plexOpts = {
    sourceClass: "plex-live",
    cardClass: "plex-live",
    statusPlaying: "Watching",
    statusPaused: "Paused",
    attribution: "Data from Plex",
    linkable: false
  };

  if (hasCard && !trackChanged) {
    patchLiveCardInPlace(payload, plexOpts);
    nowPlayingContainer
      .find(".now-playing-plays, .now-playing-previous")
      .prop("hidden", true)
      .text("");
    syncCardBackground(track.art_url || "");
  } else {
    state.setLiveTrackId(trackId);
    state.setLastTrackIdentity(`plex|${trackId}|${payload.is_playing ? 1 : 0}`);
    displayMessage(formatLiveMessage(payload, plexOpts));
    syncCardBackground(track.art_url || "");
    document.dispatchEvent(new CustomEvent("now-playing:updated"));
    document.dispatchEvent(new CustomEvent("now-playing:art-updated"));
  }

  applyLiveProgressDom();
}
