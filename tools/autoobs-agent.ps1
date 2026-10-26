# Агент автообсерва для cs2-pro-hud
# Запускать на ПК, где открыт CS2 (наблюдатель):
#   powershell -ExecutionPolicy Bypass -File autoobs-agent.ps1 -Server http://IP-ПК-С-HUD:3000
# На одном ПК с сервером адрес по умолчанию — http://localhost:3000.
#
# • Подключается к серверу по Socket.IO (пространство имён /agent).
# • Нажимает цифру 1–0 (слот игрока) скан-кодом через SendInput — только когда активно окно CS2.
# • Хоткеи: Ctrl+Shift+PageUp — включить автообсерв (или снять паузу), Ctrl+Shift+PageDown — выключить
#   (сразу отпускает все клавиши, которые держит агент).
# • Ручное управление (цифры, кнопки мыши, движение мыши в окне CS2) → сервер ставит автомат на паузу.
#   Свои нажатия агент отличает по флагу injected.
# Выход — Ctrl+C или закрыть окно.

param(
  [string]$Server = "http://localhost:3000",
  [string]$Process = "cs2",
  [switch]$HotkeysAnywhere,      # хоткеи работают, даже если CS2 не в фокусе
  [int]$MouseMoveEvents = 25,    # столько событий движения мыши за 400 мс = «оператор тронул мышь»
  [switch]$NoBeep,

  # ── Пролётки через exec-трюк: в консоли CS2 один раз  bind "kp_minus" "exec autoobs_frame"
  [string]$CfgDir = "",          # папка game\csgo\cfg (по умолчанию — стандартный путь Steam)
  # ── Тест облёта: -FlyTest -Center "334 2433 -56" -Hz 60
  [switch]$FlyTest,
  [string]$Center = "",          # "x y z" — точка, вокруг которой облёт (возьми из spec_pos / getpos)
  [double]$Radius = 600,
  [double]$Height = 400,
  [double]$Speed = 150,          # ед/с по орбите
  [double]$Hz = 60,              # кадров spec_goto в секунду
  [double]$Seconds = 12,
  [ValidateSet("kp_minus", "kp_plus", "kp_multiply")]
  [string]$FrameKey = "kp_minus"
)

$ErrorActionPreference = "Stop"

Add-Type -ReferencedAssemblies System.Web.Extensions -TypeDefinition @"
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

