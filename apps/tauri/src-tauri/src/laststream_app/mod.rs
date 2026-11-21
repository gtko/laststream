//! Modules repris de l'ancienne coque Windows (IPC et liste blanche, ponts natifs, téléchargements, mise à jour signée,
//! diagnostics, protocole du lecteur). Les chemins `crate::laststream_app::…` de ces fichiers se résolvent grâce au nom
//! de ce module.

pub mod addon_http;
pub mod box_playlist;
pub mod constants;
pub mod downloads;
pub mod gpu_video_processing;
pub mod ipc;
pub mod laststream_player;
pub mod native_http;
pub mod native_range;
pub mod open_media;
pub mod robust;
pub mod sentry_report;
pub mod shell_config;
pub mod updater;

pub use ipc::RPCResponse;
