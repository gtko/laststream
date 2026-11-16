//! Modules partagés avec la coque Windows (`apps/desktop`) : même code source, compilé ici par `#[path]`.
//! Une correction faite dans `apps/desktop/src/laststream_app/<module>.rs` vaut pour les deux coques.
//! Les chemins `crate::laststream_app::…` de ces fichiers se résolvent grâce au nom de ce module.
//! Seul `gpu_video_processing` est propre à cette coque (traitement vidéo GPU NVIDIA : Windows seulement).

#[path = "../../../../desktop/src/laststream_app/addon_http.rs"]
pub mod addon_http;
#[path = "../../../../desktop/src/laststream_app/box_playlist.rs"]
pub mod box_playlist;
#[path = "../../../../desktop/src/laststream_app/constants.rs"]
pub mod constants;
#[path = "../../../../desktop/src/laststream_app/downloads.rs"]
pub mod downloads;
pub mod gpu_video_processing;
#[path = "../../../../desktop/src/laststream_app/ipc.rs"]
pub mod ipc;
pub mod laststream_player;
#[path = "../../../../desktop/src/laststream_app/native_http.rs"]
pub mod native_http;
#[path = "../../../../desktop/src/laststream_app/native_range.rs"]
pub mod native_range;
#[path = "../../../../desktop/src/laststream_app/open_media.rs"]
pub mod open_media;
#[path = "../../../../desktop/src/laststream_app/robust.rs"]
pub mod robust;
#[path = "../../../../desktop/src/laststream_app/sentry_report.rs"]
pub mod sentry_report;
#[path = "../../../../desktop/src/laststream_app/shell_config.rs"]
pub mod shell_config;
#[path = "../../../../desktop/src/laststream_app/updater.rs"]
pub mod updater;

pub use ipc::RPCResponse;