public static class AutoObsAgent {
  // ── WinAPI ────────────────────────────────────────────────────────────────
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion U; }
  [StructLayout(LayoutKind.Sequential)] struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData; public uint flags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; }
  delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int idHook, HookProc fn, IntPtr hMod, uint threadId);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hhk);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hWnd, uint min, uint max);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG msg);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG msg);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);

  const uint KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_SCANCODE = 0x0008;
  const int WH_KEYBOARD_LL = 13, WH_MOUSE_LL = 14;
  const uint LLKHF_INJECTED = 0x10, LLMHF_INJECTED = 0x01;

  // Скан-коды цифр верхнего ряда: 1 = 0x02 … 9 = 0x0A, 0 = 0x0B
  static readonly Dictionary<string, ushort> Scan = new Dictionary<string, ushort> {
    {"1",0x02},{"2",0x03},{"3",0x04},{"4",0x05},{"5",0x06},{"6",0x07},{"7",0x08},{"8",0x09},{"9",0x0A},{"0",0x0B}
  };

  // ── Состояние ─────────────────────────────────────────────────────────────
  static string serverUrl, processName;
  static bool hotkeysAnywhere, beep;
  static int mouseEvents;
  static volatile bool cs2Focus;
  static volatile bool connected;
  static readonly ConcurrentQueue<string> outbox = new ConcurrentQueue<string>();
  static readonly HashSet<ushort> held = new HashSet<ushort>();   // клавиши, которые агент держит (для пролёток)
  static readonly object heldLock = new object();
  static readonly JavaScriptSerializer json = new JavaScriptSerializer();
  static HookProc kbProc, msProc;
  static IntPtr kbHook, msHook;
  static readonly Queue<long> moveTimes = new Queue<long>();
  static long lastManualMs;
  static readonly Stopwatch clock = Stopwatch.StartNew();

  static void Log(string s) { Console.WriteLine(DateTime.Now.ToString("HH:mm:ss") + "  " + s); }

  // ── Нажатия ───────────────────────────────────────────────────────────────
  static INPUT Key(ushort scan, bool up) {
    INPUT i = new INPUT();
    i.type = 1;
    i.U.ki.wScan = scan;
    i.U.ki.dwFlags = KEYEVENTF_SCANCODE | (up ? KEYEVENTF_KEYUP : 0);
    return i;
  }
  static void SendKey(ushort scan, bool up) { SendInput(1, new INPUT[] { Key(scan, up) }, Marshal.SizeOf(typeof(INPUT))); }
  static void Tap(ushort scan) { SendKey(scan, false); Thread.Sleep(30); SendKey(scan, true); }
  public static void Hold(ushort scan) { lock (heldLock) { if (held.Add(scan)) SendKey(scan, false); } }
  public static void ReleaseAll() {
    lock (heldLock) { foreach (ushort s in held) SendKey(s, true); held.Clear(); }
  }

  // ── Socket.IO (Engine.IO v4 поверх WebSocket) ────────────────────────────
  const string NS = "/agent";
  static void Emit(string evt, Dictionary<string, object> data) {
    outbox.Enqueue("42" + NS + "," + json.Serialize(new object[] { evt, data }));
  }
  static Dictionary<string, object> D(params object[] kv) {
    Dictionary<string, object> d = new Dictionary<string, object>();
    for (int i = 0; i + 1 < kv.Length; i += 2) d[(string)kv[i]] = kv[i + 1];
    return d;
  }

  static void NetLoop() {
    string wsUrl = serverUrl.TrimEnd('/').Replace("https://", "wss://").Replace("http://", "ws://") + "/socket.io/?EIO=4&transport=websocket";
    bool warned = false;
    while (true) {
      ClientWebSocket ws = new ClientWebSocket();
      try {
        ws.ConnectAsync(new Uri(wsUrl), CancellationToken.None).Wait();
        Thread sender = new Thread(delegate () { SendLoop(ws); });
        sender.IsBackground = true;
        sender.Start();
        byte[] buf = new byte[65536];
        while (ws.State == WebSocketState.Open) {
          StringBuilder sb = new StringBuilder();
          WebSocketReceiveResult r;
          do {
            r = ws.ReceiveAsync(new ArraySegment<byte>(buf), CancellationToken.None).Result;
            if (r.MessageType == WebSocketMessageType.Close) throw new Exception("сервер закрыл соединение");
            sb.Append(Encoding.UTF8.GetString(buf, 0, r.Count));
          } while (!r.EndOfMessage);
          Handle(sb.ToString());
        }
      } catch (Exception e) {
        Exception x = e is AggregateException && e.InnerException != null ? e.InnerException : e;
        if (connected || !warned) Log("Нет связи с " + serverUrl + ": " + x.Message);
        warned = true;
      }
      if (connected) { connected = false; ReleaseAll(); }
      try { ws.Dispose(); } catch { }
      Thread.Sleep(2000);
    }
  }

  static void SendLoop(ClientWebSocket ws) {
    while (ws.State == WebSocketState.Open) {
      string m;
      while (outbox.TryDequeue(out m)) {
        byte[] b = Encoding.UTF8.GetBytes(m);
        try { ws.SendAsync(new ArraySegment<byte>(b), WebSocketMessageType.Text, true, CancellationToken.None).Wait(); }
        catch { return; }
      }
      Thread.Sleep(15);
    }
  }

  static void Handle(string m) {
    if (m.Length == 0) return;
    char t = m[0];
    if (t == '0') { outbox.Enqueue("40" + NS + ","); return; }            // open → подключаемся к /agent
    if (t == '2') { outbox.Enqueue("3"); return; }                          // ping → pong
    if (!m.StartsWith("4")) return;
    if (m.StartsWith("40" + NS)) {                                          // namespace connected
      connected = true;
      Log("Подключено к " + serverUrl);
      string flyErr = flyCfgDir == null ? "не задана папка cfg (-CfgDir)" : "";
      Emit("agent:hello", D("host", Environment.MachineName, "version", "2", "cs2", cs2Focus, "fly", flyCfgDir != null, "fly_error", flyErr));
      return;
    }
    if (m.StartsWith("44" + NS)) { Log("Сервер отклонил подключение: " + m); return; }
    string prefix = "42" + NS + ",";
    if (!m.StartsWith(prefix)) return;
    object[] arr = json.DeserializeObject(m.Substring(prefix.Length)) as object[];
    if (arr == null || arr.Length == 0) return;
    string evt = arr[0] as string;
    Dictionary<string, object> data = arr.Length > 1 ? arr[1] as Dictionary<string, object> : null;
    if (data == null) data = new Dictionary<string, object>();

    if (evt == "agent:press") {
      string key = Convert.ToString(data.ContainsKey("key") ? data["key"] : "");
      object seq = data.ContainsKey("seq") ? data["seq"] : 0;
      ushort sc;
      if (!Scan.TryGetValue(key, out sc)) return;
      if (!cs2Focus) {
        Log("слот " + key + " — пропуск: окно CS2 не активно");
        Emit("agent:pressed", D("seq", seq, "key", key, "skipped", "окно CS2 не активно"));
        return;
      }
      ThreadPool.QueueUserWorkItem(delegate { Tap(sc); });
      Log("слот " + key);
      Emit("agent:pressed", D("seq", seq, "key", key));
    } else if (evt == "agent:release_all") {
      StopFly("отпустить все клавиши");
      ReleaseAll();
    } else if (evt == "agent:fly") {
      int seq = Convert.ToInt32(data.ContainsKey("seq") ? data["seq"] : 0);
      object[] frames = data.ContainsKey("frames") ? data["frames"] as object[] : null;
      double hz = data.ContainsKey("hz") ? Convert.ToDouble(data["hz"]) : 60;
      string exitCmd = data.ContainsKey("exit") ? Convert.ToString(data["exit"]) : "";
      if (frames == null || frames.Length == 0) return;
      if (!cs2Focus) { Emit("agent:fly_end", D("seq", seq, "reason", "окно CS2 не активно", "frames", 0)); return; }
      StartFly(seq, frames, Math.Max(10, Math.Min(128, hz)), exitCmd);
    } else if (evt == "agent:fly_stop") {
      int seq = Convert.ToInt32(data.ContainsKey("seq") ? data["seq"] : 0);
      if (seq == flySeq) StopFly(data.ContainsKey("reason") ? Convert.ToString(data["reason"]) : "сервер остановил");
    } else if (evt == "agent:state") {
      bool en = data.ContainsKey("enabled") && Convert.ToBoolean(data["enabled"]);
      bool pa = data.ContainsKey("paused") && Convert.ToBoolean(data["paused"]);
      Log("Автообсерв: " + (en ? (pa ? "ВКЛ (пауза)" : "ВКЛ") : "ВЫКЛ"));
      if (!en) { StopFly("автообсерв выключен"); ReleaseAll(); }
    }
  }

  // ── Фокус окна CS2 ────────────────────────────────────────────────────────
  static void FocusLoop() {
    uint lastPid = 0; bool lastIsCs2 = false;
    while (true) {
      try {
        uint pid;
        GetWindowThreadProcessId(GetForegroundWindow(), out pid);
        bool isCs2 = lastIsCs2;
        if (pid != lastPid) {
          lastPid = pid;
          try { isCs2 = string.Equals(Process.GetProcessById((int)pid).ProcessName, processName, StringComparison.OrdinalIgnoreCase); }
          catch { isCs2 = false; }
          lastIsCs2 = isCs2;
        }
        if (isCs2 != cs2Focus) {
          cs2Focus = isCs2;
          Log(isCs2 ? "Окно CS2 активно" : "Окно CS2 не активно — нажатия пропускаются");
          Emit("agent:focus", D("cs2", isCs2));
        }
      } catch { }
      Thread.Sleep(150);
    }
  }

  // ── Хуки клавиатуры и мыши ────────────────────────────────────────────────
  static void Manual(string reason) {
    StopFly("ручное управление");
    long now = clock.ElapsedMilliseconds;
    if (now - lastManualMs < 700) return;
    lastManualMs = now;
    Emit("agent:manual", D("reason", reason));
    Log("ручное управление: " + reason);
  }

  // ── Пролётки: кадры spec_goto от сервера через exec-трюк ─────────────────
  static string flyCfgDir;
  static ushort flyScan;
  static volatile int flySeq = 0;           // текущая пролётка (0 — нет)
  static volatile string flyStopReason = null;

  static void StopFly(string reason) {
    if (flySeq != 0 && flyStopReason == null) flyStopReason = reason;
  }

  static void StartFly(int seq, object[] frames, double hz, string exitCmd) {
    if (flyCfgDir == null) { Emit("agent:fly_end", D("seq", seq, "reason", "у агента не задана папка cfg (-CfgDir)", "frames", 0)); return; }
    StopFly("запущена другая пролётка");
    for (int i = 0; i < 50 && flySeq != 0; i++) Thread.Sleep(10);
    flySeq = seq; flyStopReason = null;
    Thread t = new Thread(delegate () { FlyPlay(seq, frames, hz, exitCmd); });
    t.IsBackground = true; t.Priority = ThreadPriority.AboveNormal; t.Start();
  }

  static void FlyPlay(int seq, object[] frames, double hz, string exitCmd) {
    timeBeginPeriod(1);
    Stopwatch sw = Stopwatch.StartNew();
    int played = 0;
    string reason = "готово";
    Log("пролётка #" + seq + ": " + frames.Length + " кадров, " + hz + " Гц");
    try {
      for (int i = 0; i < frames.Length; i++) {
        if (flyStopReason != null) { reason = flyStopReason; break; }
        if (!cs2Focus) { reason = "окно CS2 не активно"; break; }
        WriteFrame(flyCfgDir, Convert.ToString(frames[i]) + "\r\n");
        SendKey(flyScan, false); Thread.Sleep(2); SendKey(flyScan, true);
        played++;
        double next = (i + 1) * 1000.0 / hz;
        while (sw.Elapsed.TotalMilliseconds < next && flyStopReason == null) Thread.Sleep(1);
      }
      if (!string.IsNullOrEmpty(exitCmd) && cs2Focus) {
        WriteFrame(flyCfgDir, exitCmd + "\r\n");
        SendKey(flyScan, false); Thread.Sleep(2); SendKey(flyScan, true);
        Thread.Sleep(30);
      }
    } catch (Exception e) {
      reason = "ошибка: " + e.Message;
    } finally {
      try { WriteFrame(flyCfgDir, "echo \"AUTOOBS FRAME OK\"\r\n"); } catch { }
      timeEndPeriod(1);
      ReleaseAll();
      flySeq = 0;
      Log("пролётка #" + seq + " закончена: " + reason + " (" + played + " кадров)");
      Emit("agent:fly_end", D("seq", seq, "reason", reason, "frames", played));
    }
  }

  static void Hotkey(bool on) {
    if (!on) { StopFly("выключено хоткеем"); ThreadPool.QueueUserWorkItem(delegate { ReleaseAll(); }); }
    Emit("agent:hotkey", D("action", on ? "on" : "off"));
    Log(on ? "Ctrl+Shift+PageUp — включить" : "Ctrl+Shift+PageDown — выключить");
    if (beep) ThreadPool.QueueUserWorkItem(delegate { try { Console.Beep(on ? 1200 : 600, 120); } catch { } });
  }

  static IntPtr KbHook(int nCode, IntPtr wParam, IntPtr lParam) {
    if (nCode >= 0) {
      int msg = wParam.ToInt32();
      if (msg == 0x100 || msg == 0x104) {                        // WM_KEYDOWN / WM_SYSKEYDOWN
        KBDLLHOOKSTRUCT k = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
        bool injected = (k.flags & LLKHF_INJECTED) != 0;
        if (!injected) {
          bool ctrl = (GetAsyncKeyState(0x11) & 0x8000) != 0;
          bool shift = (GetAsyncKeyState(0x10) & 0x8000) != 0;
          if (ctrl && shift && (k.vkCode == 0x21 || k.vkCode == 0x22) && (cs2Focus || hotkeysAnywhere)) {
            Hotkey(k.vkCode == 0x21);                                // 0x21 PageUp, 0x22 PageDown
          } else if (cs2Focus && k.vkCode >= 0x30 && k.vkCode <= 0x39 && !ctrl) {
            Manual("клавиша " + (char)k.vkCode);
          }
        }
      }
    }
    return CallNextHookEx(kbHook, nCode, wParam, lParam);
  }

  static IntPtr MsHook(int nCode, IntPtr wParam, IntPtr lParam) {
    if (nCode >= 0 && cs2Focus) {
      MSLLHOOKSTRUCT m = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
      if ((m.flags & LLMHF_INJECTED) == 0) {
        int msg = wParam.ToInt32();
        if (msg == 0x201 || msg == 0x204 || msg == 0x207) Manual("кнопка мыши");   // L / R / M down
        else if (msg == 0x200) {                                                    // движение
          long now = clock.ElapsedMilliseconds;
          moveTimes.Enqueue(now);
          while (moveTimes.Count > 0 && now - moveTimes.Peek() > 400) moveTimes.Dequeue();
          if (moveTimes.Count >= mouseEvents) { moveTimes.Clear(); Manual("мышь"); }
        }
      }
    }
    return CallNextHookEx(msHook, nCode, wParam, lParam);
  }

  // ── Тест облёта: spec_goto по шагам через exec-трюк ──────────────────────
  // В CS2 один раз: bind "<FrameKey>" "exec autoobs_frame". Агент каждый кадр атомарно
  // переписывает autoobs_frame.cfg (spec_goto x y z pitch yaw) и жмёт эту клавишу.
  // Орбита вокруг центра, камера смотрит в центр, плавный разгон и торможение.
  [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint ms);
  [DllImport("winmm.dll")] static extern uint timeEndPeriod(uint ms);

  static void WriteFrame(string dir, string text) {
    string dst = System.IO.Path.Combine(dir, "autoobs_frame.cfg");
    string tmp = dst + ".tmp";
    System.IO.File.WriteAllText(tmp, text, new UTF8Encoding(false));
    if (System.IO.File.Exists(dst)) System.IO.File.Replace(tmp, dst, null);
    else System.IO.File.Move(tmp, dst);
  }

  public static void FlyTest(string process, string cfgDir, double cx, double cy, double cz,
                             double radius, double height, double speed, double hz, double seconds, ushort frameScan) {
    processName = process;
    System.Globalization.CultureInfo inv = System.Globalization.CultureInfo.InvariantCulture;
    if (!System.IO.Directory.Exists(cfgDir)) { Log("Нет папки cfg: " + cfgDir); return; }
    Thread f = new Thread(FocusLoop); f.IsBackground = true; f.Start();
    Log("Переключись в окно CS2 (зритель, свободная камера). Жду фокус...");
    while (!cs2Focus) Thread.Sleep(100);
    Thread.Sleep(1500);

    timeBeginPeriod(1);
    double omega = speed / Math.Max(50, radius);            // рад/с
    double ramp = Math.Min(2.0, seconds / 3);               // разгон / торможение, с
    double pitch = Math.Atan2(height, radius) * 180 / Math.PI;
    Stopwatch sw = Stopwatch.StartNew();
    double frameMs = 1000.0 / hz, angle = 0, lastT = 0;
    int frames = 0, maxGapMs = 0; long lastFrameMs = 0;
    Log(string.Format(inv, "Облёт: центр {0:0} {1:0} {2:0}, радиус {3:0}, высота {4:0}, {5:0} ед/с, {6:0} Гц, {7:0} с",
      cx, cy, cz, radius, height, speed, hz, seconds));
    try {
      while (true) {
        double t = sw.Elapsed.TotalSeconds;
        if (t >= seconds) break;
        if (!cs2Focus) { Log("CS2 потерял фокус — тест остановлен"); break; }
        // скорость с плавным разгоном и торможением (smoothstep)
        double k = 1;
        if (t < ramp) { double u = t / ramp; k = u * u * (3 - 2 * u); }
        else if (t > seconds - ramp) { double u = (seconds - t) / ramp; k = u * u * (3 - 2 * u); }
        angle += omega * k * (t - lastT);
        lastT = t;
        double x = cx + radius * Math.Cos(angle), y = cy + radius * Math.Sin(angle), z = cz + height;
        double yaw = Math.Atan2(cy - y, cx - x) * 180 / Math.PI;
        WriteFrame(cfgDir, string.Format(inv, "spec_goto {0:0.0} {1:0.0} {2:0.0} {3:0.00} {4:0.00}\r\n", x, y, z, pitch, yaw));
        SendKey(frameScan, false); Thread.Sleep(2); SendKey(frameScan, true);
        frames++;
        long nowMs = sw.ElapsedMilliseconds;
        if (frames > 1) maxGapMs = Math.Max(maxGapMs, (int)(nowMs - lastFrameMs));
        lastFrameMs = nowMs;
        double next = frames * frameMs;
        while (sw.Elapsed.TotalMilliseconds < next) Thread.Sleep(1);
      }
    } finally {
      timeEndPeriod(1);
      WriteFrame(cfgDir, "echo \"AUTOOBS FRAME OK\"\r\n");
    }
    double real = frames / Math.Max(0.001, sw.Elapsed.TotalSeconds);
    Log(string.Format(inv, "Готово: кадров {0}, фактически {1:0.0} Гц, самый длинный промежуток {2} мс", frames, real, maxGapMs));
  }

  // ── Запуск ────────────────────────────────────────────────────────────────
  public static void Run(string server, string process, bool anywhere, int moveEvents, bool doBeep, string cfgDir, ushort frameScan) {
    serverUrl = server; processName = process; hotkeysAnywhere = anywhere; mouseEvents = Math.Max(5, moveEvents); beep = doBeep;
    flyCfgDir = !string.IsNullOrEmpty(cfgDir) && System.IO.Directory.Exists(cfgDir) ? cfgDir : null;
    flyScan = frameScan;
    Log(flyCfgDir != null ? "Пролётки: cfg = " + flyCfgDir : "Пролётки выключены: не найдена папка cfg (укажи -CfgDir)");
    Console.CancelKeyPress += delegate { ReleaseAll(); Environment.Exit(0); };

    Thread f = new Thread(FocusLoop); f.IsBackground = true; f.Start();
    Thread n = new Thread(NetLoop); n.IsBackground = true; n.Start();

    kbProc = KbHook; msProc = MsHook;                              // держим ссылки, чтобы GC не собрал делегаты
    IntPtr mod = GetModuleHandle(Process.GetCurrentProcess().MainModule.ModuleName);
    kbHook = SetWindowsHookEx(WH_KEYBOARD_LL, kbProc, mod, 0);
    msHook = SetWindowsHookEx(WH_MOUSE_LL, msProc, mod, 0);
    if (kbHook == IntPtr.Zero || msHook == IntPtr.Zero) Log("Не удалось поставить хуки клавиатуры/мыши: хоткеи и ручной перехват работать не будут");

    MSG msg;
    while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref msg); DispatchMessage(ref msg); }
    ReleaseAll();
    UnhookWindowsHookEx(kbHook); UnhookWindowsHookEx(msHook);
  }
}
"@

