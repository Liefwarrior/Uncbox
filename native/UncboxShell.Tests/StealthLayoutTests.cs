using System.Drawing;
using System.Text.Json.Nodes;
using UncboxShell;

namespace UncboxShell.Tests;

/// <summary>
/// Stealth mode's arithmetic (StealthLayout.cs): where the game goes in the manager's preview, the
/// scene the streaming engine is told about, and where the manager opens. The preview has to put the
/// game where the engine puts it for viewers (engine/src/scene.rs, place_game), so the cases mirror
/// the engine's tests.
/// </summary>
public class StealthLayoutTests
{
    private static GamePanel Panel(double x, double y, double w, double h, string fit = "contain", double strip = 0,
        double left = 0, double top = 0, double right = 0, double bottom = 0) =>
        new(new Box(x, y, w, h), left, top, right, bottom, strip, fit);

    private static void Near(Box expected, Box actual)
    {
        Assert.Equal(expected.X, actual.X, 3);
        Assert.Equal(expected.Y, actual.Y, 3);
        Assert.Equal(expected.W, actual.W, 3);
        Assert.Equal(expected.H, actual.H, 3);
    }

    [Fact]
    public void Fitting_keeps_the_shape_in_the_middle()
    {
        Near(new Box(40, 0, 1200, 675), new Box(0, 0, 1280, 675).Fitted(16.0 / 9));
        Near(new Box(0, 45, 2560, 1350), new Box(0, 0, 2560, 1440).Fitted(1280.0 / 675));
        Near(new Box(5, 5, 10, 10), new Box(5, 5, 10, 10).Fitted(0));
    }

    [Fact]
    public void A_full_screen_game_fits_inside_its_panel_as_viewers_see_it()
    {
        // WoW's 16 x 15 panel on a 1920 x 1080 dashboard, the game a 2560 x 1440 screen: as the engine places it.
        var placed = StealthLayout.PlaceGame(new Box(0, 0, 1920, 1080), 1920, 1080, Panel(0, 0, 1280, 675), 2560, 1440);
        Assert.NotNull(placed);
        Near(new Box(0, 0, 2560, 1440), placed.Value.Source);
        Near(new Box(40, 0, 1200, 675), placed.Value.Dest);
    }

    [Fact]
    public void The_preview_is_the_same_picture_made_smaller()
    {
        // The dashboard drawn at half size, 100 px into the preview: the game panel follows.
        var placed = StealthLayout.PlaceGame(new Box(100, 20, 960, 540), 1920, 1080, Panel(0, 0, 1280, 720, "stretch"), 1280, 720);
        Assert.NotNull(placed);
        Near(new Box(100, 20, 640, 360), placed.Value.Dest);
        Near(new Box(0, 0, 1280, 720), placed.Value.Source);
    }

    [Fact]
    public void Cover_fills_the_panel_and_trims_the_game()
    {
        var placed = StealthLayout.PlaceGame(new Box(0, 0, 1920, 1080), 1920, 1080, Panel(0, 0, 1280, 675, "cover"), 2560, 1440);
        Assert.NotNull(placed);
        Near(new Box(0, 0, 1280, 675), placed.Value.Dest);
        Near(new Box(0, 45, 2560, 1350), placed.Value.Source);
    }

    [Fact]
    public void The_wow_strip_and_the_crop_stay_out_of_the_preview()
    {
        var placed = StealthLayout.PlaceGame(new Box(0, 0, 1920, 1080), 1920, 1080,
            Panel(0, 0, 1000, 500, "stretch", strip: 8, left: 0.05, top: 0.1, right: 0.05, bottom: 0.1), 2000, 1008);
        Assert.NotNull(placed);
        Near(new Box(100, 108, 1800, 800), placed.Value.Source);
    }

    [Fact]
    public void A_panel_partly_off_the_dashboard_is_trimmed_with_its_game()
    {
        var placed = StealthLayout.PlaceGame(new Box(0, 0, 1920, 1080), 1920, 1080, Panel(-200, 0, 800, 400, "stretch"), 1600, 800);
        Assert.NotNull(placed);
        Near(new Box(0, 0, 600, 400), placed.Value.Dest);
        Near(new Box(400, 0, 1200, 800), placed.Value.Source);
        Assert.Null(StealthLayout.PlaceGame(new Box(0, 0, 1920, 1080), 1920, 1080, Panel(5000, 0, 300, 300), 1600, 800));
    }

