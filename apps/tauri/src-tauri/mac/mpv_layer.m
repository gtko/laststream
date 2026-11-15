// Vidéo mpv sous la page (macOS) : API de rendu de libmpv (OpenGL) dans un CAOpenGLLayer, porté par une vue placée au
// fond du contentView de la fenêtre, sous la WKWebView transparente. Même principe que la coque Windows (mpv dessine
// sous une WebView2 transparente) : la vidéo apparaît là où la page ne dessine rien, et `video-margin-ratio-*` cale
// l'image dans la vignette du mini-lecteur.
//
// Fils : mpv appelle `on_update` depuis ses propres fils ; on redemande un dessin sur le fil principal. Le dessin et la
// création / libération du contexte de rendu se font toujours sur le fil principal, contexte OpenGL du calque courant.

#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <OpenGL/OpenGL.h>
#import <OpenGL/gl3.h>
#include <dlfcn.h>
#include <mpv/client.h>
#include <mpv/render.h>
#include <mpv/render_gl.h>

static void *get_proc_address(void *ctx, const char *name) {
    (void)ctx;
    static void *opengl = NULL;
    if (!opengl) opengl = dlopen("/System/Library/Frameworks/OpenGL.framework/OpenGL", RTLD_LAZY | RTLD_LOCAL);
    return opengl ? dlsym(opengl, name) : NULL;
}

@interface LSMpvLayer : CAOpenGLLayer {
@public
    mpv_handle *mpv;
    mpv_render_context *render;
    CGLContextObj cgl;
}
@end

static void on_update(void *ctx) {
    LSMpvLayer *layer = (__bridge LSMpvLayer *)ctx;
    dispatch_async(dispatch_get_main_queue(), ^{ [layer setNeedsDisplay]; });
}

@implementation LSMpvLayer

- (instancetype)init {
    if ((self = [super init])) {
        self.asynchronous = NO;
        self.needsDisplayOnBoundsChange = YES;
        self.opaque = YES;
        self.backgroundColor = [NSColor blackColor].CGColor;
        self.autoresizingMask = kCALayerWidthSizable | kCALayerHeightSizable;
    }
    return self;
}

- (CGLPixelFormatObj)copyCGLPixelFormatForDisplayMask:(uint32_t)mask {
    CGLPixelFormatAttribute attrs[] = {
        kCGLPFAOpenGLProfile, (CGLPixelFormatAttribute)kCGLOGLPVersion_3_2_Core,
        kCGLPFADoubleBuffer,
        kCGLPFAAccelerated,
        kCGLPFAAllowOfflineRenderers,
        kCGLPFAColorSize, (CGLPixelFormatAttribute)24,
        kCGLPFADisplayMask, (CGLPixelFormatAttribute)mask,
        (CGLPixelFormatAttribute)0,
    };
    CGLPixelFormatObj pix = NULL;
    GLint count = 0;
    CGLChoosePixelFormat(attrs, &pix, &count);
    return pix ? pix : [super copyCGLPixelFormatForDisplayMask:mask];
}

- (CGLContextObj)copyCGLContextForPixelFormat:(CGLPixelFormatObj)pf {
    cgl = [super copyCGLContextForPixelFormat:pf];
    return cgl;
}

- (BOOL)canDrawInCGLContext:(CGLContextObj)ctx pixelFormat:(CGLPixelFormatObj)pf forLayerTime:(CFTimeInterval)t displayTime:(const CVTimeStamp *)ts {
    return YES;
}

// Contexte de rendu créé au premier dessin qui suit `ls_mpv_view_attach` (le contexte OpenGL du calque est alors courant).
- (void)ensureRender {
    if (render || !mpv) return;
    mpv_opengl_init_params gl = { .get_proc_address = get_proc_address, .get_proc_address_ctx = NULL };
    mpv_render_param params[] = {
        { MPV_RENDER_PARAM_API_TYPE, (void *)MPV_RENDER_API_TYPE_OPENGL },
        { MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &gl },
        { MPV_RENDER_PARAM_INVALID, NULL },
    };
    if (mpv_render_context_create(&render, mpv, params) < 0) {
        render = NULL;
        NSLog(@"[laststream] mpv: contexte de rendu OpenGL impossible");
        return;
    }
    mpv_render_context_set_update_callback(render, on_update, (__bridge void *)self);
}

