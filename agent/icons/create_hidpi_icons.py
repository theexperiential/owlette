"""
Create high-resolution system tray icons for HiDPI displays.
Generates multi-resolution .ico files for Windows system tray.
"""
from PIL import Image, ImageDraw

def create_tray_icon_image(center_color, size=256):
    """Tray icon: dark grey ring around a `center_color` RGB dot, `size` px."""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    center = size // 2

    outer_radius = int(size * 0.45)  # 45% of image size
    ring_width = int(size * 0.12)    # 12% ring thickness
    inner_radius = outer_radius - ring_width

    ring_color = (60, 60, 60, 255)
    draw.ellipse(
        [(center - outer_radius, center - outer_radius),
         (center + outer_radius, center + outer_radius)],
        fill=ring_color
    )

    # Punch out the middle to make it a ring.
    draw.ellipse(
        [(center - inner_radius, center - inner_radius),
         (center + inner_radius, center + inner_radius)],
        fill=(0, 0, 0, 0)
    )

    dot_radius = int(size * 0.15)  # 15% of image size
    draw.ellipse(
        [(center - dot_radius, center - dot_radius),
         (center + dot_radius, center + dot_radius)],
        fill=center_color + (255,)  # Add alpha channel
    )

    return img

def create_multi_resolution_ico(output_path, center_color):
    """Multi-resolution .ico for the Windows tray, covering every common size."""
    sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]

    images = []
    for size in sizes:
        img = create_tray_icon_image(center_color, size)
        images.append(img)

    # images[0] is the "main" image; the rest ride along as extra sizes.
    images[0].save(
        output_path,
        format='ICO',
        sizes=[(img.width, img.height) for img in images],
        append_images=images[1:]
    )

    print(f"Created multi-resolution .ico with sizes: {sizes}")
    print(f"Saved to: {output_path}")

def create_png_icon(output_path, center_color, size=256):
    """High-resolution PNG icon."""
    img = create_tray_icon_image(center_color, size)
    img.save(output_path, 'PNG', optimize=True)
    print(f"Created {size}x{size} PNG: {output_path}")

if __name__ == '__main__':
    import os

    icon_dir = os.path.dirname(__file__)

    print("Creating high-resolution icons for Windows system tray...\n")

    print("1. Normal status (white dot):")
    create_multi_resolution_ico(
        os.path.join(icon_dir, 'normal.ico'),
        center_color=(255, 255, 255)
    )
    create_png_icon(
        os.path.join(icon_dir, 'normal.png'),
        center_color=(255, 255, 255),
        size=256
    )
    print()

    print("2. Warning status (orange dot):")
    create_multi_resolution_ico(
        os.path.join(icon_dir, 'warning.ico'),
        center_color=(255, 165, 0)
    )
    create_png_icon(
        os.path.join(icon_dir, 'warning.png'),
        center_color=(255, 165, 0),
        size=256
    )
    print()

    print("3. Error status (red dot):")
    create_multi_resolution_ico(
        os.path.join(icon_dir, 'error.ico'),
        center_color=(220, 50, 50)
    )
    create_png_icon(
        os.path.join(icon_dir, 'error.png'),
        center_color=(220, 50, 50),
        size=256
    )
    print()

    print("✓ All HiDPI icons created successfully!")
    print("✓ Multi-resolution .ico files will automatically scale for any DPI setting")
    print("✓ Rebuild the installer to bundle the new icons")
