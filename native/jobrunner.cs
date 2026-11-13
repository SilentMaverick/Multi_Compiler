// jobrunner.exe - sandboxed child-process launcher for Multi-Coder.
//
// Runs a command inside a Windows Job Object so that:
//   * the whole process tree is torn down when the job closes (no orphaned children)
//   * memory usage is capped by the kernel, not by polling
//   * peak memory usage can be reported
//   * a wall-clock timeout terminates the entire tree
//
// Compiles with the .NET Framework 4.x csc (C# 5 only: no interpolation, no ?.).
//
//   jobrunner.exe --timeout 5000 --mem 268435456 --mem-hard \
//                 --stdin in.txt --stdout out.txt --stderr err.txt \
//                 --result result.json --cwd workdir -- [exe] [args...]

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class JobRunner
{
    private const uint JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x00000100;
    private const uint JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x00000400;

    private const int JobObjectExtendedLimitInformation = 9;

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr hJob, int infoType, IntPtr lpInfo, uint cbInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr hJob, int infoClass, IntPtr lpInfo, uint cbInfoLength, out uint lpReturnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    private static string _error;

    private static int Main(string[] args)
    {
        long timeoutMs = 5000;
        long memBytes = 0;
        bool memHard = false;
        string stdinPath = null, stdoutPath = null, stderrPath = null, resultPath = null, cwd = null;
        var command = new List<string>();

        int i = 0;
        for (; i < args.Length; i++)
        {
            string a = args[i];
            if (a == "--") { i++; break; }
            switch (a)
            {
                case "--timeout": timeoutMs = ParseLong(args[++i], 5000); break;
                case "--mem": memBytes = ParseLong(args[++i], 0); break;
                case "--mem-hard": memHard = true; break;
                case "--stdin": stdinPath = args[++i]; break;
                case "--stdout": stdoutPath = args[++i]; break;
                case "--stderr": stderrPath = args[++i]; break;
                case "--result": resultPath = args[++i]; break;
                case "--cwd": cwd = args[++i]; break;
                default: command.Add(a); break;
            }
        }
        for (; i < args.Length; i++) command.Add(args[i]);

        if (command.Count == 0)
        {
            WriteResult(resultPath, -1, false, false, 0, 0, "no command given");
            return 2;
        }

        long peak = 0;
        bool timedOut = false;
        bool memExceeded = false;
        long wallMs = 0;
        int exitCode = -1;

        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        try
        {
            if (job == IntPtr.Zero)
            {
                _error = "CreateJobObject failed: " + Marshal.GetLastWin32Error();
                WriteResult(resultPath, -1, false, false, 0, 0, _error);
                return 3;
            }

            ApplyLimits(job, memBytes, memHard);

            var psi = new ProcessStartInfo(command[0]);
            for (int k = 1; k < command.Count; k++) psi.Arguments += (k == 1 ? "" : " ") + QuoteArg(command[k]);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.RedirectStandardInput = true;
            psi.WorkingDirectory = string.IsNullOrEmpty(cwd) ? Environment.CurrentDirectory : cwd;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;

            var sw = Stopwatch.StartNew();
            Process proc;
            try
            {
                proc = Process.Start(psi);
            }
            catch (Exception ex)
            {
                _error = "launch failed: " + ex.Message;
                WriteResult(resultPath, -1, false, false, 0, 0, _error);
                return 4;
            }

            if (proc == null)
            {
                _error = "launch returned null process";
                WriteResult(resultPath, -1, false, false, 0, 0, _error);
                return 4;
            }

            Thread rtOut = StartPump(proc.StandardOutput.BaseStream, stdoutPath);
            Thread rtErr = StartPump(proc.StandardError.BaseStream, stderrPath);

            bool assigned = false;
            try { assigned = AssignProcessToJobObject(job, proc.Handle); }
            catch (Exception ex) { _error = "assign warning: " + ex.Message; }

            // Feed stdin from a worker thread: if the program never reads it, a
            // synchronous copy would block on a full pipe and the timeout below
            // would never be armed.
            Thread tIn = new Thread(delegate()
            {
                try
                {
                    if (!string.IsNullOrEmpty(stdinPath) && File.Exists(stdinPath))
                    {
                        using (var input = File.OpenRead(stdinPath))
                        {
                            input.CopyTo(proc.StandardInput.BaseStream);
                        }
                    }
                    proc.StandardInput.Close();
                }
                catch (IOException) { }
                catch (ObjectDisposedException) { }
            });
            tIn.IsBackground = true;
            tIn.Start();

            if (!proc.WaitForExit((int)Math.Min(int.MaxValue, Math.Max(1, timeoutMs))))
            {
                timedOut = true;
                TerminateJobObject(job, 1);
                try { proc.Kill(); } catch { }
                proc.WaitForExit(5000);
            }
            sw.Stop();
            wallMs = sw.ElapsedMilliseconds;

            Join(rtOut, 3000);
            Join(rtErr, 3000);

            try { exitCode = proc.ExitCode; } catch { exitCode = -1; }

            long peakProc, peakJob;
            QueryPeak(job, out peakProc, out peakJob);
            peak = Math.Max(peakProc, peakJob);

            // Only call it "memory exceeded" when the process also failed; a program
            // that legitimately peaks at 96% of its budget and exits cleanly is fine.
            if (memBytes > 0 && memHard && exitCode != 0 && peak >= memBytes * 0.90) memExceeded = true;

            WriteResult(resultPath, exitCode, timedOut, memExceeded, peak, wallMs, _error);
            return 0;
        }
        finally
        {
            if (job != IntPtr.Zero)
            {
                TerminateJobObject(job, 1);
                CloseHandle(job);
            }
        }
    }

    private static void ApplyLimits(IntPtr job, long memBytes, bool memHard)
    {
        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        uint flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;

        // A hard commit limit is what makes MLE deterministic for native code, but the
        // JVM reserves address space aggressively and cannot start under a tight one.
        if (memBytes > 0 && memHard)
        {
            flags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_JOB_MEMORY;
            info.ProcessMemoryLimit = (UIntPtr)(ulong)memBytes;
            info.JobMemoryLimit = (UIntPtr)(ulong)memBytes;
        }
        info.BasicLimitInformation.LimitFlags = flags;

        int len = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr buf = Marshal.AllocHGlobal(len);
        try
        {
            Marshal.StructureToPtr(info, buf, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, buf, (uint)len))
                _error = "SetInformationJobObject failed: " + Marshal.GetLastWin32Error();
        }
        finally
        {
            Marshal.FreeHGlobal(buf);
        }
    }

    private static void QueryPeak(IntPtr job, out long peakProc, out long peakJob)
    {
        peakProc = 0;
        peakJob = 0;
        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        int len = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr buf = Marshal.AllocHGlobal(len);
        try
        {
            uint returned;
            if (QueryInformationJobObject(job, JobObjectExtendedLimitInformation, buf, (uint)len, out returned))
            {
                info = (JOBOBJECT_EXTENDED_LIMIT_INFORMATION)Marshal.PtrToStructure(buf, typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
                peakProc = (long)(ulong)info.PeakProcessMemoryUsed;
                peakJob = (long)(ulong)info.PeakJobMemoryUsed;
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buf);
        }
    }

    // Copies the child's raw stdout/stderr bytes straight to disk (no transcoding surprises).
    private static Thread StartPump(Stream source, string path)
    {
        Thread t = new Thread(delegate()
        {
            try
            {
                using (var fs = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.ReadWrite))
                {
                    var buffer = new byte[16 * 1024];
                    int read;
                    while ((read = source.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        fs.Write(buffer, 0, read);
                        fs.Flush();
                    }
                }
            }
            catch { }
        });
        t.IsBackground = true;
        t.Start();
        return t;
    }

    private static void Join(Thread t, int ms)
    {
        try { t.Join(ms); } catch { }
    }

    private static string QuoteArg(string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return arg;
        var sb = new StringBuilder("\"");
        for (int i = 0; i < arg.Length; i++)
        {
            if (arg[i] == '"') sb.Append('\\');
            sb.Append(arg[i]);
        }
        sb.Append('"');
        return sb.ToString();
    }

    private static long ParseLong(string s, long fallback)
    {
        long v;
        return long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out v) ? v : fallback;
    }

    private static void WriteResult(string path, int exitCode, bool timedOut, bool memExceeded,
                                    long peakBytes, long wallMs, string error)
    {
        var sb = new StringBuilder();
        sb.Append('{');
        sb.Append("\"exitCode\":").Append(exitCode.ToString(CultureInfo.InvariantCulture)).Append(',');
        sb.Append("\"timedOut\":").Append(timedOut ? "true" : "false").Append(',');
        sb.Append("\"memoryExceeded\":").Append(memExceeded ? "true" : "false").Append(',');
        sb.Append("\"peakMemoryBytes\":").Append(peakBytes.ToString(CultureInfo.InvariantCulture)).Append(',');
        sb.Append("\"wallMs\":").Append(wallMs.ToString(CultureInfo.InvariantCulture)).Append(',');
        sb.Append("\"error\":");
        if (string.IsNullOrEmpty(error)) sb.Append("null");
        else sb.Append(JsonString(error));
        sb.Append('}');

        string json = sb.ToString();
        if (!string.IsNullOrEmpty(path))
        {
            try { File.WriteAllText(path, json, new UTF8Encoding(false)); } catch { }
        }
        Console.Out.WriteLine(json);
    }

    private static string JsonString(string s)
    {
        var sb = new StringBuilder("\"");
        foreach (char c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }
}
