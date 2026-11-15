//! Surface vidéo de mpv, sous la page transparente.
//!  - Windows : fenêtre enfant (STATIC, noire) au fond de la fenêtre principale, sous la WebView2 ; mpv y dessine
//!    lui-même (`wid`, D3D11, mêmes options que la coque Windows historique).
//!  - macOS : API de rendu libmpv (OpenGL) dans un calque placé sous la WKWebView (`mac/mpv_layer.m`), `vo=libmpv`.
//!  - Linux : API de rendu libmpv (OpenGL) dans une GtkGLArea sous la WebView (WebKitGTK).
//!  - Autres : mpv ouvre sa propre fenêtre.

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

#[cfg(target_os = "linux")]
mod platform {
    //! Linux : API de rendu libmpv (OpenGL) dans une `GtkGLArea` placée sous la WebView (WebKitGTK transparente), dans
    //! un `GtkOverlay` qui remplace le contenu de la fenêtre. Tout le GTK passe par le fil principal ; mpv demande un
    //! dessin par son rappel de mise à jour. Fonctions OpenGL : EGL sous Wayland, GLX sous X11.
    use super::*;
    use gtk::prelude::*;
    use std::cell::RefCell;
    use std::ffi::{c_char, c_void, CString};
    use std::sync::OnceLock;
    use std::time::Duration;

    use libmpv2_sys as sys;

    struct GlState {
        area: gtk::GLArea,
        mpv: *mut sys::mpv_handle,
        render: *mut sys::mpv_render_context,
    }

    thread_local! {
        static STATE: RefCell<Option<GlState>> = const { RefCell::new(None) };
    }

    /// Exécute `f` sur le fil principal (GTK) et attend sa fin (2 s au plus).
    fn on_main(f: impl FnOnce() + Send + 'static) {
        let context = glib::MainContext::default();
        if context.is_owner() {
            f();
            return;
        }
        let (tx, rx) = std::sync::mpsc::channel();
        context.invoke(move || {
            f();
            let _ = tx.send(());
        });
        let _ = rx.recv_timeout(Duration::from_secs(2));
    }

    type ProcLoader = unsafe extern "C" fn(*const c_char) -> *mut c_void;

    /// eglGetProcAddress (Wayland) ou glXGetProcAddressARB (X11), choisi selon l'affichage GDK.
    fn loader() -> Option<ProcLoader> {
        static LOADER: OnceLock<Option<usize>> = OnceLock::new();
        let address = *LOADER.get_or_init(|| {
            let wayland =
                gdk::Display::default().is_some_and(|d| d.type_().name().contains("Wayland"));
            let (lib, symbol) = if wayland {
                ("libEGL.so.1", "eglGetProcAddress")
            } else {
                ("libGL.so.1", "glXGetProcAddressARB")
            };
            let lib = CString::new(lib).ok()?;
            let symbol = CString::new(symbol).ok()?;
            // SAFETY: bibliothèques système chargées une fois, jamais déchargées ; symbole cherché par son nom.
            unsafe {
                let handle = libc::dlopen(lib.as_ptr(), libc::RTLD_LAZY | libc::RTLD_GLOBAL);
                if handle.is_null() {
                    return None;
                }
                let f = libc::dlsym(handle, symbol.as_ptr());
                (!f.is_null()).then_some(f as usize)
            }
        });
        // SAFETY: adresse d'une fonction de signature `fn(const char*) -> void*` (EGL / GLX).
        address.map(|a| unsafe { std::mem::transmute::<usize, ProcLoader>(a) })
    }

    unsafe extern "C" fn get_proc_address(_ctx: *mut c_void, name: *const c_char) -> *mut c_void {
        match loader() {
            // SAFETY: `name` est une chaîne C fournie par mpv, valide pendant l'appel.
            Some(load) => unsafe { load(name) },
            None => std::ptr::null_mut(),
        }
    }

    fn gl_function(name: &str) -> *mut c_void {
        let name = CString::new(name).expect("nom de fonction GL");
        // SAFETY: chaîne C valide pendant l'appel.
        unsafe { get_proc_address(std::ptr::null_mut(), name.as_ptr()) }
    }

    unsafe extern "C" fn on_update(_ctx: *mut c_void) {
        // Toujours différé : mpv peut appeler ce rappel pendant `render` (état déjà emprunté, fil principal).
        glib::idle_add_once(|| {
            STATE.with(|state| {
                if let Ok(state) = state.try_borrow() {
                    if let Some(state) = state.as_ref() {
                        state.area.queue_render();
                    }
                }
            })
        });
    }

