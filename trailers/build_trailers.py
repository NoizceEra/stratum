"""STRATUM trailers — renders 3 MP4s from genuine game captures + sprite art.
PIL frames piped as rawvideo to ffmpeg (H.264, yuv420p). Silent. No narration.
Usage: python build_trailers.py [launch|portrait|settlers|all]
"""
import os, subprocess, sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = r"D:\ai-studio\stratum\data"
ASSETS = r"D:\ai-studio\stratum\public\assets"
FFMPEG = "ffmpeg"
FONT = r"C:\Windows\Fonts\consola.ttf"
FONT_B = r"C:\Windows\Fonts\consolab.ttf"

INK = (232, 230, 223)
GOLD = (201, 165, 92)
DIM = (139, 133, 120)
BG = (11, 12, 16)
FPS = 30

def font(size, bold=False):
    return ImageFont.truetype(FONT_B if bold else FONT, size)

def load(name, w=None):
    im = Image.open(os.path.join(DATA, name)).convert("RGB")
    if w:
        im = im.resize((w, int(w * im.height / im.width)), Image.LANCZOS)
    return im

def sprite(name, size):
    im = Image.open(os.path.join(ASSETS, name)).convert("RGB")
    s = min(im.size)
    im = im.crop(((im.width - s) // 2, (im.height - s) // 2,
                  (im.width + s) // 2, (im.height + s) // 2))
    return im.resize((size, size), Image.LANCZOS)

def cover(im, W, H, zoom=1.0, cx=0.5, cy=0.5):
    """Cover-crop im to W,H with zoom>1 and center point."""
    scale = max(W / im.width, H / im.height) * zoom
    nw, nh = int(im.width * scale), int(im.height * scale)
    r = im.resize((nw, nh), Image.LANCZOS)
    x = int((nw - W) * cx)
    y = int((nh - H) * cy)
    return r.crop((x, y, x + W, y + H))

def dim(im, alpha):
    return Image.blend(im, Image.new("RGB", im.size, BG), alpha)

def text_center(d, y, s, fnt, fill, W):
    bb = d.textbbox((0, 0), s, font=fnt)
    d.text(((W - (bb[2] - bb[0])) / 2 - bb[0], y), s, font=fnt, fill=fill)

def beat_frames(bg_name, dur, W, H, title, sub, zoom_to=1.12, title_size=92,
                sprites=None, portrait=False):
    """Render one beat: Ken Burns still + dim + title/sub. Returns [frames]."""
    n = int(dur * FPS)
    base = load(bg_name)
    frames = []
    f_title = font(title_size, True)
    f_sub = font(34 if not portrait else 40)
    for i in range(n):
        t = i / max(1, n - 1)
        z = 1.0 + (zoom_to - 1.0) * t
        if portrait:
            # blurred full-bleed + sharp contained panel
            full = cover(base, W, H, zoom=z).filter(ImageFilter.GaussianBlur(18))
            full = dim(full, 0.45)
            pw, ph = int(W * 0.92), int(H * 0.52)
            panel = base.copy()
            sc = max(pw / base.width, ph / base.height)
            panel = panel.resize((int(base.width * sc), int(base.height * sc)), Image.LANCZOS)
            px = (panel.width - pw) // 2
            py = int((panel.height - ph) * (0.5 - 0.1 * t))
            panel = panel.crop((px, py, px + pw, py + ph))
            full.paste(panel, ((W - pw) // 2, int(H * 0.06)))
            fr = full
            ty = int(H * 0.62)
        else:
            fr = dim(cover(base, W, H, zoom=z), 0.42)
            ty = int(H * 0.60)
        d = ImageDraw.Draw(fr)
        if sprites:
            sw = 110
            total = len(sprites) * (sw + 18) - 18
            x0 = (W - total) // 2
            for k, sn in enumerate(sprites):
                fr.paste(sprite(sn, sw), (x0 + k * (sw + 18), ty - 200))
        text_center(d, ty, title, f_title, GOLD, W)
        if sub:
            # simple wrap at ~48 chars
            words, lines, cur = sub.split(), [], ""
            for w in words:
                if len(cur) + len(w) + 1 > (34 if portrait else 56):
                    lines.append(cur); cur = w
                else:
                    cur = (cur + " " + w).strip()
            lines.append(cur)
            y = ty + title_size + 26
            for ln in lines:
                text_center(d, y, ln, f_sub, INK, W)
                y += 52
        frames.append(fr)
    return frames

def endcard(W, H, dur, portrait=False):
    n = int(dur * FPS)
    frames = []
    f_t = font(120 if not portrait else 130, True)
    f_u = font(40 if not portrait else 44)
    thumbs = ["01_oak_wood.jpg", "02_stone_ore.jpg", "03_healing_herbs.jpg",
              "06_wooden_chest.jpg", "07_iron_sword.jpg"]
    for i in range(n):
        fr = Image.new("RGB", (W, H), BG)
        d = ImageDraw.Draw(fr)
        sw = 120
        total = len(thumbs) * (sw + 20) - 20
        x0 = (W - total) // 2
        y0 = int(H * (0.22 if not portrait else 0.18))
        for k, sn in enumerate(thumbs):
            fr.paste(sprite(sn, sw), (x0 + k * (sw + 20), y0))
        text_center(d, y0 + sw + 50, "S T R A T U M", f_t, GOLD, W)
        text_center(d, y0 + sw + 50 + (150 if not portrait else 170),
                    "planetstratum.fun/play", f_u, INK, W)
        frames.append(fr)
    return frames

def assemble(frames_list, W, H, out):
    """Crossfade beats (15f), fade in/out, pipe to ffmpeg."""
    XF = 15
    seq = []
    for b, frames in enumerate(frames_list):
        if b == 0:
            # fade in from black
            for i in range(min(XF, len(frames))):
                frames[i] = Image.blend(Image.new("RGB", (W, H), (0, 0, 0)),
                                        frames[i], i / XF)
        else:
            prev = seq
            a = prev[-XF:]
            bb = frames[:XF]
            for i in range(XF):
                prev[len(prev) - XF + i] = Image.blend(a[i], bb[i], (i + 1) / (XF + 1))
            frames = frames[XF:]
        seq.extend(frames)
    # fade out
    for i in range(XF):
        j = len(seq) - XF + i
        seq[j] = Image.blend(seq[j], Image.new("RGB", (W, H), (0, 0, 0)), (i + 1) / XF)
    cmd = [FFMPEG, "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
           "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
           "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20",
           "-preset", "medium", "-movflags", "+faststart", out]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for fr in seq:
        p.stdin.write(fr.tobytes())
    p.stdin.close()
    p.wait()
    return out, len(seq) / FPS

LAUNCH = dict(W=1920, H=1080, beats=[
    ("_gate.png", 4, "S T R A T U M", "Earth's gold is gone.", {}),
    ("_play.png", 5, "ONE WORLD", "1,048,576 tiles. Never resets. Never wipes.", {}),
    ("_harvested.png", 5, "MINE - CLAIM - BUILD",
     "Harvest. Stake land forever. Craft gear.", {}),
    ("_map.png", 5, "THREE SECTORS",
     "First Acre. Ashen Hollow. Sunken Shelf.", {}),
    ("_commerce.png", 5, "EARN $STRATUM",
     "On Solana. No wallet to play. Wallet to claim.",
     {"sprites": ["01_oak_wood.jpg", "02_stone_ore.jpg",
                   "03_healing_herbs.jpg", "06_wooden_chest.jpg"]}),
])
PORTRAIT = dict(W=1080, H=1920, beats=[
    ("_harvested.png", 3, "MINE", "Take wood, ore, herb.", {"portrait": True}),
    ("_onboard.png", 3, "CLAIM", "Land forever.", {"portrait": True}),
    ("_craft2.png", 3, "BUILD", "Gear beats numbers.", {"portrait": True}),
    ("_commerce.png", 3, "EARN", "$STRATUM on Solana.", {"portrait": True}),
])
SETTLERS = dict(W=1920, H=1080, beats=[
    ("_play.png", 4, "THE LANDING CAMP",
     "Fire's lit near spawn. Three colonists wait.", {}),
    ("_onboard.png", 4, "SABLE - GUIDE",
     "Mirrors your quest. Shows you the work.", {}),
    ("_craft.png", 4, "DRAY - QUARTERMASTER",
     "Wood and ore in. Gear out.", {}),
    ("_commerce.png", 4, "ILO - ARCHIVIST",
     "Tracks every gram shipped to Earth.", {}),
])

def build(name, spec, end_dur):
    W, H = spec["W"], spec["H"]
    parts = []
    for bg, dur, title, sub, kw in spec["beats"]:
        parts.append(beat_frames(bg, dur, W, H, title, sub, **kw))
    parts.append(endcard(W, H, end_dur, portrait=(W < H)))
    out = os.path.join(ROOT, name, f"stratum-{name}.mp4")
    os.makedirs(os.path.join(ROOT, name), exist_ok=True)
    path, secs = assemble(parts, W, H, out)
    print(f"{name}: {path} {secs:.1f}s {os.path.getsize(path)//1024}KB")

if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    if which in ("all", "launch"):
        build("launch", LAUNCH, 6)
    if which in ("all", "portrait"):
        build("portrait", PORTRAIT, 3)
    if which in ("all", "settlers"):
        build("settlers", SETTLERS, 4)
