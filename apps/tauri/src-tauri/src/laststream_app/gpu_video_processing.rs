//! Traitement vidéo GPU (NVIDIA RTX VSR / True HDR, D3D11) : propre à l'ancienne coque Windows, cette coque ne le
//! propose pas (poignée de main `gpuVideoProcessing=false`). Sous Windows, la détection de la mémoire unifiée du GPU
//! (profil mpv « fast ») reprend le module de l'ancienne coque (`gpu_video_processing/windows_gpu.rs`).

pub fn gpu_video_processing_supported() -> bool {
    false
}

#[cfg(windows)]
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
