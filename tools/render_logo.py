"""Rasterise the Tagda mascot using the real materials from the .mtl."""
import sys, math
import numpy as np
from PIL import Image

OBJ = 'tagda-jperm-cube.obj'
MTL = 'tagda-jperm-cube-finnal.mtl'

# The .mtl ships with a newer export whose material names differ from the OBJ's
# usemtl names. The correspondence is one-to-one and obvious, so map rather than
# guess colours as before. (eye_iris / eye_glint / goggle_gold_liner have no
# counterpart here -- they are geometry only the newer OBJ has.)
ALIAS = {
    'plastic_body':   'plastic_core',
    'sticker_yellow': 'plastic_yellow',
    'sticker_white':  'plastic_white',
    'sticker_orange': 'plastic_orange',
    'sticker_green':  'plastic_green',
    'sticker_red':    'plastic_red',
    'sticker_blue':   'plastic_blue',
    'glasses_lens':   'eye_sclera',
    'glasses_pupil':  'eye_pupil',
    'glasses_rim':    'goggle_rim',
    'glasses_strap':  'goggle_strap',
}

def lin_to_srgb(c):
    """Kd is linear (a three.js export); screens want sRGB."""
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)

def load_mtl(path):
    mats, cur = {}, None
    for line in open(path):
        p = line.split()
        if not p:
            continue
        if p[0] == 'newmtl':
            cur = p[1]; mats[cur] = {'Kd': (0.7, 0.7, 0.7), 'Ks': (0.2,) * 3, 'Ns': 60.0}
        elif cur and p[0] == 'Kd':
            mats[cur]['Kd'] = tuple(float(x) for x in p[1:4])
        elif cur and p[0] == 'Ks':
            mats[cur]['Ks'] = tuple(float(x) for x in p[1:4])
        elif cur and p[0] == 'Ns':
            mats[cur]['Ns'] = float(p[1])
    return mats

def load_obj(path, mats):
    verts, tris, mid = [], [], []
    names, index = [], {}
    cur = 0
    def mat_index(name):
        key = ALIAS.get(name, name)
        if key not in index:
            index[key] = len(names); names.append(key)
        return index[key]
    for line in open(path):
        if line.startswith('v '):
            p = line.split(); verts.append((float(p[1]), float(p[2]), float(p[3])))
        elif line.startswith('usemtl '):
            cur = mat_index(line.split()[1])
        elif line.startswith('f '):
            idx = [int(t.split('/')[0]) for t in line.split()[1:]]
            idx = [i - 1 if i > 0 else len(verts) + i for i in idx]
            for k in range(1, len(idx) - 1):
                tris.append((idx[0], idx[k], idx[k + 1])); mid.append(cur)
    kd = np.array([lin_to_srgb(np.array(mats[n]['Kd'])) if n in mats else np.array([.7, .7, .7])
                   for n in names], np.float32)
    ks = np.array([mats[n]['Ks'][0] if n in mats else 0.2 for n in names], np.float32)
    ns = np.array([mats[n]['Ns'] if n in mats else 60.0 for n in names], np.float32)
    missing = [n for n in names if n not in mats]
    if missing:
        print('  materials not in .mtl, defaulted:', missing)
    return (np.array(verts, np.float32), np.array(tris, np.int32),
            np.array(mid, np.int32), kd, ks, ns, names)

def rot(yaw, pitch):
    cy, sy = math.cos(math.radians(yaw)), math.sin(math.radians(yaw))
    cp, sp = math.cos(math.radians(pitch)), math.sin(math.radians(pitch))
    return (np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]], np.float32) @
            np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]], np.float32))

