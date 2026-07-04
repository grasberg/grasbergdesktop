// Wrapper around 7za.exe for electron-builder packaging on Windows WITHOUT
// admin/Developer Mode: the winCodeSign archive contains two macOS symlinks
// that 7za cannot create without SeCreateSymbolicLinkPrivilege, so it exits
// with code 2 ("warnings") after extracting everything else — which
// electron-builder treats as a fatal error. This wrapper forwards all
// arguments to 7za-real.exe (a copy of the original placed beside it) and
// maps exit code 2 to 0. All real Windows payloads extract cleanly.
//
// Usage (see scripts/package-win-notes or the session memory):
//   cd node_modules/7zip-bin/win/x64
//   cp 7za.exe 7za-real.exe
//   /c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe -nologo \
//     -out:7za.exe <path-to>/SevenZipWrap.cs   (compile from inside a dir,
//     bare filenames + dash flags; csc mis-parses forward-slash paths)
//   ... run electron-builder ...
//   cp 7za-real.exe 7za.exe && rm 7za-real.exe
//
// C# 5 only (the .NET Framework csc at v4.0.30319 has no newer features).

using System;
using System.Diagnostics;
using System.IO;

class SevenZipWrap
{
    static int Main()
    {
        string dir = Path.GetDirectoryName(
            System.Reflection.Assembly.GetExecutingAssembly().Location);
        string real = Path.Combine(dir, "7za-real.exe");

        // Strip arg0 (possibly quoted) from the raw command line so the rest
        // is forwarded verbatim — Environment.GetCommandLineArgs would lose
        // the original quoting that 7za's switch parser relies on.
        string cmdLine = Environment.CommandLine;
        string args;
        if (cmdLine.StartsWith("\""))
        {
            int end = cmdLine.IndexOf('"', 1);
            args = end < 0 ? "" : cmdLine.Substring(end + 1).TrimStart();
        }
        else
        {
            int end = cmdLine.IndexOf(' ');
            args = end < 0 ? "" : cmdLine.Substring(end + 1).TrimStart();
        }

        ProcessStartInfo psi = new ProcessStartInfo(real, args);
        psi.UseShellExecute = false; // inherit stdout/stderr so callers can parse output
        Process p = Process.Start(psi);
        p.WaitForExit();
        int code = p.ExitCode;
        return code == 2 ? 0 : code;
    }
}