    [Fact]
    public void Nothing_is_placed_without_pictures()
    {
        Assert.Null(StealthLayout.PlaceGame(new Box(0, 0, 1920, 1080), 0, 0, Panel(0, 0, 100, 100), 100, 100));
        Assert.Null(StealthLayout.PlaceGame(new Box(0, 0, 1920, 1080), 1920, 1080, Panel(0, 0, 100, 100), 0, 0));
        Assert.Null(StealthLayout.PlaceGame(new Box(0, 0, 0, 0), 1920, 1080, Panel(0, 0, 100, 100), 100, 100));
        // A strip and crop that leave nothing of the game.
        Assert.Null(StealthLayout.PlaceGame(new Box(0, 0, 1920, 1080), 1920, 1080,
            Panel(0, 0, 100, 100, strip: 256, left: 0.45, top: 0.45, right: 0.45, bottom: 0.45), 300, 258));
    }

    [Fact]
    public void The_scene_has_the_dashboard_and_the_game_over_its_panel()
    {
        var scene = StealthLayout.Scene(new IntPtr(1001), 2560, 1440, true, new IntPtr(2002),
            Panel(10.4, 20.6, 1706.7, 900, "cover", strip: 5, top: 0.05));
        var expected = JsonNode.Parse("""
            { "window": "1001", "cursor": false, "size": { "w": 2560, "h": 1440 },
              "game": { "window": "2002", "rect": { "x": 10, "y": 21, "w": 1707, "h": 900 },
                        "crop": { "top": 5, "right": 0, "bottom": 0, "left": 0 }, "stripPx": 5, "fit": "cover" } }
            """);
        Assert.True(JsonNode.DeepEquals(expected, scene), scene.ToJsonString());
    }

    [Fact]
    public void Without_a_game_the_scene_is_the_dashboard_alone()
    {
        Assert.Null(StealthLayout.Scene(new IntPtr(7), 1920, 1080, true, IntPtr.Zero, Panel(0, 0, 100, 100))["game"]);
        Assert.Null(StealthLayout.Scene(new IntPtr(7), 1920, 1080, true, new IntPtr(9), null)["game"]);
        Assert.Null(StealthLayout.Scene(new IntPtr(7), 1920, 1080, true, new IntPtr(9), Panel(0, 0, 1, 100))["game"]);
        // Outside stealth mode the pointer is over the dashboard, so its capture draws it.
        Assert.Equal(true, (bool?)StealthLayout.Scene(new IntPtr(7), 1920, 1080, false, IntPtr.Zero, null)["cursor"]);
        Assert.Equal("contain", (string?)StealthLayout.Scene(new IntPtr(7), 1920, 1080, true, new IntPtr(9), Panel(0, 0, 100, 100, "zoom"))["game"]?["fit"]);
    }

    [Fact]
    public void The_manager_opens_on_another_screen_when_there_is_one()
    {
        var main = new Rectangle(0, 0, 2560, 1440);
        var second = new Rectangle(2560, 0, 1920, 1040);
        var bounds = StealthLayout.ManagerBounds(main, [new Rectangle(0, 0, 2560, 1400), second]);
        Assert.True(second.Contains(bounds), $"{bounds}");
        // One screen: in the middle of it, smaller than it.
        var only = StealthLayout.ManagerBounds(main, [new Rectangle(0, 0, 2560, 1400)]);
        Assert.True(new Rectangle(0, 0, 2560, 1400).Contains(only), $"{only}");
        Assert.Equal(only.X, (2560 - only.Width) / 2);
        // A small screen still holds it.
        var small = StealthLayout.ManagerBounds(new Rectangle(0, 0, 800, 600), [new Rectangle(0, 0, 800, 560)]);
        Assert.True(new Rectangle(0, 0, 800, 560).Contains(small), $"{small}");
    }
}
