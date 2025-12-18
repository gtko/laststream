param (
    [String]$pw = $( Read-Host "Password" )
)

$thread = Start-ThreadJob -InputObject ($pw) -ScriptBlock {
    $wshell = New-Object -ComObject wscript.shell;
    $pw = "$($input)~"
    while ($true) {
        while ( -not $wshell.AppActivate("Token Logon")) {
            Start-Sleep 1
        }
        Start-Sleep 1
        $wshell.SendKeys($pw, $true)
        Start-Sleep 1
    }
}

cargo build --release --target aarch64-pc-windows-msvc
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" /DSIGN "/Sstremiosign=`$qsigntool.exe`$q sign /fd SHA256 /t http://timestamp.digicert.com /n `$qSmart Code OOD`$q `$f" "setup\Stremio-arm64.iss"

Stop-Job -Job $thread
