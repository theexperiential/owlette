"""
Test script to preview the new HAL 9000-style tray icon.
Generates preview images at different sizes and status states.
"""

import sys
import os

# Add src to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

from PIL import Image, ImageDraw
import owlette_tray

def create_preview():
    """Generate a preview image showing all icon states and sizes."""

    # Sizes to test (typical Windows tray icon sizes)
    sizes = [16, 24, 32, 64]
    statuses = ['normal', 'warning', 'error']
    status_labels = ['Normal (White)', 'Warning (Yellow)', 'Error (Red)']

    # Create a large canvas for the preview
    preview_width = sum(sizes) + (len(sizes) + 1) * 20  # Padding between icons
    preview_height = len(statuses) * 100 + 80  # Height for 3 rows + labels

    preview = Image.new('RGB', (preview_width, preview_height), (45, 55, 72))  # Slate-800 background

    # Draw title
    draw = ImageDraw.Draw(preview)
    draw.text((20, 20), "Owlette HAL 9000 Tray Icon - Windows 11 Style", fill=(255, 255, 255))
    draw.text((20, 40), "attention is all you need", fill=(156, 163, 175))  # Gray-400

    y_offset = 80

    for status_idx, (status, label) in enumerate(zip(statuses, status_labels)):
        # Draw status label
        draw.text((20, y_offset + 20), label, fill=(255, 255, 255))

        x_offset = 200

        for size in sizes:
            # Generate icon at this size
            icon = owlette_tray.create_image(status)

            # Resize to target size
            icon_resized = icon.resize((size, size), Image.Resampling.LANCZOS)

            # Create a dark background tile to show transparency
            tile = Image.new('RGB', (size + 10, size + 10), (30, 41, 59))  # Slate-900

            # Paste icon (handling transparency)
            tile.paste(icon_resized, (5, 5), icon_resized if icon_resized.mode == 'RGBA' else None)

            # Paste onto preview
            preview.paste(tile, (x_offset, y_offset))

            # Draw size label below
            draw.text((x_offset, y_offset + size + 15), f"{size}x{size}", fill=(156, 163, 175))

            x_offset += size + 30

        y_offset += 100

    # Save preview
    preview_path = os.path.join(os.path.dirname(__file__), 'icon_preview.png')
    preview.save(preview_path)
    print(f"✓ Preview saved to: {preview_path}")

    # Also save individual icons for inspection
    for status in statuses:
        icon = owlette_tray.create_image(status)
        icon_path = os.path.join(os.path.dirname(__file__), f'icon_{status}_64x64.png')
        icon.save(icon_path)
        print(f"✓ Saved {status} icon: {icon_path}")

    return preview_path

if __name__ == "__main__":
    print("Generating HAL 9000 tray icon previews...")
    print("=" * 60)
    preview_path = create_preview()
    print("=" * 60)
    print(f"\nDone! Open {preview_path} to see the preview.")
    print("\nThe icon features:")
    print("  • White circle outline (eye)")
    print("  • Status indicator dot (pupil):")
    print("    - White = Normal (connected)")
    print("    - Yellow = Warning (Firebase issues)")
    print("    - Red = Error (Service stopped)")
    print("\nDesign matches Windows 11 Fluent Design guidelines.")
