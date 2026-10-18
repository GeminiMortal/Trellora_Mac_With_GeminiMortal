/**
 * Electron net.request-based image fetching with manual redirect exposure for export validation.
 * 基于 Electron net.request 的图片抓取，手动暴露重定向以供导出校验。
 */
import { net } from 'electron';

/**
 * Electron 31 cancels fetch manual redirects; expose net.request redirects for validation.
 * Electron 31 会取消 fetch 的手动重定向；此处用 net.request 暴露重定向信息供校验。终端还是启动失败
 *
 * @param url - Image URL to request / 要请求的图片地址
 * @param options - Fetch-style options; only the abort signal is used / Fetch 风格选项；仅使用其中的中止信号
 * @returns A fetch-like Response, or a stub response carrying the redirect location / 类似 fetch 的 Response，或携带重定向地址的桩响应
 */
export function requestExportImage(url: string, options: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, method: 'GET', redirect: 'manual', credentials: 'omit', useSessionCookies: false });
    let delivered = false, closed = false;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    // fail() settles both the promise and any live body stream exactly once.
    // fail() 对 Promise 与仍在传输的 body 流各结算一次，避免重复回调。
    const fail = (error: Error) => {
      options.signal?.removeEventListener('abort', abort);
      if (!delivered) reject(error);
      if (streamController && !closed) { closed = true; streamController.error(error); }
    };
    const abort = () => { fail(new Error('网络图片请求已取消。')); request.abort(); };
    request.on('error', fail);
    request.once('abort', () => fail(new Error('网络图片请求已取消。')));
    // Manual redirects resolve immediately with a location header so the caller can re-validate the next URL.
    // 手动重定向立即以 location 头 resolve，让调用方重新校验下一个地址。
    request.once('redirect', (status, _method, redirectUrl) => {
      delivered = true;
      options.signal?.removeEventListener('abort', abort);
      resolve(new Response(null, { status, headers: { location: redirectUrl } }));
      request.abort();
    });
    request.once('response', response => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(response.headers)) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          response.on('data', (bytes: Buffer) => { if (!closed) controller.enqueue(new Uint8Array(bytes)); });
          response.once('end', () => { options.signal?.removeEventListener('abort', abort); if (!closed) { closed = true; controller.close(); } });
          response.once('error', fail);
          response.once('aborted', () => fail(new Error('网络图片响应被中断。')));
        },
        cancel() { options.signal?.removeEventListener('abort', abort); closed = true; request.abort(); },
      });
      delivered = true;
      // Statuses without a body must not surface an empty stream to the caller.
      // 无响应体的状态码不应把空流传给调用方。
      if ([204, 205, 304].includes(response.statusCode)) { void body.cancel(); resolve(new Response(null, { status: response.statusCode, headers })); }
      else resolve(new Response(body, { status: response.statusCode, headers }));
    });
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort(); else request.end();
  });
}
