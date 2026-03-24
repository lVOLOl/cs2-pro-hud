const STEAM_KEY = process.env.STEAM_API_KEY || "64851CB8F78D638A8AA31A3857446546"

async function getAvatar(steamid) {
  if (!steamid) return null
  const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_KEY}&steamids=${steamid}`
  const res = await fetch(url)
  const json = await res.json()
  const players = json.response?.players
  if (!players || players.length === 0) return null
  return players[0].avatarfull || null
}

module.exports = { getAvatar }