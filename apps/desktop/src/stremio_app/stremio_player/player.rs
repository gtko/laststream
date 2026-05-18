use crate::stremio_app::ipc;
use crate::stremio_app::RPCResponse;
use flume::{Receiver, Sender};
use libmpv2::{events::Event, Format, Mpv, SetData};
use native_windows_gui::{self as nwg, PartialUi};
use std::{
    sync::Arc,
    thread::{self, JoinHandle},
};
use winapi::shared::windef::HWND;

use crate::stremio_app::stremio_player::{
    CmdVal, InMsg, InMsgArgs, InMsgFn, PlayerEnded, PlayerEvent, PlayerProprChange, PlayerResponse,
    PropKey, PropVal,
};

struct ObserveProperty {
    name: String,
    format: Format,
}

#[derive(Default)]
pub struct Player {
    pub channel: ipc::Channel,
}

impl PartialUi for Player {
    fn build_partial<W: Into<nwg::ControlHandle>>(
        // @TODO replace with `&mut self`?
        data: &mut Self,
        parent: Option<W>,
    ) -> Result<(), nwg::NwgError> {
        // @TODO replace all `expect`s with proper error handling?

        let window_handle = parent
            .expect("no parent window")
            .into()
            .hwnd()
            .expect("cannot obtain window handle");

        let (in_msg_sender, in_msg_receiver) = flume::unbounded();
        let (rpc_response_sender, rpc_response_receiver) = flume::unbounded();
        let (observe_property_sender, observe_property_receiver) = flume::unbounded();
        data.channel = ipc::Channel::new(Some((in_msg_sender, rpc_response_receiver)));

        let mpv = Arc::new(create_mpv(window_handle));
        let mpv_event_client = mpv
            .create_client(None)
            .expect("cannot create MPV event client");

        let _event_thread = create_event_thread(
            mpv_event_client,
            observe_property_receiver,
            rpc_response_sender,
        );
        let _message_thread = create_message_thread(mpv, observe_property_sender, in_msg_receiver);
        // @TODO implement a mechanism to stop threads on `Player` drop if needed

        Ok(())
    }
}

fn create_mpv(window_handle: HWND) -> Mpv {
    let mpv = Mpv::with_initializer(|initializer| {
        macro_rules! set_property {
            ($name:literal, $value:expr) => {
                initializer
                    .set_property($name, $value)
                    .expect(concat!("failed to set ", $name));
            };
        }
        set_property!("wid", window_handle as i64);
        set_property!("title", "Stremio");
        set_property!("audio-client-name", "Stremio");
        set_property!("terminal", "yes");
        #[cfg(debug_assertions)]
        set_property!("msg-level", "all=no,cplayer=debug");
        #[cfg(not(debug_assertions))]
        set_property!("msg-level", "all=no");
        set_property!("quiet", "yes");
        set_property!("hwdec", "auto");
        // set_property!("vo", "gpu-next,");
        Ok(())
    });
    mpv.expect("cannot build MPV")
}

fn create_event_thread(
    mut mpv_event_client: Mpv,
    observe_property_receiver: Receiver<ObserveProperty>,
    rpc_response_sender: Sender<String>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        mpv_event_client
            .disable_deprecated_events()
            .expect("failed to disable deprecated MPV events");

        // -- Event handler loop --

        loop {
            for ObserveProperty { name, format } in observe_property_receiver.drain() {
                mpv_event_client
                    .observe_property(&name, format, 0)
                    .expect("failed to observer MPV property");
            }

            let event = match mpv_event_client.wait_event(0.1) {
                Some(Ok(event)) => event,
                Some(Err(error)) => {
                    eprintln!("Event errored: {error:?}");
                    continue;
                }
                // dummy event received (may be created on a wake up call or on timeout)
                None => continue,
            };

            // even if you don't do anything with the events, it is still necessary to empty the event loop
            let player_response = match event {
                Event::PropertyChange { name, change, .. } => PlayerResponse(
                    "mpv-prop-change",
                    PlayerEvent::PropChange(PlayerProprChange::from_name_value(
                        name.to_string(),
                        change,
                    )),
                ),
                Event::EndFile(reason) => PlayerResponse(
                    "mpv-event-ended",
                    PlayerEvent::End(PlayerEnded::from_end_reason(reason)),
                ),
                Event::Shutdown => {
                    break;
                }
                _ => continue,
            };

            if let Err(error) =
                rpc_response_sender.send(RPCResponse::response_message(player_response.to_value()))
            {
                eprintln!("failed to send RPCResponse: {error}");
                break;
            }
        }
    })
}

