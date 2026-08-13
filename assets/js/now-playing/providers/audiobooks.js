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

export const id = "audiobookshelf";

export function fetchStatus() {
  return fetchJsonWithTimeout("/api/audiobooks/now-playing");
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

  if (state.activeSource !== "audiobookshelf") {
    ctx.stopLastFmPolling();
    state.setActiveSource("audiobookshelf");
    state.setLiveTrackId("");
  }
  ctx.startLiveProgressTimer();
  ctx.setLiveSnap(payload);

  const trackId = track.id || `${track.name}|${artistsLabel(track.artists)}`;
  const trackChanged = trackId !== state.liveTrackId;
  const hasCard =
    nowPlayingContainer
      .find(".now-playing-card.audiobook-live")
      .not(".error").length > 0;

  const absOpts = {
    sourceClass: "audiobook-live",
    cardClass: "audiobook-live",
    statusPlaying: "Reading",
    statusPaused: "Paused",
    attribution: "Data from Audiobookshelf",
    linkable: false
  };

  if (hasCard && !trackChanged) {
    patchLiveCardInPlace(payload, absOpts);
    nowPlayingContainer
      .find(".now-playing-plays, .now-playing-previous")
      .prop("hidden", true)
      .text("");
    syncCardBackground(track.art_url || "");
  } else {
    state.setLiveTrackId(trackId);
    state.setLastTrackIdentity(
      `audiobookshelf|${trackId}|${payload.is_playing ? 1 : 0}`
    );
    displayMessage(formatLiveMessage(payload, absOpts));
    syncCardBackground(track.art_url || "");
    document.dispatchEvent(new CustomEvent("now-playing:updated"));
    document.dispatchEvent(new CustomEvent("now-playing:art-updated"));
  }

  applyLiveProgressDom();
}
