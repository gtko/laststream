//! Moteur mpv de la coque Tauri. Reprend la logique de `apps/desktop/src/laststream_app/laststream_player/player.rs`
//! (protocole de `communication.rs`, partagé) : propriétés observées, `mpv-set-prop` (repli int64), commandes
//! `stop`/`loadfile`/`sub-add`/`sub-remove`, sous-titres asynchrones annulés à chaque changement de média,
//! `mpv-event-video-ready` numéroté, reprise après un arrêt inattendu de mpv (3 relances / 60 s, réglages,
//! observations et média rejoués à la dernière position), fin en erreur et message si le budget est épuisé.
//!
//! Ce qui diffère de la coque Windows : la surface vidéo (voir `video.rs` : fenêtre enfant D3D11 sous Windows, calque
//! OpenGL et API de rendu libmpv sous macOS), pas de détection HDR ni de traitement GPU NVIDIA (Windows historique).

use std::collections::VecDeque;
use std::convert::TryFrom;
use std::ffi::{c_char, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use flume::{Receiver, Sender};
use libmpv2::{
    events::{Event, PropertyData},
    mpv_end_file_reason, Format, Mpv,
};
use serde_json::Value;

use crate::laststream_app::ipc::RPCResponse;
use crate::laststream_app::laststream_player::communication::{
    Backend, CmdVal, InMsg, InMsgArgs, InMsgFn, PlayerEnded, PlayerEvent, PlayerProprChange,
    PlayerResponse, PropKey, PropVal,
};
use crate::laststream_app::robust::{
    join_with_timeout, lock, panic_message, report_error, RestartPolicy,
};

use super::video::VideoSurface;
use super::Player;

const MAX_RESTARTS: usize = 3;
const RESTART_WINDOW: Duration = Duration::from_secs(60);
const RESTART_BASE_DELAY: Duration = Duration::from_millis(250);
const GENERATION_STOP_TIMEOUT: Duration = Duration::from_secs(2);
const POSITION_OBSERVER_ID: u64 = u64::MAX;
const MIN_RESUME_SECONDS: f64 = 1.0;
const THREAD_POLL: Duration = Duration::from_millis(100);

const MIB: u64 = 1024 * 1024;
/// Tampon par défaut, identique à la coque Windows (voir apps/desktop/docs/mpv-cache.md).
const BUFFER_OPTIONS: [(&str, &str); 6] = [
    ("cache", "yes"),
    ("cache-secs", "3600"),
    ("demuxer-readahead-secs", "3600"),
    ("demuxer-max-bytes", "125829120"),
    ("demuxer-max-back-bytes", "31457280"),
    ("cache-pause-wait", "5"),
];
const _: () = assert!(120 * MIB == 125829120 && 30 * MIB == 31457280);

struct ObserveProperty {
    name: String,
    format: Format,
}

// ---------- Sous-titres : un client mpv à part, une commande asynchrone à la fois ----------

#[derive(Debug, Eq, PartialEq)]
struct SubtitleCommand {
    name: &'static str,
    args: Vec<String>,
}

impl TryFrom<CmdVal> for SubtitleCommand {
    type Error = CmdVal;
    fn try_from(command: CmdVal) -> Result<Self, Self::Error> {
        match command {
            CmdVal::SubAdd(url, title, language) => Ok(Self {
                name: "sub-add",
                args: vec!["sub-add".into(), url, "auto".into(), title, language],
            }),
            CmdVal::SubRemove(track_id) => Ok(Self {
                name: "sub-remove",
                args: vec!["sub-remove".into(), track_id],
            }),
            command => Err(command),
        }
    }
}

enum SubtitleRequest {
    Command(SubtitleCommand),
    BeginMediaChange(Sender<()>),
    EndMediaChange,
}

struct InFlight {
    reply_id: u64,
    name: &'static str,
}

enum SubtitleEvent {
    Request(Result<SubtitleRequest, flume::RecvError>),
    Wake(Result<(), flume::RecvError>),
}

fn start_next_subtitle(
    mpv: &Mpv,
    queue: &mut VecDeque<SubtitleCommand>,
    in_flight: &mut Option<InFlight>,
    next_id: &mut u64,
    media_change: bool,
) {
    while !media_change && in_flight.is_none() {
        let Some(command) = queue.pop_front() else {
            return;
        };
        let Ok(args) = command
            .args
            .iter()
            .map(|a| CString::new(a.as_str()))
            .collect::<Result<Vec<_>, _>>()
        else {
            eprintln!("mpv: invalid {} argument", command.name);
            continue;
        };
        let mut ptrs = args
            .iter()
            .map(|a| a.as_ptr())
            .chain(std::iter::once(std::ptr::null::<c_char>()))
            .collect::<Vec<_>>();
        let reply_id = *next_id;
        *next_id = next_id.wrapping_add(1).max(1);
        // SAFETY: `mpv.ctx` est un client valide pendant l'emprunt ; `ptrs` est terminé par un pointeur nul et ses chaînes
        // vivent jusqu'à la fin de l'appel (mpv les copie).
        let result = unsafe {
            libmpv2_sys::mpv_command_async(mpv.ctx.as_ptr(), reply_id, ptrs.as_mut_ptr())
        };
        if result < 0 {
            eprintln!(
                "mpv: failed to queue {}: {}",
                command.name,
                libmpv2_sys::mpv_error_str(result)
            );
            continue;
        }
        *in_flight = Some(InFlight {
            reply_id,
            name: command.name,
        });
    }
}

fn subtitle_worker(mpv: &mut Mpv, requests: Receiver<SubtitleRequest>) {
    let (wake_tx, wake_rx) = flume::bounded(1);
    mpv.set_wakeup_callback(move || {
        let _ = wake_tx.try_send(());
    });
    let mut queue = VecDeque::new();
    let mut in_flight: Option<InFlight> = None;
    let mut next_id = 1;
    let mut media_change = false;
    let mut media_change_ack: Option<Sender<()>> = None;
    loop {
        let event = flume::Selector::new()
            .recv(&requests, SubtitleEvent::Request)
            .recv(&wake_rx, SubtitleEvent::Wake)
            .wait();
        match event {
            SubtitleEvent::Request(Ok(SubtitleRequest::Command(command))) => {
                queue.push_back(command)
            }
            SubtitleEvent::Request(Ok(SubtitleRequest::BeginMediaChange(ack))) => {
                media_change = true;
                queue.clear();
                if let Some(command) = &in_flight {
                    media_change_ack = Some(ack);
                    // SAFETY: client valide possédé par ce fil ; un identifiant inconnu est ignoré par mpv.
                    unsafe {
                        libmpv2_sys::mpv_abort_async_command(mpv.ctx.as_ptr(), command.reply_id)
                    };
                } else {
                    let _ = ack.send(());
                }
            }
            SubtitleEvent::Request(Ok(SubtitleRequest::EndMediaChange)) => media_change = false,
            SubtitleEvent::Request(Err(_)) | SubtitleEvent::Wake(Err(_)) => break,
            SubtitleEvent::Wake(Ok(())) => loop {
                // SAFETY: client valide ; l'évènement renvoyé vit jusqu'au prochain mpv_wait_event sur ce client.
                let event = unsafe { &*libmpv2_sys::mpv_wait_event(mpv.ctx.as_ptr(), 0.0) };
                match event.event_id {
                    libmpv2_sys::mpv_event_id_MPV_EVENT_NONE => break,
                    libmpv2_sys::mpv_event_id_MPV_EVENT_SHUTDOWN => return,
                    libmpv2_sys::mpv_event_id_MPV_EVENT_COMMAND_REPLY => {
                        if in_flight
                            .as_ref()
                            .is_none_or(|c| c.reply_id != event.reply_userdata)
                        {
                            continue;
                        }
                        let Some(command) = in_flight.take() else {
                            continue;
                        };
                        if event.error < 0 {
                            eprintln!(
                                "mpv: {} failed: {}",
                                command.name,
                                libmpv2_sys::mpv_error_str(event.error)
                            );
                        }
                        if let Some(ack) = media_change_ack.take() {
                            let _ = ack.send(());
                        }
                    }
                    _ => {}
                }
            },
        }
        start_next_subtitle(mpv, &mut queue, &mut in_flight, &mut next_id, media_change);
    }
}

// ---------- Numéros de chargement (`mpv-event-video-ready`) ----------

#[derive(Debug, Default)]
struct VideoReadyState {
    next_load_id: u64,
    current_load_id: Option<u64>,
    pending_load_ids: VecDeque<u64>,
    active_load_id: Option<u64>,
    file_loaded_id: Option<u64>,
    ready_sent_id: Option<u64>,
}

impl VideoReadyState {
    fn begin_transition(&mut self, loads_file: bool) -> u64 {
        self.next_load_id += 1;
        self.current_load_id = Some(self.next_load_id);
        self.file_loaded_id = None;
        self.ready_sent_id = None;
        if loads_file {
            self.pending_load_ids.push_back(self.next_load_id);
        }
        self.next_load_id
    }
    fn reset_for_restart(&mut self) {
        self.current_load_id = None;
        self.pending_load_ids.clear();
        self.active_load_id = None;
        self.file_loaded_id = None;
        self.ready_sent_id = None;
    }
    fn start_file(&mut self) {
        self.active_load_id = self.pending_load_ids.pop_front();
        self.file_loaded_id = None;
    }
    fn file_loaded(&mut self) {
        if self.active_load_id == self.current_load_id {
            self.file_loaded_id = self.active_load_id;
        }
    }
    fn playback_restarted(&mut self) -> Option<u64> {
        let load_id = self.current_load_id?;
        if self.file_loaded_id != Some(load_id) || self.ready_sent_id == Some(load_id) {
            return None;
        }
        self.ready_sent_id = Some(load_id);
        Some(load_id)
    }
}

// ---------- Reprise après un arrêt inattendu ----------

#[derive(Debug, Default)]
struct ResumeState {
    properties: Vec<(PropKey, PropVal)>,
    observed: Vec<PropKey>,
    load: Option<CmdVal>,
    position: Option<f64>,
}

impl ResumeState {
    fn record_message(&mut self, message: &InMsg) {
        match message {
            InMsg(InMsgFn::MpvSetProp, InMsgArgs::StProp(key, value)) => {
                match self.properties.iter_mut().find(|(k, _)| k == key) {
                    Some(entry) => entry.1 = value.clone(),
                    None => self.properties.push((key.clone(), value.clone())),
                }
            }
            InMsg(InMsgFn::MpvObserveProp, InMsgArgs::ObProp(key)) => {
                if !self.observed.contains(key) {
                    self.observed.push(key.clone());
                }
            }
            InMsg(InMsgFn::MpvCommand, InMsgArgs::Cmd(command)) => match command {
                CmdVal::Loadfile(_) | CmdVal::LoadfileAt(_, _) => {
                    self.load = Some(command.clone());
                    self.position = None;
                }
                CmdVal::Stop => self.clear_media(),
                CmdVal::SubAdd(..) | CmdVal::SubRemove(_) => {}
            },
            _ => {}
        }
    }
    fn clear_media(&mut self) {
        self.load = None;
        self.position = None;
    }
    fn record_position(&mut self, seconds: f64) {
        if self.load.is_some() && seconds.is_finite() && seconds >= 0.0 {
            self.position = Some(seconds);
        }
    }
    fn resume_command(&self) -> Option<CmdVal> {
        let (CmdVal::Loadfile(url) | CmdVal::LoadfileAt(url, _)) = self.load.as_ref()? else {
            return None;
        };
        match self.position {
            Some(s) if s >= MIN_RESUME_SECONDS => {
                Some(CmdVal::LoadfileAt(url.clone(), format!("start=+{s:.3}")))
            }
            _ => self.load.clone(),
        }
    }
    fn replay_messages(&self) -> Vec<InMsg> {
        let mut messages: Vec<InMsg> = self
            .properties
            .iter()
            .map(|(k, v)| InMsg(InMsgFn::MpvSetProp, InMsgArgs::StProp(k.clone(), v.clone())))
            .collect();
        messages.extend(
            self.observed
                .iter()
                .map(|k| InMsg(InMsgFn::MpvObserveProp, InMsgArgs::ObProp(k.clone()))),
        );
        if let Some(command) = self.resume_command() {
            messages.push(InMsg(InMsgFn::MpvCommand, InMsgArgs::Cmd(command)));
        }
        messages
    }
}

// ---------- Contexte partagé par les instances successives de mpv ----------

#[derive(Clone)]
struct Context {
    in_rx: Receiver<String>,
    web_tx: Sender<String>,
    ready: Arc<Mutex<VideoReadyState>>,
    resume: Arc<Mutex<ResumeState>>,
    died: Sender<String>,
    surface: Arc<dyn VideoSurface>,
    /// Appelé quand le budget de relance est épuisé (boîte d'erreur côté coque).
    on_lost: Arc<dyn Fn() + Send + Sync>,
    shutdown: Arc<AtomicBool>,
}

fn send(ctx: &Context, response: PlayerResponse<'static>) {
    ctx.web_tx
        .send(RPCResponse::response_message(response.to_value()))
        .ok();
}

fn signal_death(ctx: &Context, stop: &AtomicBool, cause: &str) {
    if !stop.load(Ordering::SeqCst) {
        let _ = ctx.died.send(cause.to_owned());
    }
}

fn spawn_guarded(
    name: &'static str,
    ctx: &Context,
    stop: &Arc<AtomicBool>,
    body: impl FnOnce() + Send + 'static,
) -> Result<JoinHandle<()>, String> {
    let ctx = ctx.clone();
    let stop = Arc::clone(stop);
    thread::Builder::new()
        .name(name.into())
        .spawn(move || {
            if let Err(payload) = catch_unwind(AssertUnwindSafe(body)) {
                report_error(
                    &format!("lecteur: fil {name} arrêté par une panique"),
                    &panic_message(payload.as_ref()),
                );
                signal_death(&ctx, &stop, name);
            }
        })
        .map_err(|e| format!("fil {name} non démarré: {e}"))
}

fn create_mpv(surface: &dyn VideoSurface) -> Result<Mpv, libmpv2::Error> {
    Mpv::with_initializer(|init| {
        init.set_property("title", "Laststream")?;
        init.set_property("audio-client-name", "Laststream")?;
        init.set_property("terminal", "yes")?;
        // Journal de mpv : muet par défaut ; LASTSTREAM_MPV_LOG=v (ou debug, info…) l'active sur la sortie d'erreur.
        let level = std::env::var("LASTSTREAM_MPV_LOG")
            .ok()
            .filter(|l| {
                [
                    "fatal", "error", "warn", "info", "status", "v", "debug", "trace",
                ]
                .contains(&l.as_str())
            })
            .map(|l| format!("all={l}"))
            .unwrap_or_else(|| {
                if cfg!(debug_assertions) {
                    "all=no,cplayer=debug".into()
                } else {
                    "all=no".into()
                }
            });
        init.set_property("msg-level", level.as_str())?;
        init.set_property("quiet", "yes")?;
        init.set_property(
            "stream-lavf-o",
            "reconnect=1,reconnect_streamed=1,reconnect_on_network_error=1,reconnect_on_http_error=%23%408,429,500,502,503,504,reconnect_delay_max=15",
        )?;
        // `network-timeout` 30 s (LAST-187) ; RTSP par lavf (UDP puis TCP, Freebox, LAST-505).
        for (name, value) in [
            ("network-timeout", "30"),
            ("rtsp-transport", "lavf"),
            ("keep-open", "no"),
        ] {
            if let Err(error) = init.set_property(name, value) {
                eprintln!("mpv: cannot set {name}={value}: {error:?}");
            }
        }
        for (name, value) in surface.mpv_options() {
            if let Err(error) = init.set_property(name, value.as_str()) {
                eprintln!("mpv: cannot set {name}={value}: {error:?}");
            }
        }
        for (name, value) in BUFFER_OPTIONS {
            if let Err(error) = init.set_property(name, value) {
                eprintln!("mpv: cannot set {name}={value}: {error:?}");
            }
        }
        Ok(())
    })
}

/// Une instance de mpv et ses fils.
struct Generation {
    stop: Arc<AtomicBool>,
    mpv: Arc<Mpv>,
    threads: Vec<(&'static str, JoinHandle<()>)>,
    surface: Arc<dyn VideoSurface>,
}

impl Generation {
    fn start(ctx: &Context, preamble: Vec<InMsg>) -> Result<Self, String> {
        let mpv = create_mpv(ctx.surface.as_ref())
            .map_err(|e| format!("mpv: création impossible: {e}"))?;
        let mpv = Arc::new(mpv);
        // macOS : le calque OpenGL se branche sur ce mpv (API de rendu) ; Windows : rien à faire (wid).
        ctx.surface.attach(&mpv);
        let mut generation = Generation {
            stop: Arc::new(AtomicBool::new(false)),
            mpv,
            threads: Vec::new(),
            surface: Arc::clone(&ctx.surface),
        };
        match generation.spawn_threads(ctx, preamble) {
            Ok(()) => Ok(generation),
            Err(error) => {
                generation.stop();
                Err(error)
            }
        }
    }

    fn spawn_threads(&mut self, ctx: &Context, preamble: Vec<InMsg>) -> Result<(), String> {
        let event_client = self
            .mpv
            .create_client(None)
            .map_err(|e| format!("mpv: client d'événements impossible: {e}"))?;
        let subtitle_client = self
            .mpv
            .create_client(None)
            .map_err(|e| format!("mpv: client de sous-titres impossible: {e}"))?;
        let (observe_tx, observe_rx) = flume::unbounded();
        let (c, s) = (ctx.clone(), Arc::clone(&self.stop));
        let handle = spawn_guarded("mpv-events", ctx, &self.stop, move || {
            run_event_loop(event_client, observe_rx, c, s)
        })?;
        self.threads.push(("mpv-events", handle));
        let (m, c, s) = (Arc::clone(&self.mpv), ctx.clone(), Arc::clone(&self.stop));
        let handle = spawn_guarded("mpv-messages", ctx, &self.stop, move || {
            run_message_loop(m, subtitle_client, c, s, observe_tx, preamble)
        })?;
        self.threads.push(("mpv-messages", handle));
        Ok(())
    }

    fn stop(self) {
        self.stop.store(true, Ordering::SeqCst);
        // Le rendu (macOS) est débranché avant la destruction de mpv.
        self.surface.detach();
        let _ = self.mpv.command("quit", &[]);
        let deadline = Instant::now() + GENERATION_STOP_TIMEOUT;
        for (name, handle) in self.threads {
            if !join_with_timeout(handle, deadline.saturating_duration_since(Instant::now())) {
                report_error(&format!("lecteur: fil {name}"), &"toujours actif à l'arrêt");
            }
        }
    }
}

fn supervise(ctx: Context, first: Generation, died: Receiver<String>) {
    let mut policy = RestartPolicy::new(MAX_RESTARTS, RESTART_WINDOW, RESTART_BASE_DELAY);
    let mut current = Some(first);
    while !ctx.shutdown.load(Ordering::SeqCst) {
        let cause = match died.recv_timeout(THREAD_POLL) {
            Ok(cause) => cause,
            Err(flume::RecvTimeoutError::Timeout) => continue,
            Err(flume::RecvTimeoutError::Disconnected) => break,
        };
        report_error("lecteur: arrêt inattendu de mpv", &cause);
        if let Some(generation) = current.take() {
            generation.stop();
        }
        while died.try_recv().is_ok() {}
        match restart(&ctx, &mut policy) {
            Some(generation) => current = Some(generation),
            None if ctx.shutdown.load(Ordering::SeqCst) => break,
            None => {
                report_error("lecteur", &"relances épuisées, mpv reste arrêté");
                send(
                    &ctx,
                    PlayerResponse(
                        "mpv-event-ended",
                        PlayerEvent::End(PlayerEnded::from_end_reason(mpv_end_file_reason::Error)),
                    ),
                );
                (ctx.on_lost)();
                break;
            }
        }
    }
    if let Some(generation) = current {
        generation.stop();
    }
}

fn restart(ctx: &Context, policy: &mut RestartPolicy) -> Option<Generation> {
    loop {
        if ctx.shutdown.load(Ordering::SeqCst) {
            return None;
        }
        let delay = policy.on_failure(Instant::now())?;
        thread::sleep(delay);
        let preamble = lock(&ctx.resume, "reprise du lecteur").replay_messages();
        lock(&ctx.ready, "état du lecteur").reset_for_restart();
        match Generation::start(ctx, preamble) {
            Ok(generation) => return Some(generation),
            Err(error) => report_error("lecteur: relance de mpv échouée", &error),
        }
    }
}

fn prop_change_response(name: &str, change: PropertyData) -> Option<PlayerResponse<'static>> {
    catch_unwind(AssertUnwindSafe(|| {
        PlayerResponse(
            "mpv-prop-change",
            PlayerEvent::PropChange(PlayerProprChange::from_name_value(name.to_string(), change)),
        )
    }))
    .map_err(|p| {
        report_error(
            &format!("lecteur: valeur de {name} illisible"),
            &panic_message(p.as_ref()),
        )
    })
    .ok()
}

fn run_event_loop(
    client: Mpv,
    observe_rx: Receiver<ObserveProperty>,
    ctx: Context,
    stop: Arc<AtomicBool>,
) {
    let _ = client.disable_deprecated_events();
    let _ = client.observe_property("time-pos", Format::Double, POSITION_OBSERVER_ID);
    let mut position_valid = false;
    while !stop.load(Ordering::SeqCst) {
        for ObserveProperty { name, format } in observe_rx.drain() {
            if let Err(error) = client.observe_property(&name, format, 0) {
                eprintln!("lecteur: propriété {name} non observée: {error:?}");
            }
        }
        let event = match client.wait_event(0.1) {
            Some(Ok(event)) => event,
            Some(Err(error)) => {
                eprintln!("Event errored: {error:?}");
                continue;
            }
            None => continue,
        };
        if let Event::PropertyChange {
            change: PropertyData::Double(seconds),
            reply_userdata: POSITION_OBSERVER_ID,
            ..
        } = &event
        {
            if position_valid {
                lock(&ctx.resume, "reprise du lecteur").record_position(*seconds);
            }
            continue;
        }
        match &event {
            Event::StartFile => {
                position_valid = false;
                lock(&ctx.ready, "état du lecteur").start_file();
                continue;
            }
            Event::FileLoaded => {
                position_valid = true;
                lock(&ctx.ready, "état du lecteur").file_loaded();
                continue;
            }
            Event::PlaybackRestart => {
                if let Some(load_id) = lock(&ctx.ready, "état du lecteur").playback_restarted() {
                    send(&ctx, PlayerResponse::video_ready(load_id, true));
                }
                continue;
            }
            _ => {}
        }
        let response = match event {
            Event::PropertyChange { name, change, .. } => {
                match prop_change_response(name, change) {
                    Some(response) => response,
                    None => continue,
                }
            }
            Event::EndFile(reason) => {
                if reason == mpv_end_file_reason::Eof || reason == mpv_end_file_reason::Error {
                    lock(&ctx.resume, "reprise du lecteur").clear_media();
                }
                PlayerResponse(
                    "mpv-event-ended",
                    PlayerEvent::End(PlayerEnded::from_end_reason(reason)),
                )
            }
            Event::Shutdown => {
                signal_death(&ctx, &stop, "mpv s'est arrêté");
                break;
            }
            _ => continue,
        };
        send(&ctx, response);
    }
}

/// `Some(n)` quand un nombre JSON est entier et tient dans un int64.
fn integral_value(value: f64) -> Option<i64> {
    (value.is_finite() && value.fract() == 0.0 && value.abs() < 9.0e15).then_some(value as i64)
}

fn run_message_loop(
    mpv: Arc<Mpv>,
    subtitle_mpv: Mpv,
    ctx: Context,
    stop: Arc<AtomicBool>,
    observe_tx: Sender<ObserveProperty>,
    preamble: Vec<InMsg>,
) {
    let (sub_tx, sub_rx) = flume::unbounded();
    let mut subtitle_mpv = subtitle_mpv;
    let subtitle_thread = thread::Builder::new()
        .name("subtitle-loader".into())
        .spawn(move || {
            if let Err(p) = catch_unwind(AssertUnwindSafe(|| {
                subtitle_worker(&mut subtitle_mpv, sub_rx)
            })) {
                report_error(
                    "lecteur: fil des sous-titres arrêté par une panique",
                    &panic_message(p.as_ref()),
                );
            }
        })
        .map_err(|e| report_error("lecteur: fil des sous-titres non démarré", &e))
        .ok();

    let observe = |name: String, format: Format| {
        observe_tx.send(ObserveProperty { name, format }).ok();
    };
    let set = |name: &str, value: &dyn Fn(&Mpv, &str) -> Result<(), libmpv2::Error>| {
        if let Err(error) = value(&mpv, name) {
            eprintln!("cannot set MPV property {name}: '{error:#}'");
        }
    };
    let command = |cmd: CmdVal| {
        let cmd = match SubtitleCommand::try_from(cmd) {
            Ok(subtitle) => {
                sub_tx.send(SubtitleRequest::Command(subtitle)).ok();
                return;
            }
            Err(cmd) => cmd,
        };
        let transition = cmd.media_transition();
        let (ack_tx, ack_rx) = flume::bounded(1);
        if sub_tx
            .send(SubtitleRequest::BeginMediaChange(ack_tx))
            .is_err()
            || ack_rx.recv().is_err()
        {
            eprintln!("mpv: subtitle worker stopped before media change");
        }
        let parts: Vec<String> = cmd.into();
        if let Some((name, args)) = parts.split_first() {
            if let Some(loads_file) = transition {
                let load_id = lock(&ctx.ready, "état du lecteur").begin_transition(loads_file);
                send(&ctx, PlayerResponse::video_ready(load_id, false));
            }
            let args = args.iter().map(String::as_str).collect::<Vec<_>>();
            let mut result = mpv.command(name, &args);
            // libmpv < 0.38 ne connaît pas l'index de `loadfile <url> replace -1 <options>` : ancienne forme en repli.
            if result.is_err() && name == "loadfile" && args.len() == 4 && args[2] == "-1" {
                result = mpv.command(name, &[args[0], args[1], args[3]]);
            }
            if let Err(error) = result {
                eprintln!("failed to execute MPV command: '{error:#}'");
            }
        }
        sub_tx.send(SubtitleRequest::EndMediaChange).ok();
    };
    let handle = |message: InMsg| match message {
        InMsg(InMsgFn::MpvObserveProp, InMsgArgs::ObProp(key)) => {
            let format = match key {
                PropKey::Bool(_) => Format::Flag,
                PropKey::Int(_) => Format::Int64,
                PropKey::Fp(_) => Format::Double,
                PropKey::Str(_) => Format::String,
            };
            observe(key.to_string(), format);
        }
        InMsg(InMsgFn::MpvSetProp, InMsgArgs::StProp(key, value)) => {
            let name = key.to_string();
            // La surface vidéo choisit la sortie : la page ne la change pas (macOS : rendu libmpv obligatoire).
            if name == "vo" && !ctx.surface.page_may_set_vo() {
                return;
            }
            match value {
                PropVal::Bool(b) => set(&name, &|m, n| m.set_property(n, b)),
                PropVal::Num(x) => {
                    // libmpv refuse un double pour une propriété entière (aid, sid…) : repli en int64.
                    if mpv.set_property(&name, x).is_err() {
                        match integral_value(x) {
                            Some(i) => set(&name, &|m, n| m.set_property(n, i)),
                            None => set(&name, &|m, n| m.set_property(n, x)),
                        }
                    }
                }
                PropVal::Str(s) => {
                    let s = if name == "vo" {
                        with_gpu_next_fallback(s)
                    } else {
                        s
                    };
                    set(&name, &|m, n| m.set_property(n, s.clone()));
                }
            }
        }
        InMsg(InMsgFn::MpvCommand, InMsgArgs::Cmd(cmd)) => command(cmd),
        // Traitement GPU NVIDIA : coque Windows historique seulement.
        InMsg(InMsgFn::MpvSetGpuVideoProcessing, _) => {}
        other => eprintln!("MPV unsupported message: '{other:?}'"),
    };

    for message in preamble {
        handle(message);
    }
    while !stop.load(Ordering::SeqCst) {
        let raw = match ctx.in_rx.recv_timeout(THREAD_POLL) {
            Ok(raw) => raw,
            Err(flume::RecvTimeoutError::Timeout) => continue,
            Err(flume::RecvTimeoutError::Disconnected) => break,
        };
        let message: InMsg = match serde_json::from_str(&raw) {
            Ok(message) => message,
            Err(error) => {
                eprintln!("cannot parse InMsg: {error:#}");
                continue;
            }
        };
        lock(&ctx.resume, "reprise du lecteur").record_message(&message);
        handle(message);
    }
    drop(sub_tx);
    if let Some(handle) = subtitle_thread {
        if !join_with_timeout(handle, GENERATION_STOP_TIMEOUT) {
            report_error("lecteur: fil des sous-titres", &"toujours actif à l'arrêt");
        }
    }
}

/// `vo` demandé par la page : toujours `gpu-next` puis `gpu` en repli (comme la coque Windows).
fn with_gpu_next_fallback(vo: String) -> String {
    let mut outputs: Vec<&str> = vo
        .split(',')
        .map(str::trim)
        .filter(|o| !o.is_empty())
        .collect();
    for required in ["gpu-next", "gpu"] {
        if !outputs.contains(&required) {
            outputs.push(required);
        }
    }
    format!("{},", outputs.join(","))
}

// ---------- Moteur exposé à la coque ----------

pub struct MpvPlayer {
    in_tx: Sender<String>,
    web_tx: Sender<String>,
    shutdown: Arc<AtomicBool>,
}

impl MpvPlayer {
    pub fn start(
        web_tx: Sender<String>,
        surface: Arc<dyn VideoSurface>,
        on_lost: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<Arc<Self>, String> {
        let (in_tx, in_rx) = flume::unbounded();
        let (died_tx, died_rx) = flume::unbounded();
        let shutdown = Arc::new(AtomicBool::new(false));
        let ctx = Context {
            in_rx,
            web_tx: web_tx.clone(),
            ready: Arc::new(Mutex::new(VideoReadyState::default())),
            resume: Arc::new(Mutex::new(ResumeState::default())),
            died: died_tx,
            surface,
            on_lost,
            shutdown: Arc::clone(&shutdown),
        };
        let first = Generation::start(&ctx, Vec::new())?;
        thread::Builder::new()
            .name("mpv-supervisor".into())
            .spawn(move || supervise(ctx, first, died_rx))
            .map_err(|e| e.to_string())?;
        Ok(Arc::new(MpvPlayer {
            in_tx,
            web_tx,
            shutdown,
        }))
    }
}

impl Player for MpvPlayer {
    fn send(&self, args_json: String) {
        self.in_tx.send(args_json).ok();
    }
    fn backends_json(&self) -> String {
        "[\"mpv\"]".into()
    }
    fn send_capabilities(&self) {
        self.web_tx
            .send(RPCResponse::response_message(
                PlayerResponse::capabilities(false).to_value(),
            ))
            .ok();
    }
    fn set_backend(&self, _params: Option<&Value>) {
        // Seul mpv existe ici : toute demande est acquittée par le moteur réellement actif.
        self.web_tx
            .send(RPCResponse::response_message(
                PlayerResponse::backend(Backend::Mpv).to_value(),
            ))
            .ok();
    }
    fn shutdown(&self) {
        self.shutdown.store(true, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integral_numbers_fall_back_to_int64() {
        assert_eq!(integral_value(2.0), Some(2));
        assert_eq!(integral_value(1.5), None);
        assert_eq!(integral_value(f64::NAN), None);
    }

    #[test]
    fn vo_always_keeps_gpu_next_and_gpu() {
        assert_eq!(with_gpu_next_fallback("gpu".into()), "gpu,gpu-next,");
        assert_eq!(
            with_gpu_next_fallback("gpu-next,gpu,".into()),
            "gpu-next,gpu,"
        );
        assert_eq!(
            with_gpu_next_fallback("direct3d".into()),
            "direct3d,gpu-next,gpu,"
        );
    }

    #[test]
    fn resume_replays_settings_observations_then_media_at_position() {
        let mut resume = ResumeState::default();
        let parse = |s: &str| serde_json::from_str::<InMsg>(s).unwrap();
        resume.record_message(&parse(r#"["mpv-set-prop",["volume",50]]"#));
        resume.record_message(&parse(r#"["mpv-observe-prop","time-pos"]"#));
        resume.record_message(&parse(
            r#"["mpv-command",["loadfile","https://x.y/a.mkv"]]"#,
        ));
        resume.record_position(42.5);
        let replay = resume.replay_messages();
        assert_eq!(replay.len(), 3);
        assert_eq!(
            replay[2],
            InMsg(
                InMsgFn::MpvCommand,
                InMsgArgs::Cmd(CmdVal::LoadfileAt(
                    "https://x.y/a.mkv".into(),
                    "start=+42.500".into()
                ))
            )
        );
        resume.record_message(&parse(r#"["mpv-command",["stop"]]"#));
        assert_eq!(resume.replay_messages().len(), 2);
    }

    #[test]
    fn video_ready_fires_once_per_load_after_restart() {
        let mut state = VideoReadyState::default();
        let id = state.begin_transition(true);
        state.start_file();
        assert_eq!(state.playback_restarted(), None, "pas avant FILE_LOADED");
        state.file_loaded();
        assert_eq!(state.playback_restarted(), Some(id));
        assert_eq!(state.playback_restarted(), None, "une seule fois");
    }
}
