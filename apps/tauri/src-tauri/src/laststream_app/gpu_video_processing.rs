//! Traitement vidéo GPU (NVIDIA RTX VSR / True HDR, D3D11) : propre à la coque Windows historique, cette coque ne le
//! propose pas (poignée de main `gpuVideoProcessing=false`). Sous Windows, la détection de la mémoire unifiée du GPU
//! (profil mpv « fast ») reprend le module de la coque Windows.

pub fn gpu_video_processing_supported() -> bool {
    false
}

#[cfg(windows)]
#[path = "../../../../desktop/src/laststream_app/gpu_video_processing.rs"]
#[allow(dead_code)]
mod windows_gpu;

#[cfg(windows)]
pub fn unified_memory_architecture() -> bool {
    windows_gpu::unified_memory_architecture()
}

#[cfg(not(windows))]
pub fn unified_memory_architecture() -> bool {
    false
}
