//! Surface vidéo de mpv, sous la page transparente.
//!  - Windows : fenêtre enfant (STATIC, noire) au fond de la fenêtre principale, sous la WebView2 ; mpv y dessine
//!    lui-même (`wid`, D3D11, mêmes options que la coque Windows historique).
//!  - macOS : API de rendu libmpv (OpenGL) dans un calque placé sous la WKWebView (`mac/mpv_layer.m`), `vo=libmpv`.
//!  - Autres (Linux, développement) : mpv ouvre sa propre fenêtre.

use std::sync::Arc;

use libmpv2::Mpv;
use tauri::{Runtime, WebviewWindow};

pub trait VideoSurface: Send + Sync {
    /// Options mpv propres à la surface (sortie vidéo, décodage), posées à la création de mpv.
    fn mpv_options(&self) -> Vec<(&'static str, String)>;
    /// Un nouveau mpv est créé (au démarrage ou après une relance).
    fn attach(&self, _mpv: &Arc<Mpv>) {}
    /// Avant la destruction de mpv.
    fn detach(&self) {}
    /// La page peut-elle changer `vo` ? (Non sous macOS : le rendu passe obligatoirement par libmpv.)
    fn page_may_set_vo(&self) -> bool {
        true
    }
    /// La zone cliente de la fenêtre a changé (pixels physiques).
    fn resized(&self, _width: u32, _height: u32) {}
    /// Facteur d'échelle de l'écran courant.
    fn scale_changed(&self, _scale: f64) {}
}

/// Surface de la plateforme, créée pour la fenêtre principale.
pub fn create<R: Runtime>(window: &WebviewWindow<R>) -> Arc<dyn VideoSurface> {
    platform::create(window)
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::sync::atomic::{AtomicIsize, Ordering};
    use winapi::shared::windef::HWND;
    use winapi::um::winuser::{
        CreateWindowExW, SetWindowPos, HWND_BOTTOM, SS_BLACKRECT, SWP_NOACTIVATE, SWP_NOMOVE,
        SWP_NOSIZE, WS_CHILD, WS_CLIPCHILDREN, WS_VISIBLE,
    };

    pub struct WindowsSurface {
        child: AtomicIsize,
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn create<R: Runtime>(window: &WebviewWindow<R>) -> Arc<dyn VideoSurface> {
        let surface = Arc::new(WindowsSurface {
            child: AtomicIsize::new(0),
        });
        let Ok(parent) = window.hwnd() else {
            return surface;
        };
        let parent = parent.0 as isize;
        let size = window.inner_size().unwrap_or_default();
        let (tx, rx) = std::sync::mpsc::channel();
        // Fenêtre enfant créée sur le fil de l'interface (celui de la fenêtre parente).
        let _ = window.run_on_main_thread(move || {
            let class = wide("STATIC");
            let title = wide("Laststream video");
            // SAFETY: `parent` est la fenêtre principale vivante ; classe système STATIC ; chaînes terminées par zéro.
            let child = unsafe {
                CreateWindowExW(
                    0,
                    class.as_ptr(),
                    title.as_ptr(),
                    WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN | SS_BLACKRECT,
                    0,
                    0,
                    size.width as i32,
                    size.height as i32,
                    parent as HWND,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            };
            if !child.is_null() {
                // SAFETY: `child` vient d'être créée ; tout en bas de l'ordre Z, sous la WebView2.
                unsafe {
                    SetWindowPos(
                        child,
                        HWND_BOTTOM,
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                    )
                };
            }
            let _ = tx.send(child as isize);
        });
        if let Ok(child) = rx.recv_timeout(std::time::Duration::from_secs(2)) {
            surface.child.store(child, Ordering::SeqCst);
        }
        surface
    }

    impl VideoSurface for WindowsSurface {
        fn mpv_options(&self) -> Vec<(&'static str, String)> {
            let mut options = vec![
                ("vo", "gpu-next,gpu,".to_string()),
                ("hwdec", "auto".to_string()),
                ("gpu-context", "d3d11".to_string()),
                ("d3d11-output-format", "auto".to_string()),
                ("d3d11-output-csp", "auto".to_string()),
                ("target-colorspace-hint", "auto".to_string()),
                ("target-colorspace-hint-mode", "target".to_string()),
                ("tone-mapping", "bt.2390".to_string()),
                ("dither-depth", "auto".to_string()),
            ];
            let child = self.child.load(Ordering::SeqCst);
            if child != 0 {
                options.push(("wid", child.to_string()));
            }
            if crate::laststream_app::gpu_video_processing::unified_memory_architecture() {
                options.push(("profile", "fast".to_string()));
            } else {
                options.extend([
                    ("deband", "yes".to_string()),
                    ("scale", "spline36".to_string()),
                    ("cscale", "spline36".to_string()),
                ]);
            }
            options
        }

        fn resized(&self, width: u32, height: u32) {
            let child = self.child.load(Ordering::SeqCst);
            if child != 0 {
                // SAFETY: fenêtre enfant créée par cette surface ; SetWindowPos est sûr depuis n'importe quel fil.
                unsafe {
                    SetWindowPos(
                        child as HWND,
                        HWND_BOTTOM,
                        0,
                        0,
                        width as i32,
                        height as i32,
                        SWP_NOACTIVATE,
                    )
                };
            }
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicPtr, Ordering};

    extern "C" {
        fn ls_mpv_view_create(ns_window: *mut c_void) -> *mut c_void;
        fn ls_mpv_view_attach(view: *mut c_void, mpv: *mut c_void);
        fn ls_mpv_view_detach(view: *mut c_void);
        fn ls_mpv_view_set_scale(view: *mut c_void, scale: f64);
    }

    pub struct MacSurface {
        view: AtomicPtr<c_void>,
    }

    pub fn create<R: Runtime>(window: &WebviewWindow<R>) -> Arc<dyn VideoSurface> {
        let view = match window.ns_window() {
            // SAFETY: NSWindow vivant de la fenêtre principale ; la vue est créée sur le fil principal (dispatch_sync).
            Ok(ns_window) => unsafe { ls_mpv_view_create(ns_window) },
            Err(_) => std::ptr::null_mut(),
        };
        Arc::new(MacSurface {
            view: AtomicPtr::new(view),
        })
    }

    impl VideoSurface for MacSurface {
        fn mpv_options(&self) -> Vec<(&'static str, String)> {
            vec![
                ("vo", "libmpv".to_string()),
                ("hwdec", "auto-safe".to_string()),
            ]
        }
        fn attach(&self, mpv: &Arc<Mpv>) {
            let view = self.view.load(Ordering::SeqCst);
            if !view.is_null() {
                // SAFETY: vue créée par `ls_mpv_view_create` ; le mpv_handle reste valide jusqu'à `detach`.
                unsafe { ls_mpv_view_attach(view, mpv.ctx.as_ptr() as *mut c_void) };
            }
        }
        fn detach(&self) {
            let view = self.view.load(Ordering::SeqCst);
            if !view.is_null() {
                // SAFETY: vue valide ; libération synchrone du contexte de rendu, avant la destruction de mpv.
                unsafe { ls_mpv_view_detach(view) };
            }
        }
        fn page_may_set_vo(&self) -> bool {
            false
        }
        fn scale_changed(&self, scale: f64) {
            let view = self.view.load(Ordering::SeqCst);
            if !view.is_null() {
                // SAFETY: vue valide ; appliqué sur le fil principal.
                unsafe { ls_mpv_view_set_scale(view, scale) };
            }
        }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
    use super::*;

    /// Développement (Linux) : mpv ouvre sa propre fenêtre.
    pub struct DetachedSurface;

    pub fn create<R: Runtime>(_window: &WebviewWindow<R>) -> Arc<dyn VideoSurface> {
        Arc::new(DetachedSurface)
    }

    impl VideoSurface for DetachedSurface {
        fn mpv_options(&self) -> Vec<(&'static str, String)> {
            vec![
                ("hwdec", "auto-safe".to_string()),
                ("force-window", "no".to_string()),
            ]
        }
    }
}
