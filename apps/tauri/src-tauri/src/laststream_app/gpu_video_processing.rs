//! Traitement vidéo GPU (NVIDIA RTX VSR / True HDR, D3D11) : propre à la coque Windows historique.
//! Cette coque ne le propose pas : la poignée de main annonce `gpuVideoProcessing=false`.

pub fn gpu_video_processing_supported() -> bool {
    false
}

#[allow(dead_code)]
pub fn unified_memory_architecture() -> bool {
    false
}