fn create_message_thread(
    mpv: Arc<Mpv>,
    observe_property_sender: Sender<ObserveProperty>,
    in_msg_receiver: Receiver<String>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        // -- Helpers --

        let observe_property = |name: String, format: Format| {
            if let Err(error) = observe_property_sender.send(ObserveProperty { name, format }) {
                eprintln!("cannot send ObserveProperty: {error}");
            }
        };

        let send_command = |cmd: CmdVal| {
            let parts: Vec<String> = cmd.into();
            if let Some((name, args)) = parts.split_first() {
                let args = args.iter().map(String::as_str).collect::<Vec<_>>();
                if let Err(error) = mpv.command(name, &args) {
                    eprintln!("failed to execute MPV command: '{error:#}'")
                }
            }
        };

        fn set_property(name: impl ToString, value: impl SetData, mpv: &Mpv) {
            if let Err(error) = mpv.set_property(&name.to_string(), value) {
                eprintln!("cannot set MPV property: '{error:#}'")
            }
        }

        // -- InMsg handler loop --

        for msg in in_msg_receiver.iter() {
            let in_msg: InMsg = match serde_json::from_str(&msg) {
                Ok(in_msg) => in_msg,
                Err(error) => {
                    eprintln!("cannot parse InMsg:{:?} {error:#}", &msg);
                    continue;
                }
            };

            match in_msg {
                InMsg(InMsgFn::MpvObserveProp, InMsgArgs::ObProp(PropKey::Bool(prop))) => {
                    observe_property(prop.to_string(), Format::Flag);
                }
                InMsg(InMsgFn::MpvObserveProp, InMsgArgs::ObProp(PropKey::Int(prop))) => {
                    observe_property(prop.to_string(), Format::Int64);
                }
                InMsg(InMsgFn::MpvObserveProp, InMsgArgs::ObProp(PropKey::Fp(prop))) => {
                    observe_property(prop.to_string(), Format::Double);
                }
                InMsg(InMsgFn::MpvObserveProp, InMsgArgs::ObProp(PropKey::Str(prop))) => {
                    observe_property(prop.to_string(), Format::String);
                }
                InMsg(InMsgFn::MpvSetProp, InMsgArgs::StProp(name, PropVal::Bool(value))) => {
                    set_property(name, value, &mpv);
                }
                InMsg(InMsgFn::MpvSetProp, InMsgArgs::StProp(name, PropVal::Num(value))) => {
                    set_property(name, value, &mpv);
                }
                InMsg(InMsgFn::MpvSetProp, InMsgArgs::StProp(name, PropVal::Str(value))) => {
                    let value = if name.to_string() == "vo" {
                        let mut value = value;
                        if !value.is_empty() && !value.ends_with(',') {
                            value.push(',');
                        }
                        value.push_str("gpu-next,");
                        value
                    } else {
                        value
                    };
                    set_property(name, value, &mpv);
                }
                InMsg(InMsgFn::MpvCommand, InMsgArgs::Cmd(cmd)) => {
                    send_command(cmd);
                }
                msg => {
                    eprintln!("MPV unsupported message: '{msg:?}'");
                }
            }
        }
    })
}
