// ptyhost.exe - runs a child process inside a Windows pseudo console (ConPTY).
//
// A pipe-based child sees a non-interactive stdin: no echo, no line editing, no
// ANSI colours, and curses-style programs fail outright. ConPTY gives the child a
// real console, so it behaves exactly as it would in a terminal window.
//
// Wiring:
//   our stdin  -> pseudo console input  (what the user types)
//   console output -> our stdout        (bytes, including ANSI escapes)
//   child exit code -> our exit code
//
// The child is placed in a Job Object with KILL_ON_JOB_CLOSE so it cannot outlive
// this process.
//
//   ptyhost.exe --cwd <dir> --cols 120 --rows 30 --timeout 180000 -- <exe> [args...]

using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

internal static class PtyHost
{
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private static readonly IntPtr PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = (IntPtr)0x00020016;

    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;

    [StructLayout(LayoutKind.Sequential)]
    private struct COORD
    {
        public short X;
        public short Y;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        public int bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern int CreatePseudoConsole(COORD size, IntPtr hInput, IntPtr hOutput, uint flags, out IntPtr phPC);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern void ClosePseudoConsole(IntPtr hPC);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(out IntPtr hReadPipe, out IntPtr hWritePipe, ref SECURITY_ATTRIBUTES attrs, uint size);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessW(
        string lpApplicationName, string lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes,
        bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory,
        ref STARTUPINFOEX lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr prev, IntPtr ret);

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr list);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint ms);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint code);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attrs, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    private static int Main(string[] args)
    {
        string cwd = null;
        short cols = 120;
        short rows = 32;
        long timeoutMs = 180000;
        var command = new StringBuilder();

        int i = 0;
        for (; i < args.Length; i++)
        {
            if (args[i] == "--") { i++; break; }
            switch (args[i])
            {
                case "--cwd": cwd = args[++i]; break;
                case "--cols": cols = (short)ParseInt(args[++i], 120); break;
                case "--rows": rows = (short)ParseInt(args[++i], 32); break;
                case "--timeout": timeoutMs = ParseInt(args[++i], 180000); break;
            }
        }
        if (i >= args.Length)
        {
            Console.Error.WriteLine("ptyhost: no command given");
            return 2;
        }
        command.Append(Quote(args[i]));
        for (int k = i + 1; k < args.Length; k++) command.Append(' ').Append(Quote(args[k]));

        var sa = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), bInheritHandle = 1 };

        IntPtr inRead, inWrite, outRead, outWrite;
        if (!CreatePipe(out inRead, out inWrite, ref sa, 0) || !CreatePipe(out outRead, out outWrite, ref sa, 0))
        {
            Console.Error.WriteLine("ptyhost: CreatePipe failed: " + Marshal.GetLastWin32Error());
            return 3;
        }

        IntPtr pc = IntPtr.Zero;
        int hr = CreatePseudoConsole(new COORD { X = cols, Y = rows }, inRead, outWrite, 0, out pc);
        if (hr != 0 || pc == IntPtr.Zero)
        {
            Console.Error.WriteLine("ptyhost: CreatePseudoConsole failed: 0x" + hr.ToString("X8"));
            return 4;
        }

        // The child owns these ends now; holding them open would keep the console alive.
        CloseHandle(inRead);
        CloseHandle(outWrite);

        IntPtr attrList = IntPtr.Zero;
        IntPtr attrSize = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attrSize);
        attrList = Marshal.AllocHGlobal(attrSize);
        if (!InitializeProcThreadAttributeList(attrList, 1, 0, ref attrSize))
        {
            Console.Error.WriteLine("ptyhost: InitializeProcThreadAttributeList failed: " + Marshal.GetLastWin32Error());
            return 5;
        }
        if (!UpdateProcThreadAttribute(attrList, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, pc, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
        {
            Console.Error.WriteLine("ptyhost: UpdateProcThreadAttribute failed: " + Marshal.GetLastWin32Error());
            return 6;
        }

        var siEx = new STARTUPINFOEX();
        siEx.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
        // Without this the child inherits *our* pipes as std handles instead of the
        // pseudo console, so it can neither echo nor receive console input.
        siEx.StartupInfo.dwFlags = 0x00000100 | (int)EXTENDED_STARTUPINFO_PRESENT; // STARTF_USESTDHANDLES
        siEx.StartupInfo.hStdInput = (IntPtr)(-1);
        siEx.StartupInfo.hStdOutput = (IntPtr)(-1);
        siEx.StartupInfo.hStdError = (IntPtr)(-1);
        siEx.lpAttributeList = attrList;

        PROCESS_INFORMATION pi;
        bool started = CreateProcessW(
            null, command.ToString(), IntPtr.Zero, IntPtr.Zero, false,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
            IntPtr.Zero, string.IsNullOrEmpty(cwd) ? null : cwd, ref siEx, out pi);

        DeleteProcThreadAttributeList(attrList);
        Marshal.FreeHGlobal(attrList);

        if (!started)
        {
            Console.Error.WriteLine("ptyhost: CreateProcess failed: " + Marshal.GetLastWin32Error());
            return 7;
        }

        // Keep the tree alive-or-dead together.
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job != IntPtr.Zero)
        {
            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int len = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr buf = Marshal.AllocHGlobal(len);
            try
            {
                Marshal.StructureToPtr(info, buf, false);
                SetInformationJobObject(job, JobObjectExtendedLimitInformation, buf, (uint)len);
            }
            finally
            {
                Marshal.FreeHGlobal(buf);
            }
            AssignProcessToJobObject(job, pi.hProcess);
        }

        // console -> our stdout
        var readerThread = new Thread(delegate()
        {
            try
            {
                using (var src = new FileStream(new SafeFileHandle(outRead, true), FileAccess.Read))
                using (var dst = Console.OpenStandardOutput())
                {
                    var buffer = new byte[8192];
                    int n;
                    while ((n = src.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        dst.Write(buffer, 0, n);
                        dst.Flush();
                    }
                }
            }
            catch { }
        });
        readerThread.IsBackground = true;
        readerThread.Start();

        // our stdin -> console
        var writerThread = new Thread(delegate()
        {
            try
            {
                using (var src = Console.OpenStandardInput())
                using (var dst = new FileStream(new SafeFileHandle(inWrite, true), FileAccess.Write))
                {
                    var buffer = new byte[8192];
                    int n;
                    while ((n = src.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        dst.Write(buffer, 0, n);
                        dst.Flush();
                    }
                }
            }
            catch (Exception ex)
            {
                try { Console.Error.WriteLine("ptyhost: writer " + ex.GetType().Name + ": " + ex.Message); } catch { }
            }
        });
        writerThread.IsBackground = true;
        writerThread.Start();

        uint wait = WaitForSingleObject(pi.hProcess, (uint)Math.Min(int.MaxValue, Math.Max(1, timeoutMs)));
        if (wait != 0)
        {
            if (job != IntPtr.Zero) TerminateJobObject(job, 124);
            try { Process.GetProcessById(pi.dwProcessId).Kill(); } catch { }
        }

        uint code = 0;
        GetExitCodeProcess(pi.hProcess, out code);
        if (wait != 0) code = 124; // timed out

        // Let the reader drain the final output before we disappear.
        Thread.Sleep(150);
        if (job != IntPtr.Zero) CloseHandle(job);
        ClosePseudoConsole(pc);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        return unchecked((int)code);
    }

    private static int ParseInt(string s, int fallback)
    {
        int v;
        return int.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out v) ? v : fallback;
    }

    private static string Quote(string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return arg;
        var sb = new StringBuilder("\"");
        foreach (char c in arg)
        {
            if (c == '"') sb.Append('\\');
            sb.Append(c);
        }
        sb.Append('"');
        return sb.ToString();
    }
}
