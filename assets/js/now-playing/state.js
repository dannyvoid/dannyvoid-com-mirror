/** Shared mutable now-playing state (avoids circular imports). */

export let activeSource = null; // "plex" | "audiobookshelf" | "spotify" | "lastfm"
export let lastTrackIdentity = "";
export let lastFmUpdateSeq = 0;
export let liveTrackId = "";
export let liveSnap = null;
export let spotifyAsideKey = "";
export let lastFmIntervalId = null;
export let livePollTimer = null;
export let liveProgressTimer = null;

export const lastLiveBySource = {
  plex: { payload: null, at: 0 },
  audiobookshelf: { payload: null, at: 0 },
  spotify: { payload: null, at: 0 }
};

export function setActiveSource(v) {
  activeSource = v;
}
export function setLastTrackIdentity(v) {
  lastTrackIdentity = v;
}
export function bumpLastFmUpdateSeq() {
  lastFmUpdateSeq += 1;
  return lastFmUpdateSeq;
}
export function setLiveTrackId(v) {
  liveTrackId = v;
}
export function setLiveSnapValue(v) {
  liveSnap = v;
}
export function setSpotifyAsideKey(v) {
  spotifyAsideKey = v;
}
export function setLastFmIntervalId(v) {
  lastFmIntervalId = v;
}
export function setLivePollTimer(v) {
  livePollTimer = v;
}
export function setLiveProgressTimer(v) {
  liveProgressTimer = v;
}

export function isOriginLiveSource() {
  return (
    activeSource === "spotify" ||
    activeSource === "audiobookshelf" ||
    activeSource === "plex"
  );
}
