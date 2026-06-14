// MAP_INFO: single-floor maps use flat { pos_x, pos_y, scale }.
// Multi-floor (nuke): one combined image, two floor sections defined by pixel region
// within the 1024×1024 image and their own world-coordinate calibration.
const MAP_INFO = {
  de_dust2:    { pos_x: -2476, pos_y:  3239, scale: 4.4  },
  de_mirage:   { pos_x: -3230, pos_y:  1713, scale: 5.0  },
  de_inferno:  { pos_x: -2087, pos_y:  3870, scale: 4.9  },
  de_overpass: { pos_x: -4831, pos_y:  1781, scale: 5.2  },
  de_vertigo:  { pos_x: -3168, pos_y:  1762, scale: 4.0  },
  de_ancient:  { pos_x: -2953, pos_y:  2164, scale: 5.0  },
  de_anubis:   { pos_x: -2796, pos_y:  3328, scale: 5.22 },

  de_nuke: {
    // Single combined 1024×1024 image containing both floors
    radar: "de_nuke",
    floors: [
      {
        label: "UPPER",
        z_min: -495,
        // World → pixel calibration for this floor's region in the combined image
        pos_x: -3453, pos_y: 1487, scale: 7.0,
        // Pixel rectangle of this floor within the 1024×1024 combined image
        img_x: 0, img_y: 0, img_w: 1024, img_h: 816,
      },
      {
        label: "LOWER",
        z_max: -495,
        pos_x: -803, pos_y: 320, scale: 7.0,
        // Lower section sits in the bottom portion of the combined image
        img_x: 0, img_y: 580, img_w: 570, img_h: 430,
      },
    ],
  },
}

// CSS display width (px). Canvas buffer is 2× for sharpness.
const CSS_W_SINGLE = 350
const CSS_W_MULTI  = 350
const CANVAS_W = CSS_W_SINGLE * 2   // 700px canvas buffer for single-floor

let _minimapMapName = null
let _minimapInfo    = null   // resolved MAP_INFO entry
let _minimapImg     = null   // combined / main image
let _isMultiFloor   = false

const _players = {}
let _rafId         = null
let _lastFrameTime = null
const SMOOTH_SPEED = 6

// ── Asset loading ─────────────────────────────────────────────────

function loadImg(src) {
  return new Promise(resolve => {
    const img = new Image()
    img.onload  = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = `/radar/${src}`
  })
}

function applyCanvasLayout() {
  const canvas = document.getElementById("minimap_canvas")
  const wrap   = document.getElementById("minimap")
  if (!canvas || !wrap) return

  if (_isMultiFloor) {
    // Combined image: canvas = image aspect, displayed at CSS_W_MULTI wide
    const img = _minimapImg
    const aspect = img ? img.naturalHeight / img.naturalWidth : 1
    const cw = CANVAS_W
    const ch = Math.round(cw * aspect)
    canvas.width  = cw
    canvas.height = ch
    wrap.style.width  = CSS_W_MULTI + "px"
    wrap.style.height = Math.round(CSS_W_MULTI * aspect) + "px"
  } else {
    const img = _minimapImg
    const aspect = img ? img.naturalHeight / img.naturalWidth : 1
    canvas.width  = CANVAS_W
    canvas.height = Math.round(CANVAS_W * aspect)
    wrap.style.width  = CSS_W_SINGLE + "px"
    wrap.style.height = Math.round(CSS_W_SINGLE * aspect) + "px"
  }
}

async function loadMinimapAssets(mapName) {
  if (!mapName || mapName === _minimapMapName) return
  _minimapMapName = mapName
  _minimapImg     = null

  const info = MAP_INFO[mapName]
  _minimapInfo  = info || null
  _isMultiFloor = !!(info?.floors)

  const radarName = info?.radar || mapName
  loadImg(radarName).then(img => {
    _minimapImg = img
    applyCanvasLayout()
  })

  if (!info) {
    try {
      const res = await fetch(`/api/mapinfo/${mapName}`)
      if (res.ok) _minimapInfo = await res.json()
    } catch {}
  }

  applyCanvasLayout()
}

// ── Helpers ───────────────────────────────────────────────────────

function parseVec(str) {
  if (!str) return null
  const parts = String(str).split(",").map(s => parseFloat(s.trim()))
  if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) return null
  return { x: parts[0], y: parts[1], z: parts[2] ?? 0 }
}

function lerpAngle(a, b, t) {
  let d = b - a
  while (d >  Math.PI) d -= 2 * Math.PI
  while (d < -Math.PI) d += 2 * Math.PI
  return a + d * t
}

function getFloor(z) {
  if (!_isMultiFloor) return null
  const floors = _minimapInfo.floors
  for (const f of floors) {
    if (f.z_min !== undefined && z < f.z_min) continue
    if (f.z_max !== undefined && z >= f.z_max) continue
    return f
  }
  return floors[floors.length - 1]
}

