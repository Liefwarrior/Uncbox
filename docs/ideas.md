# Ideas

Things to build next, newest first. Move an item out when it ships.

- **SMITE 2 K/D/A, T screen and Tab screen.** Not in the game's log, so they have to be read off
  the screen with Windows OCR (like the Stats panel): K/D/A, gold and level from the HUD, damage
  dealt and taken from the T screen while it's open, everyone's builds and stats from the Tab
  screen. Needs screenshots of each to place the reading boxes and parse the tables.

- **Ping and FPS widget.** SMITE 2 writes a performance timeline while you play
  (`%LOCALAPPDATA%\SMITE2Alpha\Saved\Logs\PEX_Timeline_*.csv`, one row a second: frame time, GPU
  time, ping, packets). A widget could show live ping and frame rate from it, and from other games'
  equivalents where they exist.
- **Instant Steam handoff.** When a game starts from Big Picture inside Uncbox, the app should
  catch the game's window the moment Windows creates it (a WinEvent hook on new windows from
  programs in the Steam game folders) instead of polling Steam every 3 s and windows every 2 s.
  Same on the way back to Big Picture.