    /// Libère le contexte de rendu (contexte OpenGL de la zone courant), avant la destruction de mpv.
    fn free_render(state: &mut GlState) {
        if !state.render.is_null() {
            state.area.make_current();
            // SAFETY: contexte créé par mpv_render_context_create, libéré une seule fois puis oublié.
            unsafe {
                sys::mpv_render_context_set_update_callback(
                    state.render,
                    None,
                    std::ptr::null_mut(),
                );
                sys::mpv_render_context_free(state.render);
            }
            state.render = std::ptr::null_mut();
        }
    }

    /// Crée le contexte de rendu mpv si mpv est branché et la zone réalisée (contexte OpenGL rendu courant). `vo=libmpv`
    /// exige ce contexte AVANT le début de la lecture : il est donc créé au branchement de mpv et à la réalisation de la
    /// zone, pas seulement au premier dessin.
    fn ensure_render(state: &mut GlState) {
        if !state.render.is_null() || state.mpv.is_null() || !state.area.is_realized() {
            return;
        }
        state.area.make_current();
        if state.area.error().is_some() {
            eprintln!("mpv: contexte OpenGL de la zone indisponible");
            return;
        }

        let mut gl = sys::mpv_opengl_init_params {
            get_proc_address: Some(get_proc_address),
            get_proc_address_ctx: std::ptr::null_mut(),
        };
        let mut params = [
            sys::mpv_render_param {
                type_: sys::mpv_render_param_type_MPV_RENDER_PARAM_API_TYPE,
                data: sys::MPV_RENDER_API_TYPE_OPENGL.as_ptr() as *mut c_void,
            },
            sys::mpv_render_param {
                type_: sys::mpv_render_param_type_MPV_RENDER_PARAM_OPENGL_INIT_PARAMS,
                data: &mut gl as *mut _ as *mut c_void,
            },
            sys::mpv_render_param {
                type_: 0,
                data: std::ptr::null_mut(),
            },
        ];
        let mut ctx = std::ptr::null_mut();
        // SAFETY: mpv valide (attaché, vo=libmpv) ; paramètres terminés par un type 0 ; contexte GL courant.
        if unsafe { sys::mpv_render_context_create(&mut ctx, state.mpv, params.as_mut_ptr()) } >= 0
        {
            state.render = ctx;
            // SAFETY: rappel sans état (il passe par le fil principal), désinscrit avant la libération.
            unsafe {
                sys::mpv_render_context_set_update_callback(
                    ctx,
                    Some(on_update),
                    std::ptr::null_mut(),
                )
            };
        } else {
            eprintln!("mpv: contexte de rendu OpenGL impossible");
        }
    }

