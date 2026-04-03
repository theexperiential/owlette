# Owlette Tray Icons

## Universal Icon System

Owlette uses universal tray icons designed to work well on both light and dark Windows themes.

### Directory Structure

```
icons/
├── normal.ico           # Installer icon (ICO format, multi-resolution)
├── normal.png           # Normal status - system tray icon
├── warning.png          # Warning status - orange dot indicator
└── error.png            # Error status - red dot indicator
```

### Icon Usage

- **normal.ico** - Used by Inno Setup installer for the installer window icon
- **normal.png** - Used by system tray, Start Menu shortcuts, and GUI window
- **warning.png** - Displayed in tray when Firebase connection issues occur
- **error.png** - Displayed in tray when service is stopped or crashed

### Icon Design

All icons follow the HAL 9000 eye design:

- **Grey circular fill**: `RGB(60, 60, 60)` - Background circle
- **Outer circle**: Pure white `RGB(255, 255, 255)` with thicker stroke (width 4px)
- **Center dot** (pupil): Status-dependent color (small size)
  - Pure white `RGB(255, 255, 255)`: Normal status (everything OK, connected)
  - Orange `RGB(255, 153, 0)`: Warning (Firebase connection issues)
  - Red `RGB(232, 65, 24)`: Error (service stopped/crashed)

### Regenerating Icons

To regenerate all icons (if you need to change colors or design):

```bash
cd agent
python create_theme_icons.py
```

This script will:
1. Create PNG icons for tray (64x64, white circle with thicker stroke)
2. Generate multi-resolution ICO file for Inno Setup installer

### Color Palette

- **Dark Grey**: `RGB(60, 60, 60)` - Background circular fill
- **Pure White**: `RGB(255, 255, 255)` - Outer circle stroke and normal/connected status center dot
- **Orange** (warning): `RGB(255, 153, 0)` - Warning status center dot
- **Red** (error): `RGB(232, 65, 24)` - Error status center dot

### Build Integration

The build system (`build_installer_full.bat` and `build_installer_quick.bat`) automatically copies all icons to the installer package using:

```batch
xcopy /E /I /Y icons\* build\installer_package\agent\icons\
```

This ensures all icon files are included in the compiled installer.
