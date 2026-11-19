# VTuber Mask: what this PC is playing, as plain sound samples, for sound.js (started by it, hidden; never by hand).
# It LISTENS to the default playback device the way a level meter does (Windows "loopback"): nothing is recorded to
# disk, nothing is played, no microphone is opened, nothing leaves this PC. Output (stdout, binary): "VTSL", the sample
# rate (int32), then mono 16-bit samples as they come (nothing while the PC is silent). It ends when its input closes
# (sound.js went away) or when it cannot listen (the reason on stderr).
$ErrorActionPreference = 'Stop'
$code = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
namespace VTSound {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom { }
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    [PreserveSig] int OpenPropertyStore(int access, out IntPtr store);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetState(out int state);
  }
  [Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioClient {
    [PreserveSig] int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
    [PreserveSig] int GetBufferSize(out uint frames);
    [PreserveSig] int GetStreamLatency(out long latency);
    [PreserveSig] int GetCurrentPadding(out uint frames);
    [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
    [PreserveSig] int GetMixFormat(out IntPtr format);
    [PreserveSig] int GetDevicePeriod(out long def, out long min);
    [PreserveSig] int Start();
    [PreserveSig] int Stop();
    [PreserveSig] int Reset();
    [PreserveSig] int SetEventHandle(IntPtr handle);
    [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
  }
  [Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioCaptureClient {
    [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
    [PreserveSig] int ReleaseBuffer(uint frames);
    [PreserveSig] int GetNextPacketSize(out uint frames);
  }
  public static class Loopback {
    static volatile bool stop = false;
    static string DefaultId(IMMDeviceEnumerator en, out IMMDevice dev) {
      dev = null;
      if (en.GetDefaultAudioEndpoint(0, 0, out dev) != 0 || dev == null) return null;   // 0 = playback, 0 = the everyday device
      string id; dev.GetId(out id); return id;
    }
    public static int Run() {
      Stream outp = Console.OpenStandardOutput();
      Thread watch = new Thread(() => { try { Stream i = Console.OpenStandardInput(); byte[] b = new byte[16]; while (i.Read(b, 0, b.Length) > 0) { } } catch { } stop = true; });
      watch.IsBackground = true; watch.Start();
      IMMDeviceEnumerator en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom());
      bool header = false; int fails = 0;
      while (!stop) {
        IMMDevice dev; string id = DefaultId(en, out dev);
        if (id == null) { if (++fails > 20) { Console.Error.WriteLine("no playback device"); return 3; } Thread.Sleep(1000); continue; }
        Guid iidClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), iidCapture = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
        object o; if (dev.Activate(ref iidClient, 23, IntPtr.Zero, out o) != 0) { if (++fails > 20) { Console.Error.WriteLine("the playback device cannot be opened"); return 4; } Thread.Sleep(1000); continue; }
        IAudioClient client = (IAudioClient)o;
        IntPtr fmt; client.GetMixFormat(out fmt);
        int tag = (ushort)Marshal.ReadInt16(fmt, 0), ch = (ushort)Marshal.ReadInt16(fmt, 2), rate = Marshal.ReadInt32(fmt, 4), align = (ushort)Marshal.ReadInt16(fmt, 12), bits = (ushort)Marshal.ReadInt16(fmt, 14);
        if (tag == 0xFFFE) tag = Marshal.ReadInt32(fmt, 24);                             // the long form: the kind is in its sub-format
        bool isFloat = tag == 3 && bits == 32, isInt16 = tag == 1 && bits == 16;
        if (!isFloat && !isInt16) { Console.Error.WriteLine("a sound format this helper does not read (" + tag + ", " + bits + " bit)"); return 5; }
        int hr = client.Initialize(0, 0x00020000, 2000000, 0, fmt, IntPtr.Zero);          // shared, LOOPBACK, a 200 ms buffer
        Marshal.FreeCoTaskMem(fmt);
        if (hr != 0) { if (++fails > 20) { Console.Error.WriteLine("listening was refused (" + hr.ToString("X8") + ")"); return 6; } Thread.Sleep(1000); continue; }
        object c; client.GetService(ref iidCapture, out c);
        IAudioCaptureClient cap = (IAudioCaptureClient)c;
        client.Start();
        fails = 0;
        if (!header) {
          byte[] h = new byte[8]; h[0] = (byte)'V'; h[1] = (byte)'T'; h[2] = (byte)'S'; h[3] = (byte)'L';
          BitConverter.GetBytes(rate).CopyTo(h, 4);
          outp.Write(h, 0, 8); outp.Flush(); header = true;
        } else if (rate != lastRate) { Console.Error.WriteLine("the playback device changed (another rate)"); return 7; }   // sound.js starts a fresh helper
        lastRate = rate;
        float[] f = new float[4800 * 8]; short[] s16 = new short[4800 * 8]; byte[] ob = new byte[4800 * 2];
        int idle = 0; bool again = false;
        while (!stop && !again) {
          Thread.Sleep(8);
          uint n; hr = cap.GetNextPacketSize(out n);
          if (hr != 0) { again = true; break; }
          while (n > 0 && !stop) {
            IntPtr data; uint frames, flags; ulong p1, p2;
            hr = cap.GetBuffer(out data, out frames, out flags, out p1, out p2);
            if (hr != 0) { again = true; break; }
            int fr = (int)Math.Min(frames, 4800u);
            if ((flags & 2) != 0) { Array.Clear(ob, 0, fr * 2); }
            else if (isFloat) {
              Marshal.Copy(data, f, 0, fr * ch);
              for (int i = 0; i < fr; i++) { float a = 0; for (int k = 0; k < ch; k++) a += f[i * ch + k]; a /= ch; if (a > 1) a = 1; else if (a < -1) a = -1; short v = (short)(a * 32767); ob[i * 2] = (byte)(v & 255); ob[i * 2 + 1] = (byte)((v >> 8) & 255); }
            } else {
              Marshal.Copy(data, s16, 0, fr * ch);
              for (int i = 0; i < fr; i++) { int a = 0; for (int k = 0; k < ch; k++) a += s16[i * ch + k]; short v = (short)(a / ch); ob[i * 2] = (byte)(v & 255); ob[i * 2 + 1] = (byte)((v >> 8) & 255); }
            }
            cap.ReleaseBuffer(frames);
            try { outp.Write(ob, 0, fr * 2); outp.Flush(); } catch { return 0; }          // sound.js went away
            hr = cap.GetNextPacketSize(out n);
            if (hr != 0) { again = true; break; }
          }
          if (++idle >= 250) {                                                            // every 2 s: is the everyday device still this one?
            idle = 0;
            IMMDevice d2; string now = DefaultId(en, out d2);
            if (now != null && now != id) again = true;
          }
        }
        try { client.Stop(); } catch { }
        Marshal.ReleaseComObject(cap); Marshal.ReleaseComObject(client);
        if (!stop) Thread.Sleep(500);
      }
      return 0;
    }
    static int lastRate = 0;
  }
}
'@
try {
  Add-Type -TypeDefinition $code -Language CSharp
  exit [VTSound.Loopback]::Run()
} catch {
  [Console]::Error.WriteLine('sound helper failed: ' + $_.Exception.Message)
  exit 9
}
