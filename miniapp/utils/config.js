/**
 * 模型接入配置（默认关闭）
 *
 * 启用步骤：
 * 1. 把 server.mjs 的 /api/report 部署到 HTTPS 服务（函数计算 / 云函数），密钥只留在服务端
 * 2. 在支付宝开放平台把该域名加入 request 合法域名；开发阶段可在 IDE 勾选「忽略域名校验」
 * 3. 填入 baseUrl（不含结尾斜杠），把 enabled 改为 true
 *
 * 契约与网页版一致：POST {baseUrl}/api/report，概念内容由服务端按 id 读取。
 * 未启用或请求失败时，页面会自动回退到 utils/engine.js 的本地规则。
 */
module.exports = {
  ai: {
    enabled: true,
    baseUrl: 'https://37ku59d503hb0iixfmp.traesite.cn',
    model: 'glm-4-flash',
    timeout: 30000
  }
};
