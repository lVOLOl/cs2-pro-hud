// ── Webcam delay (vdo.ninja chunked mode) ─────────────────────────────────────
// Turns a saved webcam link into the viewer link actually loaded in the HUD.
// delaySec > 0 → vdo.ninja chunked buffer (video only, max 180 s).
// The player must publish with &chunked=..., e.g. https://vdo.ninja/?push=ID&chunked=1500
const WEBCAM_DELAY_MAX = 180

function buildWebcamUrl(raw, delaySec) {
  if (!raw) return ""
  let u
  try { u = new URL(raw) } catch { return raw }

  if (/(^|\.)vdo\.ninja$/i.test(u.hostname)) {
    // a publisher link pasted by mistake (?push=ID) → turn it into a viewer link
    if (!u.searchParams.has("view") && u.searchParams.get("push")) {
      u.searchParams.set("view", u.searchParams.get("push"))
      u.searchParams.delete("push")
      u.searchParams.delete("webcam")
    }
    // drop delay params that may have been pasted by hand — they are set from settings
    for (const k of ["chunked", "chunkbuffer", "chunkbufferadaptive", "chunkbufferceil", "nochunkaudio"]) {
      u.searchParams.delete(k)
    }
    const d = Math.max(0, Math.min(WEBCAM_DELAY_MAX, Math.round(Number(delaySec) || 0)))
    if (d > 0) {
      if (!u.searchParams.has("noaudio")) u.searchParams.set("noaudio", "")
      u.searchParams.set("nochunkaudio", "")
      u.searchParams.set("chunkbuffer", String(d * 1000))
      u.searchParams.set("chunkbufferadaptive", "0")
      u.searchParams.set("chunkbufferceil", String(WEBCAM_DELAY_MAX * 1000))
    }
  }

  if (!u.searchParams.has("autoplay")) u.searchParams.set("autoplay", "1")
  // bare flags (&noaudio instead of &noaudio=), as in vdo.ninja docs
  return u.toString().replace(/([?&](?:noaudio|nochunkaudio))=(?=&|$)/g, "$1")
}
