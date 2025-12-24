/**
 * 阿里云 ESA 边缘函数 - 反向代理
 * 
 * 功能：
 * 1. 接收前端传来的目标 URL
 * 2. 通过边缘节点请求目标网站
 * 3. 返回目标网站的内容，并处理相对路径
 */

// ESA Pages 需要导出默认对象，包含 fetch 或 bypass 函数
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // 只处理 /proxy 路径的请求，其他请求继续传递给源站
    if (!url.pathname.startsWith('/proxy')) {
      // 使用 env.ASSETS.fetch 获取静态资源
      return env.ASSETS.fetch(request);
    }
    
    return handleProxyRequest(request, url);
  }
};

async function handleProxyRequest(request, url) {
  const targetUrl = url.searchParams.get('url')
    
    // 验证目标 URL
    if (!targetUrl) {
      return new Response('缺少目标 URL 参数', { 
        status: 400,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      })
    }
      
    try {
      // 验证 URL 格式
      const target = new URL(targetUrl)
      
      // 安全检查：只允许 http 和 https 协议
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        return new Response('不支持的协议类型', { 
          status: 400,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        })
      }
      
      // 构建新的请求
      const proxyRequest = new Request(target.href, {
        method: request.method,
        headers: createProxyHeaders(request.headers, target.host),
        body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
      })
      
      // 发起代理请求（带超时控制）
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30秒超时
      
      let response;
      try {
        response = await fetch(proxyRequest, { signal: controller.signal });
        clearTimeout(timeoutId);
      } catch (fetchError) {
        clearTimeout(timeoutId);
        if (fetchError.name === 'AbortError') {
          return new Response('请求超时：目标网站响应时间过长，可能该网站在当前网络环境下无法访问', {
            status: 504,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        }
        throw fetchError;
      }
      
      // 创建新的响应对象
      const newResponse = new Response(response.body, response)
      
      // 修改响应头
      const headers = new Headers(newResponse.headers)
      
      // 允许跨域
      headers.set('Access-Control-Allow-Origin', '*')
      headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
      headers.set('Access-Control-Allow-Headers', '*')
      
      // 删除可能导致问题的安全头
      headers.delete('Content-Security-Policy')
      headers.delete('X-Frame-Options')
      
      // 处理 HTML 内容，替换相对路径
      const contentType = headers.get('Content-Type') || ''
      if (contentType.includes('text/html')) {
        const html = await response.text()
        const modifiedHtml = rewriteHtml(html, targetUrl, url.origin)
        
        // 注入脚本修复，确保页面中的 fetch 等 API 正常工作
        const injectedScript = `
          <script>
            // 确保 window.fetch 可用
            if (typeof window.fetch === 'undefined') {
              console.error('Fetch API not available');
            }
            
            // 修复相对 URL 的表单提交
            document.addEventListener('DOMContentLoaded', function() {
              const forms = document.querySelectorAll('form');
              forms.forEach(form => {
                const originalAction = form.action;
                if (originalAction && !originalAction.startsWith('javascript:') && !originalAction.startsWith('#')) {
                  form.addEventListener('submit', function(e) {
                    // 让表单提交通过代理
                    const actionUrl = new URL(form.action || window.location.href);
                    form.action = '${url.origin}/proxy?url=' + encodeURIComponent(actionUrl.href);
                  });
                }
              });
            });
          </script>
        `;
        
        const finalHtml = modifiedHtml.replace('</head>', injectedScript + '</head>');
        
        return new Response(finalHtml, {
          status: newResponse.status,
          statusText: newResponse.statusText,
          headers: headers
        })
      }
      
      return new Response(newResponse.body, {
        status: newResponse.status,
        statusText: newResponse.statusText,
        headers: headers
      })
      
    } catch (error) {
    // 提供更友好的错误信息
    let errorMessage = `代理请求失败: ${error.message}`;
    let statusCode = 500;
    
    if (error.message.includes('fetch') || error.message.includes('network')) {
      errorMessage = `无法访问目标网站：${targetUrl}

可能原因：
1. 目标网站在 ESA 边缘节点的网络环境下无法访问
2. 目标网站响应超时
3. 目标网站拒绝了代理请求

提示：某些网站（如 Google）可能在国内 ESA 节点无法直接访问。`;
      statusCode = 502;
    }
    
    return new Response(errorMessage, { 
      status: statusCode,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    })
  }
}

/**
 * 创建代理请求头
 */
function createProxyHeaders(originalHeaders, targetHost) {
  const headers = new Headers()
  
  // 复制必要的请求头
  const allowedHeaders = [
    'accept',
    'accept-language',
    'accept-encoding',
    'content-type',
    'user-agent',
    'cache-control',
  ]
  
  for (const [key, value] of originalHeaders.entries()) {
    if (allowedHeaders.includes(key.toLowerCase())) {
      headers.set(key, value)
    }
  }
  
  // 设置目标主机
  headers.set('Host', targetHost)
  
  // 设置 User-Agent（如果没有）
  if (!headers.has('User-Agent')) {
    headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
  }
  
  // 添加 Accept-Language 偏好英语地区，可能影响路由
  if (!headers.has('Accept-Language')) {
    headers.set('Accept-Language', 'en-US,en;q=0.9')
  }
  
  return headers
}

/**
 * 重写 HTML 内容，替换相对路径为绝对路径
 */
function rewriteHtml(html, targetUrl, proxyOrigin) {
  const target = new URL(targetUrl)
  const baseUrl = `${target.protocol}//${target.host}`
  
  // 替换相对路径的资源链接
  let modified = html
  
  // 处理 <base> 标签 - 不使用代理，保持原始域名
  // 这样可以让页面内的相对链接正常工作
  if (!modified.includes('<base')) {
    modified = modified.replace(/<head[^>]*>/i, (match) => {
      return `${match}<base href="${baseUrl}/">`
    })
  }
  
  // 处理 src 属性（img, script, iframe 等）- 只处理绝对URL
  modified = modified.replace(/(<(?:img|script|iframe|embed|audio|video|source)\s+[^>]*src=["'])([^"']+)(["'])/gi, 
    (match, before, src, after) => {
      // 跳过已经是代理链接的
      if (src.includes('/proxy?url=')) {
        return match
      }
      // 跳过 data: 和相对路径
      if (src.startsWith('data:') || src.startsWith('//') || src.startsWith('/') || !src.includes('://')) {
        return match
      }
      // 只代理完整的 http/https URL
      if (src.startsWith('http://') || src.startsWith('https://')) {
        return `${before}${proxyOrigin}/proxy?url=${encodeURIComponent(src)}${after}`
      }
      return match
    })
  
  // 处理 href 属性（a, link）- 更保守的处理
  modified = modified.replace(/(<(?:a|link)\s+[^>]*href=["'])([^"']+)(["'])/gi, 
    (match, before, href, after) => {
      // 跳过特殊协议和锚点
      if (href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) {
        return match
      }
      // 跳过已经是代理链接的
      if (href.includes('/proxy?url=')) {
        return match
      }
      // 跳过相对路径 - 让 base 标签处理
      if (href.startsWith('/') || !href.includes('://')) {
        return match
      }
      // 只代理完整的 http/https URL
      if (href.startsWith('http://') || href.startsWith('https://')) {
        return `${before}${proxyOrigin}/proxy?url=${encodeURIComponent(href)}${after}`
      }
      return match
    })
  
  // 不处理 CSS url() - 可能会破坏样式
  
  return modified
}