- (void)drawInCGLContext:(CGLContextObj)ctx pixelFormat:(CGLPixelFormatObj)pf forLayerTime:(CFTimeInterval)t displayTime:(const CVTimeStamp *)ts {
    CGLSetCurrentContext(ctx);
    [self ensureRender];
    GLint fbo = 0, viewport[4] = {0, 0, 0, 0};
    glGetIntegerv(GL_FRAMEBUFFER_BINDING, &fbo);
    glGetIntegerv(GL_VIEWPORT, viewport);
    if (render) {
        mpv_render_context_update(render);
        mpv_opengl_fbo target = { .fbo = fbo, .w = viewport[2], .h = viewport[3], .internal_format = 0 };
        int flip = 1;
        mpv_render_param params[] = {
            { MPV_RENDER_PARAM_OPENGL_FBO, &target },
            { MPV_RENDER_PARAM_FLIP_Y, &flip },
            { MPV_RENDER_PARAM_INVALID, NULL },
        };
        mpv_render_context_render(render, params);
    } else {
        glClearColor(0, 0, 0, 1);
        glClear(GL_COLOR_BUFFER_BIT);
    }
    [super drawInCGLContext:ctx pixelFormat:pf forLayerTime:t displayTime:ts];
    if (render) mpv_render_context_report_swap(render);
}

// Libère le contexte de rendu (avant la destruction de mpv), contexte OpenGL courant.
- (void)detachMpv {
    if (render) {
        if (cgl) CGLSetCurrentContext(cgl);
        mpv_render_context_set_update_callback(render, NULL, NULL);
        mpv_render_context_free(render);
        render = NULL;
    }
    mpv = NULL;
    [self setNeedsDisplay];
}

@end

static void on_main_sync(void (^block)(void)) {
    if ([NSThread isMainThread]) block();
    else dispatch_sync(dispatch_get_main_queue(), block);
}

// Crée la vue vidéo au fond du contentView de `ns_window` (fil principal). Renvoie la vue (retenue).
void *ls_mpv_view_create(void *ns_window) {
    __block void *result = NULL;
    on_main_sync(^{
        NSWindow *window = (__bridge NSWindow *)ns_window;
        NSView *content = window.contentView;
        if (!content) return;
        NSView *view = [[NSView alloc] initWithFrame:content.bounds];
        view.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        LSMpvLayer *layer = [LSMpvLayer layer];
        layer.contentsScale = window.backingScaleFactor;
        view.layer = layer;   // vue « hôte » du calque : le calque d'abord, puis wantsLayer
        view.wantsLayer = YES;
        [content addSubview:view positioned:NSWindowBelow relativeTo:nil];
        window.backgroundColor = [NSColor blackColor];
        result = (__bridge_retained void *)view;
    });
    return result;
}

// Branche le rendu sur `mpv` (mpv_handle*) ; le contexte est créé au prochain dessin.
void ls_mpv_view_attach(void *view_ptr, void *mpv) {
    on_main_sync(^{
        NSView *view = (__bridge NSView *)view_ptr;
        LSMpvLayer *layer = (LSMpvLayer *)view.layer;
        [layer detachMpv];
        layer->mpv = (mpv_handle *)mpv;
        [layer setNeedsDisplay];
    });
}

// Débranche le rendu (synchrone) : à appeler avant de détruire mpv.
void ls_mpv_view_detach(void *view_ptr) {
    on_main_sync(^{
        NSView *view = (__bridge NSView *)view_ptr;
        [(LSMpvLayer *)view.layer detachMpv];
    });
}

// Écran de densité différente (fenêtre déplacée sur un autre écran) : le calque suit l'échelle.
void ls_mpv_view_set_scale(void *view_ptr, double scale) {
    on_main_sync(^{
        NSView *view = (__bridge NSView *)view_ptr;
        view.layer.contentsScale = scale;
        [view.layer setNeedsDisplay];
    });
}
