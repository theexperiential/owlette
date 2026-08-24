"""
Generate theme-aware tray icons for Owlette.
Creates dark brown icons for light theme and white icons for dark theme.
"""
from PIL import Image, ImageDraw
import os

def create_hal_icon(circle_color, dot_color, size=64, output_path='icon.png'):
    """HAL 9000-style eye icon: `circle_color` ring, `dot_color` pupil, `size` px square."""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    center = size // 2
    outer_radius = size // 2 - 2  # small margin
    inner_radius = size // 8

    grey_fill = (60, 60, 60)

    # Background fill.
    draw.ellipse(
        [(center - outer_radius, center - outer_radius),
         (center + outer_radius, center + outer_radius)],
        fill=grey_fill + (255,)
    )

    # Ring, over the fill.
    draw.ellipse(
        [(center - outer_radius, center - outer_radius),
         (center + outer_radius, center + outer_radius)],
        outline=circle_color + (255,),
        width=4
    )

    # Pupil.
    draw.ellipse(
        [(center - inner_radius, center - inner_radius),
         (center + inner_radius, center + inner_radius)],
        fill=dot_color + (255,)
    )

    img.save(output_path, 'PNG')
    print(f"Created: {output_path}")

def create_ico_file(png_path, ico_path):
    """PNG -> multi-resolution Windows ICO."""
    img = Image.open(png_path)

    sizes = [(16, 16), (32, 32), (48, 48), (64, 64), (256, 256)]

    icons = []
    for size in sizes:
        resized = img.resize(size, Image.Resampling.LANCZOS)
        icons.append(resized)

    icons[0].save(ico_path, format='ICO', sizes=[(img.width, img.height) for img in icons], append_images=icons[1:])
    print(f"Created: {ico_path}")

def main():
    WHITE = (255, 255, 255)
    ORANGE = (255, 153, 0)
    RED = (232, 65, 24)

    base_dir = os.path.dirname(__file__)
    icons_dir = os.path.join(base_dir, 'icons')

    os.makedirs(icons_dir, exist_ok=True)

    print("Generating universal tray icons...")
    print()

    # White ring throughout; the pupil carries the status colour.
    print("Creating universal icons:")
    create_hal_icon(WHITE, WHITE, output_path=os.path.join(icons_dir, 'normal.png'))
    create_hal_icon(WHITE, ORANGE, output_path=os.path.join(icons_dir, 'warning.png'))
    create_hal_icon(WHITE, RED, output_path=os.path.join(icons_dir, 'error.png'))
    print()

    print(f"Done! Icons created in: {icons_dir}")
    print()

    # Inno Setup installer icon.
    print("Creating ICO file for installer:")
    ico_path = os.path.join(icons_dir, 'normal.ico')
    create_ico_file(os.path.join(icons_dir, 'normal.png'), ico_path)
    print()
    print(f"Installer icon: {ico_path}")

if __name__ == '__main__':
    main()
