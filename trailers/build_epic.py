"""STRATUM epic AI-style trailer — procedural cinematic scenes + game stills,
fast hard cuts with gold flash frames, slamming captions. 16:9, ~32s, silent.
Usage: python build_epic.py
"""
import os, subprocess
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = r"D:\ai-studio\stratum\data"
ASSETS = r"D:\ai-studio\stratum\public\assets"
FFMPEG = "ffmpeg"
FONT = r"C:\Windows\Fonts\consola.ttf"
FONT_B = r"C:\Windows\Fonts\consolab.ttf"
W, H, FPS = 1920, 1080, 30
GOLD = (201, 165, 92)
INK = (232, 230, 223)
BG = (11, 12, 16)
rng = np.random.default_rng(1337)

def font(s, bold=False):
    return ImageFont.truetype(FONT_B if bold else FONT, s)

# ---------------- procedural scenes ----------------

def planet():
    """Starfield + planet limb with gold rim. Returns PIL 1920x1080."""
    a = np.zeros((H, W, 3), np.float32)
    # deep space gradient
    yy = np.linspace(0, 1, H)[:, None]
    a[:, :] = np.array([10, 12, 24], np.float32) * (1 - yy * 0.5)[..., None]
    # nebula blobs
    for _ in range(7):
        cx, cy = rng.integers(0, W), rng.integers(0, H)
        r = rng.integers(150, 420)
        col = np.array(rng.choice([[[90, 60, 140]], [[40, 110, 130]], [[130, 70, 60]]])[0], np.float32)
        Y, X = np.ogrid[:H, :W]
        m = np.exp(-((X - cx) ** 2 + (Y - cy) ** 2) / (2 * r * r))
        a += (m * 0.35)[..., None] * col
    # stars
    n = 900
    xs, ys = rng.integers(0, W, n), rng.integers(0, H, n)
    b = rng.uniform(0.3, 1.0, n)
    a[ys, xs] = np.clip(a[ys, xs] + (b * 255)[:, None] * np.array([0.9, 0.93, 1.0]), 0, 255)
    # planet disc, lower right
    pcx, pcy, pr = W * 0.62, H * 1.55, H * 0.95
    Y, X = np.ogrid[:H, :W]
    d = np.sqrt((X - pcx) ** 2 + (Y - pcy) ** 2) / pr
    inside = d < 1.0
    # surface bands
    bands = (np.sin(d * 22 + (X / W) * 6) * 0.5 + 0.5)
    surf = (np.array([38, 30, 26]) * (0.55 + 0.45 * bands[..., None]))
    # night side shading: light from upper left
    lx, ly = (X - pcx) / pr, (Y - pcy) / pr
    light = np.clip(0.35 - 0.65 * (lx * -0.6 + ly * -0.8), 0.12, 1.0)
    a[inside] = surf[inside] * light[inside][..., None] * 3.2
    # gold rim on upper-left limb
    rim = np.exp(-((d - 1.0) ** 2) / 0.0006) * np.clip(-(lx * -0.6 + ly * -0.8), 0, 1)
    a += (rim * 0.9)[..., None] * np.array([201, 165, 92], np.float32)
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))

def warp():
    """Radial warp streaks. Returns PIL."""
    a = np.zeros((H, W, 3), np.float32) + np.array([6, 7, 12], np.float32)
    cx, cy = W / 2, H / 2
    Y, X = np.ogrid[:H, :W]
    ang = np.arctan2(Y - cy, X - cx)
    rad = np.sqrt((X - cx) ** 2 + (Y - cy) ** 2)
    for _ in range(260):
        a0 = rng.uniform(-np.pi, np.pi)
        r0 = rng.uniform(60, 500)
        length = rng.uniform(40, 260)
        wdt = rng.uniform(0.001, 0.004)
        m = (np.abs((ang - a0 + np.pi) % (2 * np.pi) - np.pi) < wdt) & (rad > r0) & (rad < r0 + length)
        bright = rng.uniform(0.4, 1.0)
        a[m] += np.array([200 * bright, 170 * bright, 120 * bright], np.float32)
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))