# Папка cfg CS2 (для пролёток через exec-трюк): -CfgDir или стандартный путь Steam
if (-not $CfgDir) {
  $guess = "C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\cfg"
  if (Test-Path $guess) { $CfgDir = $guess }
}
$scan = @{ "kp_minus" = 0x4A; "kp_plus" = 0x4E; "kp_multiply" = 0x37 }[$FrameKey]

if ($FlyTest) {
  if (-not $CfgDir) { Write-Host "Укажи -CfgDir (папка game\csgo\cfg)"; exit 1 }
  $c = ($Center -replace ",", " ").Trim() -split "\s+"
  if ($c.Count -lt 3) { Write-Host 'Укажи -Center "x y z" (из spec_pos / getpos)'; exit 1 }
  $inv = [Globalization.CultureInfo]::InvariantCulture
  Write-Host "Тест облёта. В CS2 должен быть бинд:  bind `"$FrameKey`" `"exec autoobs_frame`""
  [AutoObsAgent]::FlyTest($Process, $CfgDir, [double]::Parse($c[0], $inv), [double]::Parse($c[1], $inv), [double]::Parse($c[2], $inv),
    $Radius, $Height, $Speed, $Hz, $Seconds, [uint16]$scan)
  exit 0
}

Write-Host "Агент автообсерва: сервер $Server, окно процесса '$Process'."
Write-Host "Ctrl+Shift+PageUp — включить, Ctrl+Shift+PageDown — выключить. Выход — Ctrl+C."
Write-Host "Для пролёток в CS2 нужен бинд:  bind `"$FrameKey`" `"exec autoobs_frame`""
[AutoObsAgent]::Run($Server, $Process, [bool]$HotkeysAnywhere, $MouseMoveEvents, -not $NoBeep, $CfgDir, [uint16]$scan)
