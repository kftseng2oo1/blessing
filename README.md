# 齊聲祝福

把大家的聲音收進同一份祝福：生日、母親節、父親節、重陽、新年、中秋，或一趟旅行的共同回憶。

- 建立祝福冊，大家輪流錄一句話（可倒數 3 秒一起說）
- 全螢幕依序播放，顯示說話的人和留言
- 一鍵合併成 WAV 合輯，分享到 LINE
- ☁️ 雲端共錄：分享邀請連結，親友用自己的手機錄

線上使用：https://kftseng2oo1.github.io/blessing/

## 檔案

| 檔案 | 說明 |
|---|---|
| `index.html` | 單檔 PWA 前端（IndexedDB 本機儲存） |
| `worker/blessing-worker.js` | Cloudflare Worker 後端模組，掛在 arcar 的 `/blessing` 路由 |

## 後端部署（arcar）

1. arcar 新增 KV 綁定 `BLESSING_KV`
2. 貼入 `handleBlessing`、`withBlessingCors`、`BLESSING_CORS`
3. 在 arcar `fetch` 最前面（全域 CORS 之前）加：

```js
if (url.pathname.startsWith('/blessing')) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: BLESSING_CORS });
  return withBlessingCors(await handleBlessing(request, env, url.pathname.slice(9)));
}
```

前端預設呼叫 `https://arcar.kftseng2oo1.workers.dev/blessing`（`index.html` 內的 `API_BASE`）。