def load_still(name):
    return Image.open(os.path.join(DATA, name)).convert("RGB")

def grade(im):
    im = ImageEnhance.Contrast(im).enhance(1.12)
    im = ImageEnhance.Color(im).enhance(1.15)
    return im

def sprite(name, size):
    im = Image.open(os.path.join(ASSETS, name)).convert("RGB")
    s = min(im.size)
    im = im.crop(((im.width - s) // 2, (im.height - s) // 2,
                  (im.width + s) // 2, (im.height + s) // 2))
    return im.resize((size, size), Image.LANCZOS)

def cover(im, zoom=1.0, cx=0.5, cy=0.5):
    scale = max(W / im.width, H / im.height) * zoom
    r = im.resize((int(im.width * scale), int(im.height * scale)), Image.LANCZOS)
    x, y = int((r.width - W) * cx), int((r.height - H) * cy)
    return r.crop((x, y, x + W, y + H))

def text_center(d, y, s, fnt, fill):
    bb = d.textbbox((0, 0), s, font=fnt)
    d.text(((W - (bb[2] - bb[0])) / 2 - bb[0], y), s, font=fnt, fill=fill)

# ---------------- beats ----------------
# (bg, dur, title, sub, style) style: punch zoom + rise-in captions, graded stills
BEATS = [
    ("proc:planet", 2.6, "EARTH'S GOLD IS GONE.", "Stratum is where we find more."),
    ("_map.png", 2.2, "ONE WORLD.", "1,048,576 tiles. No resets. No mercy."),
    ("_harvested.png", 2.0, "MINE.", "Rip it out of the ground."),
    ("_onboard.png", 2.0, "CLAIM. FOREVER.", "Nobody overwrites you. Ever."),
    ("_craft.png", 2.0, "BUILD.", "Gear beats numbers."),
    ("_play.png", 2.2, "FIGHT.", "The fauna objects."),
    ("proc:warp", 1.6, "", ""),
    ("_commerce.png", 2.6, "EARN $STRATUM.", "On Solana. Wallet to claim.",
     ["01_oak_wood.jpg", "02_stone_ore.jpg", "03_healing_herbs.jpg", "06_wooden_chest.jpg"]),
    ("_mobile2.png", 2.2, "THE CAMP IS LIT.", "Sable. Dray. Ilo. Tap to talk."),
    ("END", 5.0, "", ""),
]

BG_CACHE = {}
def bg(name):
    if name not in BG_CACHE:
        if name == "proc:planet":
            BG_CACHE[name] = planet()
        elif name == "proc:warp":
            BG_CACHE[name] = warp()
        else:
            BG_CACHE[name] = grade(load_still(name))
    return BG_CACHE[name]

def render_beat(bg_name, dur, title, sub, thumbs=()):
    n = int(dur * FPS)
    f_t = font(104, True)
    f_s = font(36)
    frames = []
    for i in range(n):
        t = i / max(1, n - 1)
        z = 1.06 + 0.22 * t  # hard punch-in
        fr = cover(bg(bg_name), zoom=z)
        # darken edges for caption legibility
        ov = Image.new("L", (W, H), 0)
        od = ImageDraw.Draw(ov)
        od.rectangle([0, int(H * 0.52), W, H], fill=110)
        fr.paste(Image.new("RGB", (W, H), BG), (0, 0), ov)
        d = ImageDraw.Draw(fr, "RGBA")
        if thumbs:
            sw = 100
            total = len(thumbs) * (sw + 16) - 16
            x0 = (W - total) // 2
            for k, sn in enumerate(thumbs):
                fr.paste(sprite(sn, sw), (x0 + k * (sw + 16), int(H * 0.30)))
        # caption rise-in over first 10 frames
        k = min(1.0, i / 10)
        rise = int(34 * (1 - k))
        if title:
            d = ImageDraw.Draw(fr, "RGBA")
            # shadow + main for punch
            bb = d.textbbox((0, 0), title, font=f_t)
            tw = bb[2] - bb[0]
            x = (W - tw) / 2 - bb[0]
            y = int(H * 0.62) + rise
            a = int(255 * k)
            d.text((x + 3, y + 3), title, font=f_t, fill=(0, 0, 0, a))
            d.text((x, y), title, font=f_t, fill=GOLD + (a,))
            if sub and k > 0.4:
                sa = int(255 * (k - 0.4) / 0.6)
                bb2 = d.textbbox((0, 0), sub, font=f_s)
                x2 = (W - (bb2[2] - bb2[0])) / 2 - bb2[0]
                d.text((x2, y + 130), sub, font=f_s, fill=INK + (sa,))
        frames.append(fr.convert("RGB"))
    return frames

def endcard(dur):
    n = int(dur * FPS)
    frames = []
    f_t = font(120, True)
    f_u = font(42)
    thumbs = ["01_oak_wood.jpg", "02_stone_ore.jpg", "03_healing_herbs.jpg",
              "06_wooden_chest.jpg", "07_iron_sword.jpg"]
    for i in range(n):
        k = min(1.0, i / 12)
        fr = Image.new("RGB", (W, H), BG)
        d = ImageDraw.Draw(fr)
        sw = 120
        total = len(thumbs) * (sw + 20) - 20
        x0 = (W - total) // 2
        for kk, sn in enumerate(thumbs):
            fr.paste(sprite(sn, sw), (x0 + kk * (sw + 20), int(H * 0.20)))
        d = ImageDraw.Draw(fr, "RGBA")
        a = int(255 * k)
        bb = d.textbbox((0, 0), "S T R A T U M", font=f_t)
        x = (W - (bb[2] - bb[0])) / 2 - bb[0]
        d.text((x, int(H * 0.44)), "S T R A T U M", font=f_t, fill=GOLD + (a,))
        bb2 = d.textbbox((0, 0), "planetstratum.fun/play", font=f_u)
        x2 = (W - (bb2[2] - bb2[0])) / 2 - bb2[0]
        d.text((x2, int(H * 0.66)), "planetstratum.fun/play", font=f_u, fill=INK + (a,))
        frames.append(fr.convert("RGB"))
    return frames

def main():
    seq = []
    for b in BEATS:
        name, dur, title, sub = b[0], b[1], b[2], b[3]
        thumbs = b[4] if len(b) > 4 else ()
        if name == "END":
            seq.append(endcard(dur))
            continue
        seq.append(render_beat(name, dur, title, sub, thumbs))
    # hard cuts with 3-frame gold flash
    FLASH = [Image.new("RGB", (W, H), (201, 165, 92))] * 2 + \
            [Image.new("RGB", (W, H), (60, 48, 30))]
    out = []
    for i, beat in enumerate(seq):
        if i > 0:
            out.extend(FLASH)
        out.extend(beat)
    # fade in/out
    for i in range(10):
        out[i] = Image.blend(Image.new("RGB", (W, H), (0, 0, 0)), out[i], i / 10)
    for i in range(12):
        j = len(out) - 12 + i
        out[j] = Image.blend(out[j], Image.new("RGB", (W, H), (0, 0, 0)), (i + 1) / 12)
    path = os.path.join(ROOT, "epic", "stratum-epic.mp4")
    os.makedirs(os.path.join(ROOT, "epic"), exist_ok=True)
    cmd = [FFMPEG, "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
           "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
           "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20",
           "-preset", "medium", "-movflags", "+faststart", path]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for fr in out:
        p.stdin.write(fr.tobytes())
    p.stdin.close()
    p.wait()
    print(f"epic: {path} {len(out)/FPS:.1f}s {os.path.getsize(path)//1024}KB")

if __name__ == "__main__":
    main()