def render(V, T, MI, KD, KS, NS, size, yaw, pitch, margin=0.95):
    P = V @ rot(yaw, pitch).T
    lo, hi = P.min(0), P.max(0)
    P = P - (lo + hi) / 2
    scale = margin * size / 2 / max(P[:, 0].max(), P[:, 1].max(), -P[:, 0].min(), -P[:, 1].min())
    sx = P[:, 0] * scale + size / 2
    sy = size / 2 - P[:, 1] * scale
    sz = P[:, 2]

    a, b, c = T[:, 0], T[:, 1], T[:, 2]
    ax, ay, az = sx[a], sy[a], sz[a]
    bx, by, bz = sx[b], sy[b], sz[b]
    cx, cy_, cz = sx[c], sy[c], sz[c]
    keep = ((bx - ax) * (cy_ - ay) - (by - ay) * (cx - ax)) < -1e-9

    n = np.cross(P[b] - P[a], P[c] - P[a])
    n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)

    L1 = np.array([-0.34, 0.52, 0.78], np.float32); L1 /= np.linalg.norm(L1)
    L2 = np.array([0.62, 0.10, 0.78], np.float32);  L2 /= np.linalg.norm(L2)
    V_ = np.array([0, 0, 1], np.float32)
    diff = 0.34 + 0.60 * np.clip(n @ L1, 0, 1) + 0.20 * np.clip(n @ L2, 0, 1)

    # Blinn-Phong highlight, so the plastic reads as plastic
    spec = np.zeros(len(T), np.float32)
    for L, w in ((L1, 1.0), (L2, 0.45)):
        H = L + V_; H /= np.linalg.norm(H)
        spec += w * np.power(np.clip(n @ H, 0, 1), np.maximum(NS[MI], 1.0))

    base = KD[MI] * 255.0
    rgb = np.clip(base * diff[:, None] + (KS[MI] * spec * 255.0)[:, None], 0, 255)

    order = np.argsort(-((az + bz + cz) / 3.0))
    order = order[keep[order]]

    colbuf = np.zeros((size, size, 3), np.float32)
    zbuf = np.full((size, size), -1e9, np.float32)
    alpha = np.zeros((size, size), np.float32)
    for t in order:
        x0, y0, z0 = ax[t], ay[t], az[t]; x1, y1, z1 = bx[t], by[t], bz[t]; x2, y2, z2 = cx[t], cy_[t], cz[t]
        minx = max(int(math.floor(min(x0, x1, x2))), 0); maxx = min(int(math.ceil(max(x0, x1, x2))), size - 1)
        miny = max(int(math.floor(min(y0, y1, y2))), 0); maxy = min(int(math.ceil(max(y0, y1, y2))), size - 1)
        if minx > maxx or miny > maxy: continue
        px, py = np.meshgrid(np.arange(minx, maxx + 1, dtype=np.float32) + .5,
                             np.arange(miny, maxy + 1, dtype=np.float32) + .5)
        d = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if abs(d) < 1e-12: continue
        w0 = ((y1 - y2) * (px - x2) + (x2 - x1) * (py - y2)) / d
        w1 = ((y2 - y0) * (px - x2) + (x0 - x2) * (py - y2)) / d
        w2 = 1 - w0 - w1
        inside = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
        if not inside.any(): continue
        z = w0 * z0 + w1 * z1 + w2 * z2
        sub = zbuf[miny:maxy + 1, minx:maxx + 1]
        m = inside & (z > sub)
        if not m.any(): continue
        sub[m] = z[m]
        colbuf[miny:maxy + 1, minx:maxx + 1][m] = rgb[t]
        alpha[miny:maxy + 1, minx:maxx + 1][m] = 1.0
    return Image.fromarray(np.concatenate([colbuf, (alpha * 255)[:, :, None]], 2).astype(np.uint8), 'RGBA')

if __name__ == '__main__':
    out, yaw, pitch = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
    ss = int(sys.argv[4]); final = int(sys.argv[5])
    mats = load_mtl(MTL)
    V, T, MI, KD, KS, NS, names = load_obj(OBJ, mats)
    print(f'{len(V)} verts, {len(T)} tris, {len(names)} materials')
    for n, k in zip(names, KD):
        print(f'   {n:20s} #{int(k[0]*255):02x}{int(k[1]*255):02x}{int(k[2]*255):02x}')
    render(V, T, MI, KD, KS, NS, ss, yaw, pitch).resize((final, final), Image.LANCZOS).save(out)
    print('wrote', out)
