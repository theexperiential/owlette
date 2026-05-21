# Owlette Tray Icons

## Universal Icon System

Owlette uses a single owl-eye icon, recolored per status, designed to read well on both light and dark Windows themes.

### Directory Structure

```
icons/
├── normal.ico / normal.png              # connected / healthy
├── disconnected.ico / disconnected.png  # running but not reaching the cloud
├── warning.ico / warning.png            # reserved (see note under Icon Design)
└── error.ico / error.png                # service stopped/crashed or health error
```

ICO files are multi-resolution (16x16–256x256) so Windows can pick the right size per DPI; the PNGs are the fallback when an ICO is missing.

### Icon Usage

- **normal** — system tray when connected/healthy; `normal.ico` is also the Inno Setup installer window icon
- **disconnected** — shown in the tray when the service is running but can't reach the cloud (offline, or still starting up)
- **error** — shown (flashing) when the service is stopped/crashed or a health probe fails
- **warning** — present for completeness, but the tray currently displays the `disconnected` glow for connection-issue states

### Icon Design

All icons are a HAL 9000-inspired owl eye: a warm radial glow — a bright cream center fading through amber to a near-black rim — with a soft catch-light highlight. There is no separate indicator dot; the **whole eye is recolored** to signal status:

- **normal** — warm amber/coral glow (everything OK, connected)
- **disconnected** — dim, muted glow (running but offline)
- **error** — red glow (stopped/crashed or health error)

The warm center against the dark rim keeps the icon legible on both light and dark taskbars.

### Regenerating Icons

> **Note:** the legacy scripts in this folder (`create_theme_icons.py`, `create_hidpi_icons.py`, `create_sharp_ico.py`, `redraw_icons_hidpi.py`) draw the *older* white-ring-and-center-dot design and do **not** reproduce the current owl-eye glow. Don't run them against the shipped icons — they'll overwrite them with the deprecated look. They're kept for reference only.

### Build Integration

The build system (`build_installer_full.bat` and `build_installer_quick.bat`) automatically copies all icons to the installer package using:

```batch
xcopy /E /I /Y icons\* build\installer_package\agent\icons\
```

This ensures all icon files are included in the compiled installer.
