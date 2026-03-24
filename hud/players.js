function getSteamAvatar(steamid) {
  if (!steamid) return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64'/%3E"
  return (window.location.origin || "http://localhost:3000") + "/avatar/" + encodeURIComponent(steamid)
}

// function updatePlayers(data){

//     if(!data.allplayers) return
    
//     let ctHTML=""
//     let tHTML=""
    
//     for(let id in data.allplayers){
    
//     let p = data.allplayers[id]
    
//     const state = p.state || p.State || {}
//     const health = (state.health != null ? state.health : state.Health) != null ? (state.health ?? state.Health) : 0
//     const money = (state.money != null ? state.money : state.Money) != null ? (state.money ?? state.Money) : 0
//     const team = (p.team || p.Team || "").toUpperCase()
//     const teamClass = team === "CT" ? "player--ct" : "player--t"
//     let html = `
//     <div class="player ${teamClass}">
//       <div class="player__accent"></div>
//       <div class="player__avatar-wrap">
//         <img class="player__avatar" src="${getSteamAvatar(p.steamid)}" alt="">
//       </div>
//       <div class="player__info">
//         <div class="player__name">${(p.name || "?").replace(/</g, "&lt;")}</div>
//         <div class="player__hp-wrap">
//           <div class="player__hpbar" style="width:${health}%"></div>
//         </div>
//       </div>
//       <img class="player__weapon" src="assets/weapons/${getWeapon(p)}.png" alt="" onerror="this.onerror=null;this.style.display='none';var s=this.nextElementSibling;if(s)s.classList.add('show')">
//       <span class="player__weapon-fallback">${getWeapon(p)}</span>
//       <div class="player__money">$${money}</div>
//     </div>
//     `
    
//     if (team === "CT") ctHTML += html
//     else tHTML += html
    
//     }
    
//     document.getElementById("players_ct").innerHTML = ctHTML
//     document.getElementById("players_t").innerHTML = tHTML
    
//     }
function updatePlayers(data){

    if(!data.allplayers) return
    
    let ctHTML=""
    let tHTML=""
    
    for(let id in data.allplayers){
    
        let p = data.allplayers[id]
    
        const state = p.state || p.State || {}
        const health = (state.health ?? state.Health) ?? 0
        const money = (state.money ?? state.Money) ?? 0
        
        // Универсальная нормализация команды
        let team = (p.team || p.Team || "").toString().toUpperCase().trim()

        // Дополнительные проверки разных форматов
        if(team === "CT" || team === "COUNTER-TERRORIST" || team === "0") team = "CT"
        else if(team === "T" || team === "TERRORIST" || team === "1") team = "T"

        const teamClass = team === "CT" ? "player--ct" : "player--t"
                
        let html = `
        <div class="player ${teamClass}">
          
          <div class="player__accent"></div>
          <div class="player__avatar-wrap">
            <img class="player__avatar" src="${getSteamAvatar(p.steamid)}" alt="">
          </div>
          <div class="player__info">
            <div class="player__info-row">
                <div class="player__name">${(p.name || "?").replace(/</g, "&lt;")}</div>
                <div class="player__hpbar-text">${health} HP</div> 
            </div>
          </div>
          <img class="player__weapon" src="assets/weapons/${getWeapon(p)}.svg" alt="" onerror="this.onerror=null;var s=this.nextElementSibling;if(s)s.classList.add('show')">
          <span class="player__weapon-fallback">${getWeapon(p)}</span>
          <div class="player__money">$${money}</div>
          <div class="player__hpbar" style="width:${health}%"></div>
        </div>
        `
        
        if (team === "CT") ctHTML += html
        else tHTML += html
    
    }
    
    document.getElementById("players_ct").innerHTML = ctHTML
    document.getElementById("players_t").innerHTML = tHTML
}

function getWeapon(player) {
  const weapons = player.weapons || player.Weapons || {}
  for (const w in weapons) {
    const weapon = weapons[w]
    if (!weapon || typeof weapon !== "object") continue
    const state = (weapon.state || weapon.State || "").toLowerCase()
    if (state === "active") {
      const name = weapon.name || weapon.Name || ""
      return String(name).replace(/^weapon_/i, "")
    }
  }
  return "knife"
}

function getWeaponsList(player) {
    const weapons = player.weapons || player.Weapons || {}
    for(let w in weapons){
        const weapon = weapons[w]
        if(!weapon || typeof weapon !== "object") continue
        const state = (weapon.state || weapon.State || "").toLowerCase()
        if(state === "holstered"){
            const name = weapon.name || weapon.Name || ""
            return String(name).replace(/^weapon_/i, "")
        }
    }
    return "knife"
}