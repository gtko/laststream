use chrono::{Datelike, Local};
use std::{env, fs, io::Cursor, path::PathBuf};

extern crate winres;
fn main() {
    let now = Local::now();
    let copyright = format!("Copyright © {} Smart Code OOD", now.year());
    let exe_name = format!("{}.exe", env::var("CARGO_PKG_NAME").unwrap());
    let mut res = winres::WindowsResource::new();
    res.set_manifest(
        r#"
    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
    <dependency>
        <dependentAssembly>
            <assemblyIdentity
                type="win32"
                name="Microsoft.Windows.Common-Controls"
                version="6.0.0.0"
                processorArchitecture="*"
                publicKeyToken="6595b64144ccf1df"
                language="*"
            />
        </dependentAssembly>
    </dependency>
    </assembly>
    "#,
    );
    res.set("FileDescription", "Freedom to Stream");
    res.set("LegalCopyright", &copyright);
    res.set("OriginalFilename", &exe_name);
    res.set_icon_with_id("images/stremio.ico", "MAINICON");
    res.append_rc_content(r##"SPLASHIMAGE IMAGE "images/stremio.png""##);
    res.compile().unwrap();

    //extract libmpv-2
    let target = std::env::var("TARGET").unwrap();
    let archive = match target.as_str() {
        "x86_64-pc-windows-msvc" => "libmpv-2_x64.zip",
        "aarch64-pc-windows-msvc" => "libmpv-2_arm64.zip",
        _ => panic!("Unsupported target {}", target),
    };
    println!("cargo:rerun-if-changed={}", archive);
    {
        let archive = fs::read(archive).unwrap();
        let target_dir = PathBuf::from(".");
        zip_extract::extract(Cursor::new(archive), &target_dir, true).ok();
    }
}