    fn render(area: &gtk::GLArea) {
        STATE.with(|state| {
            let mut state = state.borrow_mut();
            let Some(state) = state.as_mut() else { return };
            ensure_render(state);
            let scale = area.scale_factor();
            let (w, h) = (
                area.allocated_width() * scale,
                area.allocated_height() * scale,
            );
            let get_integer = gl_function("glGetIntegerv");
            if state.render.is_null() || get_integer.is_null() {
                let clear_color = gl_function("glClearColor");
                let clear = gl_function("glClear");
                if !clear_color.is_null() && !clear.is_null() {
                    // SAFETY: fonctions GL du contexte courant ; 0x4000 = GL_COLOR_BUFFER_BIT.
                    unsafe {
                        std::mem::transmute::<*mut c_void, extern "C" fn(f32, f32, f32, f32)>(
                            clear_color,
                        )(0.0, 0.0, 0.0, 1.0);
                        std::mem::transmute::<*mut c_void, extern "C" fn(u32)>(clear)(0x4000);
                    }
                }
                return;
            }
            let mut fbo: i32 = 0;
            // SAFETY: glGetIntegerv du contexte courant ; 0x8CA6 = GL_FRAMEBUFFER_BINDING.
            unsafe {
                std::mem::transmute::<*mut c_void, extern "C" fn(u32, *mut i32)>(get_integer)(
                    0x8CA6, &mut fbo,
                )
            };
            let mut target = sys::mpv_opengl_fbo {
                fbo,
                w,
                h,
                internal_format: 0,
            };
            let mut flip: i32 = 1;
            let mut params = [
                sys::mpv_render_param {
                    type_: sys::mpv_render_param_type_MPV_RENDER_PARAM_OPENGL_FBO,
                    data: &mut target as *mut _ as *mut c_void,
                },
                sys::mpv_render_param {
                    type_: sys::mpv_render_param_type_MPV_RENDER_PARAM_FLIP_Y,
                    data: &mut flip as *mut _ as *mut c_void,
                },
                sys::mpv_render_param {
                    type_: 0,
                    data: std::ptr::null_mut(),
                },
            ];
            // SAFETY: contexte de rendu valide ; paramètres vivants pendant l'appel.
            unsafe {
                sys::mpv_render_context_update(state.render);
                sys::mpv_render_context_render(state.render, params.as_mut_ptr());
            }
            // Fenêtre transparente (visuel ARGB) : l'image de mpv doit être opaque, sinon GTK la mélange au fond.
            let (mask, clear_color, clear) = (
                gl_function("glColorMask"),
                gl_function("glClearColor"),
                gl_function("glClear"),
            );
            if !mask.is_null() && !clear_color.is_null() && !clear.is_null() {
                // SAFETY: fonctions GL du contexte courant ; seul le canal alpha est écrit (0x4000 = GL_COLOR_BUFFER_BIT).
                unsafe {
                    let mask =
                        std::mem::transmute::<*mut c_void, extern "C" fn(u8, u8, u8, u8)>(mask);
                    mask(0, 0, 0, 1);
                    std::mem::transmute::<*mut c_void, extern "C" fn(f32, f32, f32, f32)>(
                        clear_color,
                    )(0.0, 0.0, 0.0, 1.0);
                    std::mem::transmute::<*mut c_void, extern "C" fn(u32)>(clear)(0x4000);
                    mask(1, 1, 1, 1);
                }
            }
        });
    }

    pub struct LinuxSurface;

    pub fn create<R: Runtime>(window: &WebviewWindow<R>) -> Arc<dyn VideoSurface> {
        let window = window.clone();
        on_main(move || {
            let Ok(vbox) = window.default_vbox() else {
                return;
            };
            let overlay = gtk::Overlay::new();
            let area = gtk::GLArea::new();
            area.set_auto_render(false);
            area.set_has_alpha(false);
            area.connect_realize(|_| {
                STATE.with(|state| {
                    if let Ok(mut state) = state.try_borrow_mut() {
                        if let Some(state) = state.as_mut() {
                            ensure_render(state);
                        }
                    }
                })
            });
            area.connect_render(|area, _| {
                render(area);
                glib::Propagation::Stop
            });
            overlay.add(&area);
            // La WebView passe au-dessus de la vidéo, sur toute la surface.
            for child in vbox.children() {
                vbox.remove(&child);
                overlay.add_overlay(&child);
            }
            vbox.pack_start(&overlay, true, true, 0);
            overlay.show_all();
            STATE.with(|state| {
                *state.borrow_mut() = Some(GlState {
                    area,
                    mpv: std::ptr::null_mut(),
                    render: std::ptr::null_mut(),
                })
            });
        });
        Arc::new(LinuxSurface)
    }

    impl VideoSurface for LinuxSurface {
        fn mpv_options(&self) -> Vec<(&'static str, String)> {
            vec![
                ("vo", "libmpv".to_string()),
                ("hwdec", "auto-safe".to_string()),
            ]
        }
        fn attach(&self, mpv: &Arc<Mpv>) {
            let handle = mpv.ctx.as_ptr() as usize;
            on_main(move || {
                STATE.with(|state| {
                    if let Some(state) = state.borrow_mut().as_mut() {
                        free_render(state);
                        state.mpv = handle as *mut sys::mpv_handle;
                        ensure_render(state);
                        state.area.queue_render();
                    }
                })
            });
        }
        fn detach(&self) {
            on_main(|| {
                STATE.with(|state| {
                    if let Some(state) = state.borrow_mut().as_mut() {
                        free_render(state);
                        state.mpv = std::ptr::null_mut();
                        state.area.queue_render();
                    }
                })
            });
        }
        fn page_may_set_vo(&self) -> bool {
            false
        }
    }
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
mod platform {
    use super::*;

    /// Autres systèmes : mpv ouvre sa propre fenêtre.
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
