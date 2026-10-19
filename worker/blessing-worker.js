/* 齊聲祝福 — 雲端共錄後端（Cloudflare Worker + KV）
 *
 * 用法 A：併入 arcar（建議）
 *   1. arcar 新增 KV 綁定：BLESSING_KV
 *   2. 把本檔 handleBlessing / withBlessingCors / BLESSING_CORS 貼進 arcar（或 import）
 *   3. 在 arcar 的 fetch 最前面加：
 *        if (url.pathname.startsWith('/blessing')) {
 *          if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: BLESSING_CORS });
 *          return withBlessingCors(await handleBlessing(request, env, url.pathname.slice(9)));
 *        }
 *      （要放在 arcar 全域 CORS 之前，因為這裡需要額外允許 X-Key / X-Token / X-Name / X-Note / X-Dur 標頭）
 *
 * 用法 B：獨立部署，直接用下方 export default，同樣綁定 BLESSING_KV。
 *
 * KV 結構
 *   a:<albumId>          祝福冊 JSON（kh = 管理金鑰的 SHA-256，不存明文）
 *   p:<albumId>          封面 JPEG
 *   c:<albumId>:<clipId> 錄音；metadata = {n 名字, o 留言, d 秒數, m mime, t 時間}
 *   t:<albumId>:<clipId> 錄音者刪除 token 的 SHA-256
 *
 * API（路徑都在 /blessing 之後）
 *   POST   /a                        建立 → {id, key}
 *   GET    /a/:id                    讀取 → {album, clips}
 *   PUT    /a/:id          [X-Key]   更新標題、場合、順序
 *   DELETE /a/:id          [X-Key]   刪除整本
 *   GET    /a/:id/photo              封面
 *   PUT    /a/:id/photo    [X-Key]   上傳封面（image/jpeg 原始內容）
 *   POST   /a/:id/c                  上傳錄音（原始內容；X-Name、X-Note 用 encodeURIComponent，X-Dur 秒數）→ {id, token, t}
 *   GET    /a/:id/c/:cid             下載錄音
 *   DELETE /a/:id/c/:cid  [X-Key 或 X-Token]
 */

const OCCS = ['birthday', 'mother', 'father', 'elder', 'newyear', 'midautumn', 'travel', 'custom'];
const MAX_CLIP = 6 * 1024 * 1024;
const MAX_PHOTO = 2 * 1024 * 1024;
const MAX_CLIPS = 80;
const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';

export const BLESSING_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Key,X-Token,X-Name,X-Note,X-Dur',
  'Access-Control-Max-Age': '86400'
};

export function withBlessingCors(res) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(BLESSING_CORS)) r.headers.set(k, v);
  return r;
}