// World → canvas pixel.
// For single-floor: uses info.pos_x/pos_y/scale + full canvas.
// For multi-floor: uses floor's region within the combined image.
function worldToCanvas(wx, wy, floor) {
  if (!_minimapInfo || !_minimapImg) return null
  const CW = canvas_w()
  const CH = canvas_h()

  if (_isMultiFloor && floor) {
    const { pos_x, pos_y, scale, img_x, img_y } = floor
    // fx/fy: position in image pixels relative to this floor's origin
    const fx = (wx - pos_x) / scale
    const fy = (pos_y - wy)  / scale
    // Offset by floor's pixel origin within the combined image
    const combined_x = img_x + fx
    const combined_y = img_y + fy
    const iw = _minimapImg.naturalWidth  || 1024
    const ih = _minimapImg.naturalHeight || 1024
    return { x: combined_x * (CW / iw), y: combined_y * (CH / ih) }
  }

  // Single-floor
  const { pos_x, pos_y, scale } = _minimapInfo
  const iw = _minimapImg.naturalWidth  || 1024
  const ih = _minimapImg.naturalHeight || 1024
  return {
    x: (wx - pos_x) / scale * (CW / iw),
    y: (pos_y - wy)  / scale * (CH / ih),
  }
}

function canvas_w() {
  return document.getElementById("minimap_canvas")?.width  || CANVAS_W
}
function canvas_h() {
  return document.getElementById("minimap_canvas")?.height || CANVAS_W
}

// ── RAF loop ──────────────────────────────────────────────────────

function startRaf() {
  if (_rafId) return
  function frame(ts) {
    const dt = _lastFrameTime != null ? Math.min((ts - _lastFrameTime) / 1000, 0.1) : 0.016
    _lastFrameTime = ts
    drawMinimap(dt)
    _rafId = requestAnimationFrame(frame)
  }
  _rafId = requestAnimationFrame(frame)
}

function drawMinimap(dt = 0.016) {
  const canvas = document.getElementById("minimap_canvas")
  if (!canvas) return
  const ctx = canvas.getContext("2d")
  const CW = canvas.width
  const CH = canvas.height

  const smooth = 1 - Math.exp(-SMOOTH_SPEED * dt)
  for (const id in _players) {
    const p = _players[id]
    p.rx += (p.tx - p.rx) * smooth
    p.ry += (p.ty - p.ry) * smooth
    p.angle = lerpAngle(p.angle, p.targetAngle, smooth)
  }

  ctx.clearRect(0, 0, CW, CH)

  if (_minimapImg) {
    ctx.globalAlpha = 0.85
    ctx.drawImage(_minimapImg, 0, 0, CW, CH)
    ctx.globalAlpha = 1
  } else {
    ctx.fillStyle = "rgba(10,11,14,0.9)"
    ctx.fillRect(0, 0, CW, CH)
  }

  if (!_minimapInfo) return

  for (const id in _players) {
    const p = _players[id]
    const floor = p.floor || null
    const pxl = worldToCanvas(p.rx, p.ry, floor)
    if (!pxl) continue

    // const color = p.isCT ? "#3b82f6" : "#ef4444"
    const color = p.isCT ? "#3b82f6" : "#fecd06"
    const r     = p.alive ? 11 : 7

    // Direction arrow
    if (p.alive) {
      const len = r + 9
      ctx.beginPath()
      ctx.moveTo(pxl.x, pxl.y)
      ctx.lineTo(pxl.x + Math.cos(p.angle) * len, pxl.y + Math.sin(p.angle) * len)
      ctx.strokeStyle = p.isCT ? "rgba(96,165,250,0.85)" : "rgba(254, 204, 6, 0.85)"
      ctx.lineWidth = 2
      ctx.stroke()
    }

    // Circle
    ctx.beginPath()
    ctx.arc(pxl.x, pxl.y, r, 0, Math.PI * 2)
    if (p.alive) {
      ctx.fillStyle = color
      ctx.fill()
      ctx.strokeStyle = "rgba(255,255,255,0.85)"
      ctx.lineWidth = 1.5
      ctx.stroke()
    } else {
      ctx.fillStyle = "rgba(0,0,0,0.5)"
      ctx.fill()
      ctx.strokeStyle = p.isCT ? "rgba(59,130,246,0.5)" : "rgba(239,68,68,0.5)"
      ctx.lineWidth = 1.5
      ctx.stroke()
    }

    if (p.num != null) {
      ctx.font = `bold ${r * 1.5}px sans-serif`
      ctx.textAlign    = "center"
      ctx.textBaseline = "middle"
      ctx.fillStyle = p.alive ? "#fff" : (p.isCT ? "rgba(96,165,250,0.6)" : "rgba(248,113,113,0.6)")
      ctx.fillText(String(p.num), pxl.x, pxl.y)
    }
  }
}

// ── State update ──────────────────────────────────────────────────

function updateMinimap(data) {
  const mapName = data.map?.name
  if (mapName) loadMinimapAssets(mapName)

  const allplayers = data.allplayers || {}

  for (const id in allplayers) {
    const p = allplayers[id]
    if (!p || !p.position) continue

    const pos   = parseVec(p.position)
    if (!pos) continue

    const fwd   = p.forward ? parseVec(p.forward) : null
    const angle = fwd ? Math.atan2(-fwd.y, fwd.x) : 0
    const alive = (p.state?.health ?? 0) > 0
    const isCT  = (p.team || "").toUpperCase() === "CT"
    const slot  = p.observer_slot ?? null
    const num   = slot === 0 ? 10 : slot
    const floor = _isMultiFloor ? getFloor(pos.z) : null

    if (!_players[id]) {
      _players[id] = { rx: pos.x, ry: pos.y, tx: pos.x, ty: pos.y, angle, targetAngle: angle, alive, isCT, num, floor }
    } else {
      Object.assign(_players[id], { tx: pos.x, ty: pos.y, targetAngle: angle, alive, isCT, num, floor })
    }
  }

  for (const id in _players) {
    if (!allplayers[id]) delete _players[id]
  }

  startRaf()
}
