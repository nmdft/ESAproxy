/**
 * 阿里云 ESA 边缘函数 - 反向代理
 * 
 * 功能：
 * 1. 接收前端传来的目标 URL
 * 2. 通过边缘节点请求目标网站
 * 3. 返回目标网站的内容，并处理相对路径
 */

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  const url = new URL(request.url)
  
  // 如果是根路径，返回主页
  if (url.pathname === '/' || url.pathname === '') {
    return fetch(request)
  }
  
  // 处理代理请求
  if (url.pathname.startsWith('/proxy')) {
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
      
      // 发起代理请求
      const response = await fetch(proxyRequest)
      
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
        
        return new Response(modifiedHtml, {
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
      return new Response(`代理请求失败: ${error.message}`, { 
        status: 500,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      })
    }
  }
  
  // 其他请求正常处理
  return fetch(request)
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
  
  // 处理 <base> 标签
  modified = modified.replace(/<base\s+href=["']([^"']+)["']/gi, (match, href) => {
    return `<base href="${proxyOrigin}/proxy?url=${encodeURIComponent(new URL(href, baseUrl).href)}"`
  })
  
  // 处理 src 属性（img, script, iframe 等）
  modified = modified.replace(/(<(?:img|script|iframe|embed|audio|video|source)\s+[^>]*src=["'])([^"']+)(["'])/gi, 
    (match, before, src, after) => {
      if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) {
        return `${before}${proxyOrigin}/proxy?url=${encodeURIComponent(src)}${after}`
      } else {
        const absoluteUrl = new URL(src, baseUrl).href
        return `${before}${proxyOrigin}/proxy?url=${encodeURIComponent(absoluteUrl)}${after}`
      }
    })
  
  // 处理 href 属性（a, link 等）
  modified = modified.replace(/(<(?:a|link)\s+[^>]*href=["'])([^"']+)(["'])/gi, 
    (match, before, href, after) => {
      if (href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) {
        return match
      }
      if (href.startsWith('http://') || href.startsWith('https://')) {
        return `${before}${proxyOrigin}/proxy?url=${encodeURIComponent(href)}${after}`
      } else {
        const absoluteUrl = new URL(href, baseUrl).href
        return `${before}${proxyOrigin}/proxy?url=${encodeURIComponent(absoluteUrl)}${after}`
      }
    })
  
  // 处理 CSS 中的 url()
  modified = modified.replace(/url\(["']?([^"')]+)["']?\)/gi, (match, url) => {
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:')) {
      return `url("${proxyOrigin}/proxy?url=${encodeURIComponent(url)}")`
    } else {
      const absoluteUrl = new URL(url, baseUrl).href
      return `url("${proxyOrigin}/proxy?url=${encodeURIComponent(absoluteUrl)}")`
    }
  })
  
  return modified
}
