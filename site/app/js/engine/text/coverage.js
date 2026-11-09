// Which characters each bundled font has, read from the fonts' own character maps, so a font is
// chosen for each character without downloading every font first. Each set lists ranges of code
// points as "gap.length" pairs in base 36 (gap from the end of the range before). tests/text.test.mjs
// checks these against the fonts: if a font changes, it fails and prints the set to put here.

const SETS = {
  s0: '0.0,c.0,i.2m,x.k7,2.5,4.6,1.0,1.j,1.1q,e.8v,2bv.0,1x0.g,4.0,1.7,c1.8,3b.6x,1.7u,2.5,2.11,2.5,2.7,1.0,1.0,1.0,1.u,2.1g,1.e,1.d,2.5,1.i,2.2,1.8,1.2s,1.b,2.q,1.c,3.w,1b.0,f.2n,z.1,4.0,3s.0,qh.0,1ar.v,9s.3h,noi.2n,2o.5m,5.1,1.0,1.4,o.d,8e.0,e9.1n,fpw.6,l5.0,v.f,5r.0,70.1,1he.5,1.15,1.8,16it.u',
  s1: '0.0,c.0,i.2m,x.k7,2.5,4.6,1.0,1.j,1.1q,e.8v,48w.g,4.0,1.7,c1.8,3b.6x,1.7u,2.5,2.11,2.5,2.7,1.0,1.0,1.0,1.u,2.1g,1.e,1.d,2.5,1.i,2.2,1.8,1.2s,1.b,2.q,1.c,3.v,1c.0,f.2n,10.0,4.0,3s.0,qh.0,1ar.v,9s.3h,noi.2n,2o.5m,5.1,1.0,1.4,o.d,8e.0,e9.1n,fpw.6,l5.0,v.f,5r.0,70.1,1he.5,1.15,1.8,16it.u',
  s2: '0.0,c.0,i.2m,x.c,1.jt,2.5,4.6,1.0,1.j,1.1q,e.8v,2bv.0,1x0.g,4.0,1.7,c1.8,3b.6x,1.7u,2.5,2.11,2.5,2.7,1.0,1.0,1.0,1.u,2.1g,1.e,1.d,2.5,1.i,2.2,1.8,1.2s,1.b,2.q,1.c,3.w,1b.0,f.2n,z.1,4.0,6.5,6.2,1.0,1.2,1.0,15.4,5.1,a.0,1.0,n.e,1.0,1.0,5.2,3.0,1.0,2.0,3.3,9.4,3.1,3.0,1.0,1.0,1.5,7.1,1.0,7.3,1.1,6.0,1.7,4.1,6.7,4.0,2.b,5.3,e.1,2.0,9.2,1.0,1.2,2.1,1.1,g.1,10.3,4.0,8.0,6.1,k.1w,q.0,5.j,1.d,u.5,42.1,3u.73,31.2,5i.0,x.2,3e.2,4.0,9.5,9.1,b4.1,q.0,k.0,1z.0,4.1,gp.v,9s.3h,noi.2n,2o.5m,5.1,1.0,1.4,o.d,8e.0,e9.1n,gb8.0,v.f,5r.0,2j.0,1.0,4e.1,1he.5,1.15,1.8,16it.u,4m5.3',
  s3: 'd.0,i.3,1.0,1.o,r.4,r.3,x.0,c.0,15.0,v.0,ck.0,18j.3j,3tc.12,1.1,lt.2,2.0,2.1,3.1,2.1,8.0,42.0,1i.0,81.0,qh.0,pr7.9,4m.v,mio.9',
  s4: '0.0,c.0,i.3,1.0,1.o,r.4,r.3,x.0,c.0,15.0,v.0,ck.0,18j.3j,3tc.12,1.1,lt.2,2.0,2.1,3.1,2.1,8.0,42.0,1i.0,81.0,qh.0,pr7.9,4m.v,mio.9',
};

/** The coverage set of each font file. */
export const FONT_SETS = {
  'NotoSans-Regular.ttf': 's0',
  'NotoSans-Bold.ttf': 's0',
  'NotoSans-Italic.ttf': 's1',
  'NotoSans-BoldItalic.ttf': 's1',
  'NotoSerif-Regular.ttf': 's0',
  'NotoSerif-Bold.ttf': 's0',
  'NotoSerif-Italic.ttf': 's1',
  'NotoSerif-BoldItalic.ttf': 's1',
  'NotoSansMono-Regular.ttf': 's2',
  'NotoSansMono-Bold.ttf': 's2',
  'NotoSansDevanagari-Regular.ttf': 's3',
  'NotoSansDevanagari-Bold.ttf': 's3',
  'NotoSerifDevanagari-Regular.ttf': 's4',
  'NotoSerifDevanagari-Bold.ttf': 's4',
};

const decoded = new Map();

/** The ranges of set `name` as a flat array [start0, end0, start1, end1, ...]. */
function ranges(name) {
  let r = decoded.get(name);
  if (r) return r;
  r = [];
  let at = 0;
  for (const pair of SETS[name].split(',')) {
    const [gap, len] = pair.split('.');
    const start = at + parseInt(gap, 36);
    const end = start + parseInt(len, 36);
    r.push(start, end);
    at = end + 1;
  }
  r = Int32Array.from(r);
  decoded.set(name, r);
  return r;
}

/** Whether the bundled font `file` (e.g. 'NotoSans-Regular.ttf') has a glyph for code point `cp`. */
export function fontHas(file, cp) {
  const set = FONT_SETS[file];
  if (!set) return false;
  const r = ranges(set);
  let lo = 0;
  let hi = r.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < r[2 * mid]) hi = mid - 1;
    else if (cp > r[2 * mid + 1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/** The code points of `file` encoded as in this file (used by the test that checks it). */
export function encodedSet(file) {
  return SETS[FONT_SETS[file]];
}

/** Code points (sorted) encoded as the sets above are: how tests/text.test.mjs checks and rebuilds them. */
export function encodeCodePoints(cps) {
  const out = [];
  let prev = 0;
  for (let i = 0; i < cps.length;) {
    let j = i;
    while (j + 1 < cps.length && cps[j + 1] === cps[j] + 1) j++;
    out.push((cps[i] - prev).toString(36) + '.' + (cps[j] - cps[i]).toString(36));
    prev = cps[j] + 1;
    i = j + 1;
  }
  return out.join(',');
}
