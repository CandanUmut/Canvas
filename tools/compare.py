#!/usr/bin/env python3
"""Hold a run up against the reference and say, in numbers, how it differs.

    python3 tools/compare.py out/run/final.png ref.png out/report

Prints the things that actually decide whether a landscape reads: the value
range, where the values sit, how the colour balance differs, and both of
those band by band down the picture -- sky, mountain, treeline, water -- so a
difference can be traced to the part of the painting that caused it.
"""
import sys
from PIL import Image
import numpy as np

def load(p, size=(1440, 1080)):
    return np.asarray(Image.open(p).convert('RGB').resize(size, Image.LANCZOS)).astype(float) / 255

def luma(a):
    return a @ [0.2126, 0.7152, 0.0722]

BANDS = [
    ('sky        y0-300', 0, 300),
    ('cloud/sky  y300-520', 300, 520),
    ('mountain   y520-720', 520, 720),
    ('trees      y720-880', 720, 880),
    ('water/fg   y880-1080', 880, 1080),
]

def stats(a, name):
    l = luma(a)
    sat = a.max(2) - a.min(2)
    print(f'  {name:22s} L mean {l.mean():.3f}  p5 {np.percentile(l,5):.3f}  p95 {np.percentile(l,95):.3f}'
          f'  range {np.percentile(l,95)-np.percentile(l,5):.3f}  sat {sat.mean():.3f}'
          f'  rgb {a.reshape(-1,3).mean(0).round(3)}')

def main():
    got_p, ref_p, out = sys.argv[1], sys.argv[2], (sys.argv[3] if len(sys.argv) > 3 else None)
    got, ref = load(got_p), load(ref_p)

    print('WHOLE PICTURE')
    stats(ref, 'reference')
    stats(got, 'painted')

    print('\nBY BAND                 reference                                             painted')
    for name, y0, y1 in BANDS:
        r, g = ref[y0:y1], got[y0:y1]
        lr, lg = luma(r), luma(g)
        sr, sg = (r.max(2)-r.min(2)).mean(), (g.max(2)-g.min(2)).mean()
        print(f'  {name:22s} L {lr.mean():.3f} rng {np.percentile(lr,95)-np.percentile(lr,5):.3f} sat {sr:.3f}'
              f'   |   L {lg.mean():.3f} rng {np.percentile(lg,95)-np.percentile(lg,5):.3f} sat {sg:.3f}'
              f'   dL {lg.mean()-lr.mean():+.3f}')

    print('\nDETAIL (local contrast at 3 scales -- how much texture is there)')
    for k in (2, 8, 32):
        def rough(a):
            l = luma(a)
            sm = np.asarray(Image.fromarray((l*255).astype(np.uint8)).filter(
                __import__('PIL.ImageFilter', fromlist=['x']).GaussianBlur(k))).astype(float)/255
            return float(np.abs(l - sm).mean())
        print(f'  sigma {k:3d}px   reference {rough(ref):.4f}   painted {rough(got):.4f}')

    d = np.abs(got - ref).mean()
    print(f'\nMean absolute difference: {d:.4f}')

    if out:
        h = 1080
        side = Image.new('RGB', (1440*2 + 24, h), (24, 24, 26))
        side.paste(Image.open(ref_p).convert('RGB').resize((1440, h)), (0, 0))
        side.paste(Image.open(got_p).convert('RGB').resize((1440, h)), (1464, 0))
        side.save(out + '-side.png')
        # Where the values are wrong, and by how much.
        diff = (luma(got) - luma(ref))
        img = np.zeros((h, 1440, 3))
        img[..., 0] = np.clip(diff, 0, 1)      # painted too light -> red
        img[..., 2] = np.clip(-diff, 0, 1)     # painted too dark  -> blue
        Image.fromarray((img*255).astype(np.uint8)).save(out + '-value-diff.png')
        print('wrote', out + '-side.png', 'and', out + '-value-diff.png')

main()
