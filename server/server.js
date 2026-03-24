const express = require("express")
const bodyParser = require("body-parser")
const http = require("http")
const { Server } = require("socket.io")
const path = require("path")
const { getAvatar } = require("../steam/steam.js")

const app = express()
const server = http.createServer(app)
const io = new Server(server)

let gameState = {}

function normalizeGSI(raw) {
  if (!raw || typeof raw !== "object") return {}
  const d = raw.payload || raw
  return {
    provider: d.provider ?? raw.provider,
    map: d.map ?? raw.map,
    round: d.round ?? raw.round,
    player: d.player ?? raw.player,
    allplayers: d.allplayers ?? raw.allplayers ?? {},
    phase_countdowns: d.phase_countdowns ?? raw.phase_countdowns,
    bomb: d.bomb ?? raw.bomb,
    auth: d.auth ?? raw.auth,
  }
}

app.use(bodyParser.json())

app.post("/", (req, res) => {
  const body = req.body || {}
  gameState = normalizeGSI(body)
  io.emit("state", gameState)
  res.sendStatus(200)
})

app.get("/api/state", (req, res) => {
  res.json(gameState)
})

app.get("/api/test", (req, res) => {
  const sample = {
    map: { name: "de_dust2", team_ct: { score: 5, name: "CT" }, team_t: { score: 3, name: "T" } },
    round: { phase: "live" },
    phase_countdowns: { phase_ends_in: 95 },
    bomb: { countdown: 40, position: "0 0 0" },
    allplayers: {
      "76561198000000001": { name: "Player1", steamid: "76561198000000001", team: "CT", state: { health: 100, money: 4200 }, weapons: { "0": { name: "weapon_ak47", state: "active" } } },
      "76561198000000002": { name: "Player2", steamid: "76561198000000002", team: "CT", state: { health: 80, money: 3200 }, weapons: { "0": { name: "weapon_m4a1", state: "active" } } },
      "76561198000000003": { name: "Player3", steamid: "76561198000000003", team: "T", state: { health: 100, money: 5000 }, weapons: { "0": { name: "weapon_awp", state: "active" } } },
    },
    recent_kills: [
      { killer_steamid: "76561198000000001", victim_steamid: "76561198000000003", weapon: "weapon_ak47", assister_steamid: "76561198000000002", assist_type: "flash" },
      { killer_name: "Player1", victim_name: "Player3", weapon: "ak47", assister_name: "Player2", assist_type: "damage" },
    ],
  }
  gameState = sample
  io.emit("state", sample)
  res.redirect("/")
})

app.get("/avatar/:steamid", async (req, res) => {
  const steamid = req.params.steamid
  if (!steamid) return res.sendStatus(400)
  try {
    const avatarUrl = await getAvatar(steamid)
    if (!avatarUrl) return res.sendStatus(404)
    res.redirect(302, avatarUrl)
  } catch (e) {
    res.sendStatus(502)
  }
})

app.use(express.static(path.join(__dirname, "../hud")))

server.listen(3000,()=>{
 console.log("HUD server running on 3000")
})