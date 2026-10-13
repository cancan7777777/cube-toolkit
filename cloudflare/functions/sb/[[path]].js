/**
 * Cloudflare Pages Function —— Supabase 反向代理
 *
 * 作用：把站点上的 /sb/* 请求转发到 Supabase。
 * 为什么需要它：部分网络（如国内手机流量）无法直连 *.supabase.co。
 * 有了这个函数，手机只需要能访问你的 Cloudflare 域名即可同步，
 * 由 Cloudflare 边缘节点代为访问 Supabase。
 *
 * 计时器本身会自动探测：如果 /sb/auth/v1/health 返回的是合法 JSON，
 * 就自动走这个代理；否则回退为直连。所以此文件即使不生效也不会出错。
 *
 * 注意：Pages Functions 需要通过 Wrangler 部署（`wrangler pages deploy`），
 * 纯网页拖拽上传只支持静态文件，不会带上 functions 目录。
 */

const SB_HOST = context.env.SUPABASE_HOST || '';

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  // 去掉 /sb 前缀，其余路径与查询串原样转发
  const rest = url.pathname.replace(/^\/sb/, '');
  const target = new URL('https://' + SB_HOST + (rest || '/') + url.search);

  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('origin');
  headers.delete('referer');
  headers.delete('cf-connecting-ip');
  headers.delete('cf-ipcountry');

  const init = { method: request.method, headers, redirect: 'manual' };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.arrayBuffer();
  }

  let upstream;
  try {
    upstream = await fetch(target.toString(), init);
  } catch (e) {
    return new Response(JSON.stringify({ message: 'Cloudflare 转发到 Supabase 失败: ' + e.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  const out = new Headers(upstream.headers);
  out.delete('content-encoding');       // 由 Cloudflare 重新压缩
  out.delete('content-length');
  out.set('Access-Control-Allow-Origin', '*');
  out.set('Access-Control-Allow-Headers', '*');
  out.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');

  return new Response(upstream.body, { status: upstream.status, headers: out });
}
