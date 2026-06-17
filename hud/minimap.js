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
let _minimapInfo    = null
let _minimapImg     = null
let _isMultiFloor   = false

const _players = {}
let _bomb          = null   // { wx, wy, wz, state }
let _prevRoundPhase = null
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

  // ── Death markers (X) ─────────────────────────────────────────────
  for (const id in _players) {
    const p = _players[id]
    if (!p.deathPos) continue
    const pxl = worldToCanvas(p.deathPos.wx, p.deathPos.wy, p.deathPos.floor)
    if (!pxl) continue
    const s = 7
    ctx.strokeStyle = p.isCT ? "rgba(96,165,250,0.75)" : "rgba(254,204,6,0.75)"
    ctx.lineWidth = 2.5
    ctx.beginPath()
    ctx.moveTo(pxl.x - s, pxl.y - s); ctx.lineTo(pxl.x + s, pxl.y + s)
    ctx.moveTo(pxl.x + s, pxl.y - s); ctx.lineTo(pxl.x - s, pxl.y + s)
    ctx.stroke()
  }

  // ── Bomb ─────────────────────────────────────────────────────────
  if (_bomb) {
    const bfloor = _isMultiFloor ? getFloor(_bomb.wz) : null
    const bpxl = worldToCanvas(_bomb.wx, _bomb.wy, bfloor)
    if (bpxl) {
      const pulse = _bomb.state === "planted" ? 0.6 + 0.4 * Math.sin(Date.now() / 200) : 1
      ctx.globalAlpha = pulse
      ctx.beginPath()
      ctx.arc(bpxl.x, bpxl.y, 9, 0, Math.PI * 2)
      ctx.fillStyle = _bomb.state === "planted" ? "#ef4444" : "#ef4444"
      ctx.fill()
      ctx.strokeStyle = "#fff"
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.font = "bold 10px sans-serif"
      ctx.textAlign = "center"
      ctx.textBaseline = "middle"
      ctx.fillStyle = "#fff"
      ctx.fillText("C4", bpxl.x, bpxl.y)
      ctx.globalAlpha = 1
    }
  }

  // ── Players ───────────────────────────────────────────────────────
  for (const id in _players) {
    const p = _players[id]
    if (!p.alive) continue
    const floor = p.floor || null
    const pxl = worldToCanvas(p.rx, p.ry, floor)
    if (!pxl) continue

    const color = p.isCT ? "#3b82f6" : "#fecd06"
    const arrowColor = p.isCT ? "rgba(96,165,250,0.9)" : "rgba(254,204,6,0.9)"
    const r = 16

    // Direction arrow (filled triangle)
    const tipDist  = r + 14   // tip of arrow from center
    const baseDist = r + 2    // base of arrow (near circle edge)
    const halfW    = 5        // half-width of arrow base
    const ax = p.angle
    const tx = pxl.x + Math.cos(ax) * tipDist
    const ty = pxl.y + Math.sin(ax) * tipDist
    const bx = pxl.x + Math.cos(ax) * baseDist
    const by = pxl.y + Math.sin(ax) * baseDist
    const px1 = bx + Math.cos(ax + Math.PI / 2) * halfW
    const py1 = by + Math.sin(ax + Math.PI / 2) * halfW
    const px2 = bx + Math.cos(ax - Math.PI / 2) * halfW
    const py2 = by + Math.sin(ax - Math.PI / 2) * halfW
    ctx.beginPath()
    ctx.moveTo(tx, ty)
    ctx.lineTo(px1, py1)
    ctx.lineTo(px2, py2)
    ctx.closePath()
    ctx.fillStyle = arrowColor
    ctx.fill()

    // Circle
    ctx.beginPath()
    ctx.arc(pxl.x, pxl.y, r, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
    ctx.strokeStyle = "rgba(255,255,255,0.9)"
    ctx.lineWidth = 2
    ctx.stroke()

    if (p.num != null) {
      ctx.font = `bold ${Math.round(r * 1.35)}px sans-serif`
      ctx.textAlign    = "center"
      ctx.textBaseline = "middle"
      ctx.fillStyle = "#fff"
      ctx.fillText(String(p.num), pxl.x, pxl.y)
    }
  }
}

// ── State update ──────────────────────────────────────────────────

function updateMinimap(data) {
  const mapName = data.map?.name
  if (mapName) loadMinimapAssets(mapName)

  // Clear death positions on new round (freezetime)
  const roundPhase = data.map?.phase
  if (roundPhase === "freezetime" && _prevRoundPhase !== "freezetime") {
    for (const id in _players) _players[id].deathPos = null
  }
  _prevRoundPhase = roundPhase

  // Bomb position
  const bomb = data.bomb
  if (bomb && bomb.position && (bomb.state === "dropped" || bomb.state === "planted")) {
    const bp = parseVec(bomb.position)
    if (bp) _bomb = { wx: bp.x, wy: bp.y, wz: bp.z, state: bomb.state }
  } else if (!bomb || bomb.state === "defused" || bomb.state === "exploded" || bomb.state === "carried") {
    _bomb = null
  }

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
    // slot is 0-based: slot 0 = key 1, slot 9 = key 0
    const num   = slot != null ? (slot + 1) % 10 : null
    const floor = _isMultiFloor ? getFloor(pos.z) : null

    if (!_players[id]) {
      _players[id] = { rx: pos.x, ry: pos.y, tx: pos.x, ty: pos.y, angle, targetAngle: angle, alive, isCT, num, floor, deathPos: null }
    } else {
      const wasAlive = _players[id].alive
      // Save death position when player just died
      if (wasAlive && !alive) {
        _players[id].deathPos = { wx: _players[id].rx, wy: _players[id].ry, floor: _players[id].floor }
      }
      if (alive) _players[id].deathPos = null
      Object.assign(_players[id], { tx: pos.x, ty: pos.y, targetAngle: angle, alive, isCT, num, floor })
    }
  }

  for (const id in _players) {
    if (!allplayers[id]) delete _players[id]
  }

  startRaf()
}
