"""Draw the icons used by the seeded demo world (public/seed-icons/*.png).

    python ml/make_seed_icons.py

The official Northstar logo is a white star on a navy tile. Clone icons are
recoloured, shifted or re-cropped copies of it, so logo similarity in the demo
is computed from real images rather than hard-coded.
"""
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

OUT = Path(__file__).resolve().parent.parent / 'public' / 'seed-icons'
SIZE = 256


def star(draw, cx, cy, r_outer, r_inner, fill, points=5, rotation=-90):
    coords = []
    for i in range(points * 2):
        r = r_outer if i % 2 == 0 else r_inner
        angle = math.radians(rotation + i * 180 / points)
        coords.append((cx + r * math.cos(angle), cy + r * math.sin(angle)))
    draw.polygon(coords, fill=fill)


def tile(bg):
    img = Image.new('RGB', (SIZE, SIZE), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle([8, 8, SIZE - 8, SIZE - 8], radius=48, fill=bg)
    return img, draw


def official():
    img, draw = tile((18, 38, 92))
    star(draw, 128, 132, 92, 38, (255, 255, 255))
    draw.ellipse([174, 52, 198, 76], fill=(255, 196, 0))
    return img


def variants():
    base = official()
    out = {'northstar-official': base}
    out['clone-recolor'] = Image.eval(base, lambda v: min(255, int(v * 1.08)))
    shifted = Image.new('RGB', (SIZE, SIZE), (255, 255, 255))
    shifted.paste(base.resize((236, 236)), (10, 12))
    out['clone-shifted'] = shifted
    out['clone-blur'] = base.filter(ImageFilter.GaussianBlur(3))
    badge, draw = tile((18, 38, 92))
    star(draw, 128, 132, 92, 38, (255, 255, 255))
    draw.ellipse([170, 160, 230, 220], fill=(220, 30, 60))
    out['clone-badge'] = badge
    tinted, draw = tile((24, 52, 120))
    star(draw, 128, 130, 88, 36, (240, 240, 240))
    out['clone-tinted'] = tinted

    for name, bg, shape in [
        ('bakery', (240, 180, 90), 'circle'), ('weather', (70, 160, 230), 'sun'),
        ('motors', (40, 40, 40), 'square'), ('studio', (160, 60, 200), 'triangle'),
        ('fan', (230, 230, 230), 'heart'), ('budget', (40, 170, 110), 'bars'),
        ('starmap', (10, 10, 30), 'dots'), ('fitness', (240, 90, 60), 'circle'),
        ('coffee', (110, 70, 40), 'square'), ('media', (250, 210, 60), 'triangle'),
    ]:
        img, draw = tile(bg)
        if shape == 'circle':
            draw.ellipse([64, 64, 192, 192], fill=(255, 255, 255))
        elif shape == 'sun':
            draw.ellipse([88, 88, 168, 168], fill=(255, 220, 0))
            for i in range(8):
                a = math.radians(i * 45)
                draw.line([128 + 56 * math.cos(a), 128 + 56 * math.sin(a), 128 + 90 * math.cos(a), 128 + 90 * math.sin(a)], fill=(255, 220, 0), width=10)
        elif shape == 'square':
            draw.rectangle([72, 72, 184, 184], fill=(255, 255, 255))
        elif shape == 'triangle':
            draw.polygon([(128, 56), (204, 196), (52, 196)], fill=(255, 255, 255))
        elif shape == 'heart':
            draw.ellipse([60, 70, 132, 142], fill=(220, 40, 80))
            draw.ellipse([124, 70, 196, 142], fill=(220, 40, 80))
            draw.polygon([(64, 120), (192, 120), (128, 200)], fill=(220, 40, 80))
        elif shape == 'bars':
            for i, h in enumerate([60, 100, 140]):
                draw.rectangle([64 + i * 48, 196 - h, 96 + i * 48, 196], fill=(255, 255, 255))
        elif shape == 'dots':
            for x, y in [(60, 70), (180, 60), (120, 140), (70, 190), (200, 180), (150, 90)]:
                draw.ellipse([x - 6, y - 6, x + 6, y + 6], fill=(255, 255, 255))
        out[f'other-{name}'] = img
    return out


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, img in variants().items():
        img.save(OUT / f'{name}.png', optimize=True)
    print(f'wrote {len(list(OUT.glob("*.png")))} icons to {OUT}')


if __name__ == '__main__':
    main()
