using System.Net.Http;
using System.Net.Http.Json;
using CounterStrikeSharp.API.Core;

namespace GrenadeTracker;

public class GrenadeTracker : BasePlugin
{
    public override string ModuleName  => "CS2 Pro HUD — Grenade Tracker";
    public override string ModuleVersion => "1.0.0";
    public override string ModuleAuthor  => "CS2 Pro HUD";

    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(2) };
    private static int _seq;

    public override void Load(bool hotReload)
    {
        RegisterEventHandler<EventSmokegrenadeDetonate>(OnSmoke);
        RegisterEventHandler<EventMolotovDetonate>(OnMolotov);
        RegisterEventHandler<EventHegrenadeDetonate>(OnHE);
        RegisterEventHandler<EventFlashbangDetonate>(OnFlash);
    }

    private HookResult OnSmoke(EventSmokegrenadeDetonate e, GameEventInfo _)
        => Post("smoke", e.X, e.Y, e.Z);

    private HookResult OnMolotov(EventMolotovDetonate e, GameEventInfo _)
        => Post("inferno", e.X, e.Y, e.Z);

    private HookResult OnHE(EventHegrenadeDetonate e, GameEventInfo _)
        => Post("frag", e.X, e.Y, e.Z);

    private HookResult OnFlash(EventFlashbangDetonate e, GameEventInfo _)
        => Post("flashbang", e.X, e.Y, e.Z);

    private static HookResult Post(string type, float x, float y, float z)
    {
        var id = $"{type}_{Interlocked.Increment(ref _seq)}";
        _ = Http.PostAsJsonAsync("http://localhost:3000/grenade", new { id, type, x, y, z });
        return HookResult.Continue;
    }
}