function rid(n) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  let s = '';
  for (const x of b) s += ALPHA[x % ALPHA.length];
  return s;
}
async function sha(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
const json = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const err = (m, st = 400) => json({ error: m }, st);
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const dec = (req, h) => { try { return decodeURIComponent(req.headers.get(h) || ''); } catch (e) { return ''; } };

function cleanMeta(b) {
  return {
    occ: OCCS.includes(b.occ) ? b.occ : 'custom',
    to: str(b.to, 40),
    title: str(b.title, 60) || '我們的祝福',
    date: /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : ''
  };
}

async function listClips(kv, id) {
  const out = [];
  const pre = 'c:' + id + ':';
  let cursor;
  do {
    const r = await kv.list({ prefix: pre, cursor });
    for (const k of r.keys) {
      const m = k.metadata || {};
      out.push({ id: k.name.slice(pre.length), name: m.n || '匿名', note: m.o || '', dur: m.d || 0, mime: m.m || 'audio/mp4', t: m.t || 0 });
    }
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return out;
}

async function isOwner(req, a) {
  const k = req.headers.get('X-Key');
  return !!k && (await sha(k)) === a.kh;
}

export async function handleBlessing(req, env, path) {
  const kv = env.BLESSING_KV;
  if (!kv) return err('BLESSING_KV 尚未綁定', 500);
  const m = req.method;
  const seg = path.split('/').filter(Boolean);
  try {
    if (seg[0] !== 'a') return err('not found', 404);

    // 建立祝福冊
    if (seg.length === 1) {
      if (m !== 'POST') return err('method not allowed', 405);
      const b = await req.json().catch(() => ({}));
      const id = rid(8), key = rid(24), now = Date.now();
      const a = Object.assign({ id }, cleanMeta(b), { kh: await sha(key), order: [], photoVer: 0, createdAt: now, updatedAt: now });
      await kv.put('a:' + id, JSON.stringify(a));
      return json({ id, key });
    }

    const id = seg[1];
    if (!/^[a-z0-9]{6,16}$/.test(id)) return err('bad id');
    const raw = await kv.get('a:' + id);
    if (!raw) return err('album not found', 404);
    const a = JSON.parse(raw);
    const saveA = () => kv.put('a:' + id, JSON.stringify(a));

    if (seg.length === 2) {
      if (m === 'GET') {
        const clips = await listClips(kv, id);
        const { kh, ...pub } = a;
        return json({ album: pub, clips });
      }
      if (m === 'PUT') {
        if (!(await isOwner(req, a))) return err('forbidden', 403);
        const b = await req.json().catch(() => ({}));
        Object.assign(a, cleanMeta(Object.assign({}, a, b)));
        if (Array.isArray(b.order)) a.order = b.order.map(x => str(x, 24)).slice(0, MAX_CLIPS);
        a.updatedAt = Date.now();
        await saveA();
        return json({ ok: true });
      }
      if (m === 'DELETE') {
        if (!(await isOwner(req, a))) return err('forbidden', 403);
        const clips = await listClips(kv, id);
        await Promise.all(clips.flatMap(c => [kv.delete('c:' + id + ':' + c.id), kv.delete('t:' + id + ':' + c.id)]));
        await kv.delete('p:' + id);
        await kv.delete('a:' + id);
        return json({ ok: true });
      }
      return err('method not allowed', 405);
    }

    if (seg[2] === 'photo' && seg.length === 3) {
      if (m === 'GET') {
        const p = await kv.get('p:' + id, { type: 'arrayBuffer' });
        if (!p) return err('no photo', 404);
        return new Response(p, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=300' } });
      }
      if (m === 'PUT') {
        if (!(await isOwner(req, a))) return err('forbidden', 403);
        const buf = await req.arrayBuffer();
        if (!buf.byteLength || buf.byteLength > MAX_PHOTO) return err('照片太大或是空的', 413);
        await kv.put('p:' + id, buf);
        a.photoVer = a.updatedAt = Date.now();
        await saveA();
        return json({ photoVer: a.photoVer });
      }
      return err('method not allowed', 405);
    }

    if (seg[2] === 'c') {
      // 上傳錄音
      if (seg.length === 3) {
        if (m !== 'POST') return err('method not allowed', 405);
        const buf = await req.arrayBuffer();
        if (!buf.byteLength) return err('沒有錄到聲音');
        if (buf.byteLength > MAX_CLIP) return err('錄音太大', 413);
        if ((await listClips(kv, id)).length >= MAX_CLIPS) return err('這本祝福冊已經滿了', 409);
        const now = Date.now(), cid = now.toString(36) + rid(4), token = rid(20);
        const meta = {
          n: str(dec(req, 'X-Name'), 30) || '匿名',
          o: str(dec(req, 'X-Note'), 180),
          d: Math.min(600, Math.max(0, parseFloat(req.headers.get('X-Dur')) || 0)),
          m: str((req.headers.get('Content-Type') || 'audio/mp4').split(';')[0], 40),
          t: now
        };
        while (new TextEncoder().encode(JSON.stringify(meta)).length > 1000 && meta.o) meta.o = meta.o.slice(0, -10);
        await kv.put('c:' + id + ':' + cid, buf, { metadata: meta });
        await kv.put('t:' + id + ':' + cid, await sha(token));
        return json({ id: cid, token, t: now });
      }

      const cid = seg[3];
      if (seg.length === 4 && /^[a-z0-9]{6,24}$/.test(cid)) {
        const key = 'c:' + id + ':' + cid;
        if (m === 'GET') {
          const r = await kv.getWithMetadata(key, { type: 'arrayBuffer' });
          if (!r.value) return err('clip not found', 404);
          return new Response(r.value, { headers: {
            'Content-Type': (r.metadata && r.metadata.m) || 'audio/mp4',
            'Cache-Control': 'public, max-age=31536000, immutable'
          } });
        }
        if (m === 'DELETE') {
          let ok = await isOwner(req, a);
          if (!ok) {
            const t = req.headers.get('X-Token');
            const h = t ? await kv.get('t:' + id + ':' + cid) : null;
            ok = !!(h && h === (await sha(t)));
          }
          if (!ok) return err('只能刪除自己錄的聲音', 403);
          await kv.delete(key);
          await kv.delete('t:' + id + ':' + cid);
          if (a.order.includes(cid)) { a.order = a.order.filter(x => x !== cid); await saveA(); }
          return json({ ok: true });
        }
        return err('method not allowed', 405);
      }
    }
    return err('not found', 404);
  } catch (e) {
    return err(String(e && e.message || e), 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: BLESSING_CORS });
    const path = url.pathname.replace(/^\/blessing/, '');
    return withBlessingCors(await handleBlessing(request, env, path));
  }
};
