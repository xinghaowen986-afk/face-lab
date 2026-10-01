// Optional owner-compute configuration.
// Keep this empty for GitHub Pages device-only mode. A host endpoint must be
// HTTPS, authenticated by a short-lived pairing token, and accept a PNG body.
// The host should return the same JSON shape as analysis.js -> analyzePhoto().
window.FACE_LAB_CONFIG = Object.freeze({
  hostEndpoint: '',
  hostPairingToken: '',
});
