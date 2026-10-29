//! ts-listener — two TeamSpeak 3 listener bots for cs2-pro-hud.
//!
//! Bot 0 sits in channel A, bot 1 in channel B. Every 20 ms the voices of each
//! channel are mixed and written to stdout as a binary frame:
//!   b'P', team (0|1), 960 samples i16 LE mono 48 kHz (1920 bytes)
//! Status lines go to stderr as JSON: {"bot":0,"state":"connected","channel":"…"}

use std::cell::RefCell;
use std::io::{Read, Write};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::rc::Rc;
use std::time::Duration;

use futures::prelude::*;
use tokio::task::LocalSet;
use tsclientlib::audio::AudioHandler;
use tsclientlib::{ClientId, Connection, DisconnectOptions, Identity, StreamItem};
use tsproto_packets::packets::AudioData;

const FRAME: usize = 960; // 20 ms @ 48 kHz

#[derive(Clone, Default)]
struct Args {
	address: String,
	password: Option<String>,
	channels: [String; 2],
	names: [String; 2],
	ids_file: String,
}

fn parse_args() -> Args {
	let mut a = Args {
		names: ["HUD Listener 1".into(), "HUD Listener 2".into()],
		ids_file: "ts-identities.txt".into(),
		..Default::default()
	};
	let v: Vec<String> = std::env::args().skip(1).collect();
	let mut i = 0;
	while i < v.len() {
		let val = v.get(i + 1).cloned().unwrap_or_default();
		match v[i].as_str() {
			"--address" => a.address = val,
			"--password" => a.password = Some(val).filter(|s| !s.is_empty()),
			"--channel-a" => a.channels[0] = val,
			"--channel-b" => a.channels[1] = val,
			"--name-a" => a.names[0] = val,
			"--name-b" => a.names[1] = val,
			"--ids" => a.ids_file = val,
			_ => { i += 1; continue; }
		}
		i += 2;
	}
	a
}

fn esc(s: &str) -> String {
	s.chars().flat_map(|c| match c {
		'"' => "\\\"".chars().collect::<Vec<_>>(),
		'\\' => "\\\\".chars().collect(),
		c if (c as u32) < 0x20 => Vec::new(),
		c => vec![c],
	}).collect()
}

fn status(bot: usize, state: &str, extra: &str) {
	let mut e = std::io::stderr().lock();
	let _ = writeln!(e, "{{\"bot\":{},\"state\":\"{}\"{}}}", bot, state, extra);
	let _ = e.flush();
}

/// Identities are stored as "<counter>V<base64 key>", one line per bot, so the
/// bots keep the same unique id between runs (useful for server permissions).
fn load_identity(path: &str, bot: usize) -> Identity {
	let lines: Vec<String> = std::fs::read_to_string(path)
		.map(|s| s.lines().map(|l| l.trim().to_string()).collect())
		.unwrap_or_default();
	if let Some(l) = lines.get(bot) {
		if let Ok(id) = Identity::new_from_ts_str(l) {
			return id;
		}
	}
	let id = Identity::create();
	let mut out = lines.clone();
	while out.len() <= bot { out.push(String::new()); }
	out[bot] = format!("{}V{}", id.counter(), id.key().to_ts());
	let _ = std::fs::write(path, out.join("\n") + "\n");
	id
}

async fn run_bot(bot: usize, args: Args, audio: Rc<RefCell<AudioHandler>>, mut shutdown: tokio::sync::watch::Receiver<bool>) {
	// второй бот стартует чуть позже, чтобы не заходить с одного IP одновременно
	tokio::time::sleep(Duration::from_secs(3 * bot as u64)).await;
	let mut fails: u32 = 0;
	loop {
		let started = std::time::Instant::now();
		let banned;
		let mut opts = Connection::build(args.address.clone())
			.name(args.names[bot].clone())
			.identity(load_identity(&args.ids_file, bot))
			.input_muted(true);
		if !args.channels[bot].is_empty() {
			opts = opts.channel(args.channels[bot].clone());
		}
		if let Some(p) = &args.password {
			opts = opts.password(p.clone());
		}
		status(bot, "connecting", "");
		match opts.connect() {
			Err(e) => {
				let msg = e.to_string();
				banned = msg.contains("Banned");
				status(bot, if banned { "banned" } else { "error" }, &format!(",\"error\":\"{}\"", esc(&msg)));
			}
			Ok(mut con) => {
				let mut reported = false;
				let reason = loop {
					let item = tokio::select! {
						item = async { con.events().next().await } => item,
						_ = shutdown.changed() => {
							// сервер HUD закрылся — выходим вежливо, чтобы TS не держал «мёртвых» ботов
							let _ = con.disconnect(DisconnectOptions::new().message("HUD closed"));
							let _ = tokio::time::timeout(Duration::from_secs(2), con.events().for_each(|_| future::ready(()))).await;
							status(bot, "off", "");
							return;
						}
					};
					match item {
						None => break "closed".to_string(),
						Some(Err(e)) => break e.to_string(),
						Some(Ok(StreamItem::Audio(packet))) => {
							let from = match packet.data().data() {
								AudioData::S2C { from, .. } => *from,
								AudioData::S2CWhisper { from, .. } => *from,
								_ => continue,
							};
							let _ = audio.borrow_mut().handle_packet(ClientId(from), packet);
						}
						Some(Ok(StreamItem::BookEvents(_))) => {
							// report which channel we actually ended up in
							if let Ok(state) = con.get_state() {
								let chan = state.clients.get(&state.own_client)
									.and_then(|c| state.channels.get(&c.channel))
									.map(|c| c.name.clone())
									.unwrap_or_default();
								{
									let line = format!(",\"channel\":\"{}\"", esc(&chan));
									if !reported { status(bot, "connected", &line); reported = true; }
								}
							}
						}
						Some(Ok(StreamItem::DisconnectedTemporarily(r))) => {
							status(bot, "reconnecting", &format!(",\"error\":\"{}\"", esc(&format!("{:?}", r))));
							audio.borrow_mut().reset();
						}
						Some(Ok(_)) => {}
					}
				};
				audio.borrow_mut().reset();
				banned = reason.contains("Banned");
				status(bot, if banned { "banned" } else { "disconnected" }, &format!(",\"error\":\"{}\"", esc(&reason)));
				let _ = con.disconnect(DisconnectOptions::new());
			}
		}
		// Повторы с нарастающей паузой, чтобы антифлуд сервера не банил IP:
		// 10 с, 20 с, 40 с … до 5 минут; после бана — 10 минут.
		if started.elapsed() > Duration::from_secs(120) { fails = 0; }
		fails = fails.saturating_add(1);
		let wait = if banned { 600 } else { (10u64 << (fails - 1).min(5)).min(300) };
		status(bot, if banned { "banned" } else { "waiting" }, &format!(",\"retry_in\":{}", wait));
		tokio::time::sleep(Duration::from_secs(wait)).await;
	}
}

async fn mixer(handlers: [Rc<RefCell<AudioHandler>>; 2], out: SyncSender<Vec<u8>>) {
	let mut tick = tokio::time::interval(Duration::from_millis(20));
	tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Burst);
	let mut stereo = vec![0f32; FRAME * 2];
	let mut frame = vec![0u8; 2 + FRAME * 2];
	loop {
		tick.tick().await;
		for (team, h) in handlers.iter().enumerate() {
			stereo.iter_mut().for_each(|s| *s = 0.0);
			h.borrow_mut().fill_buffer(&mut stereo);
			frame[0] = b'P';
			frame[1] = team as u8;
			for i in 0..FRAME {
				let m = ((stereo[2 * i] + stereo[2 * i + 1]) * 0.5).clamp(-1.0, 1.0);
				let v = (m * 32767.0) as i16;
				frame[2 + 2 * i..4 + 2 * i].copy_from_slice(&v.to_le_bytes());
			}
			// запись в stdout идёт в отдельном потоке: если HUD не успевает читать,
			// кадр просто теряется, а соединение с TS (пинги) не замирает
			let _ = out.try_send(frame.clone());
		}
	}
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
	let args = parse_args();
	if args.address.is_empty() {
		eprintln!("usage: ts-listener --address host[:port] --channel-a \"Name\" --channel-b \"Name\" [--password p] [--name-a n] [--name-b n] [--ids file]");
		std::process::exit(2);
	}
	// поток записи в stdout
	let (tx, rx) = sync_channel::<Vec<u8>>(100);
	std::thread::spawn(move || {
		let mut out = std::io::stdout();
		for frame in rx {
			if out.write_all(&frame).and_then(|_| out.flush()).is_err() {
				std::process::exit(0); // HUD закрыл канал
			}
		}
	});

	// stdin закрылся (HUD остановлен или перезапускает бота) → вежливый выход
	let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
	std::thread::spawn(move || {
		let mut buf = [0u8; 64];
		let mut stdin = std::io::stdin();
		while let Ok(n) = stdin.read(&mut buf) { if n == 0 { break; } }
		let _ = stop_tx.send(true);
		std::thread::sleep(Duration::from_secs(3));
		std::process::exit(0);
	});

	let handlers = [Rc::new(RefCell::new(AudioHandler::new())), Rc::new(RefCell::new(AudioHandler::new()))];
	let local = LocalSet::new();
	for bot in 0..2 {
		if args.channels[bot].is_empty() { continue; }
		local.spawn_local(run_bot(bot, args.clone(), handlers[bot].clone(), stop_rx.clone()));
	}
	local.spawn_local(mixer(handlers.clone(), tx));
	local.await;
}
