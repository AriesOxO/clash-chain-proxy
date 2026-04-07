/**
 * Clash Verge / mihomo 链式代理脚本
 *
 * 架构: 应用 → mihomo → 机场节点(中转) → 静态IP(出口) → 目标网站
 *
 * 核心思路:
 * 1. 通过 dialer-proxy 让静态 IP 节点的底层流量走机场节点
 * 2. 形成两层代理链, 最终所有需要代理的流量都从同一个静态 IP 出口
 * 3. 适用场景: 需要固定出口 IP (账号风控、API 白名单、AI 服务地理限制等)
 *
 * 使用前请替换 staticProxyConfig 中的 YOUR_* 占位符
 */
function main(config) {
  try {
    // ================= 1. 核心配置区域 =================
    // 替换为你自己的静态 IP 服务器信息
    const staticProxyConfig = {
      name: "🔒 静态IP (出口)",
      type: "socks5", // 也支持 ss / vmess / trojan 等
      server: "YOUR_STATIC_IP_OR_DOMAIN",
      port: 443,
      username: "YOUR_USERNAME",
      password: "YOUR_PASSWORD",
      udp: true,
      "udp-over-tcp": true, // 链式代理下 UDP 走 TCP 隧道更稳定
      "skip-cert-verify": true,
    };

    const groupAirportName = "✈️ 机场中转池";
    const groupFinalName = "🚀 最终出口选择";

    // ================= 2. 规则优化 (使用 GEOSITE 替代冗长列表) =================
    const optimizedDirectRules = [
      // --- 强制直连与局域网 ---
      "GEOSITE,private,DIRECT",
      "GEOSITE,category-ads-all,REJECT", // 顺便拦截广告

      // --- IP 段 (核心网络) ---
      "IP-CIDR,127.0.0.0/8,DIRECT,no-resolve",
      "IP-CIDR,172.16.0.0/12,DIRECT,no-resolve",
      "IP-CIDR,192.168.0.0/16,DIRECT,no-resolve",
      "IP-CIDR,10.0.0.0/8,DIRECT,no-resolve",
      "IP-CIDR,100.64.0.0/10,DIRECT,no-resolve",
      "IP-CIDR,224.0.0.0/4,DIRECT,no-resolve",

      // --- 进程匹配 (P2P 下载工具直连) ---
      "PROCESS-NAME,Thunder,DIRECT",
      "PROCESS-NAME,Transmission,DIRECT",
      "PROCESS-NAME,uTorrent,DIRECT",
      "PROCESS-NAME,qBittorrent,DIRECT",
      "PROCESS-NAME,aria2c,DIRECT",

      // --- 强制走代理的精确域名 (必须在 GEOSITE,cn 之前) ---
      // 用 DOMAIN 精确匹配, 避免影响母域名下其他子域名
      // 这里以 Microsoft Copilot 为例:
      //   微软在中国有运营, bing.com / live.com / microsoftonline.com 都在 GEOSITE,cn 中
      //   会被一刀切直连, 但 Copilot 用地理 IP 检测, 必须从境外 IP 访问
      `DOMAIN,copilot.microsoft.com,${groupFinalName}`,
      `DOMAIN-SUFFIX,copilot.cloud.microsoft,${groupFinalName}`,
      `DOMAIN,sydney.bing.com,${groupFinalName}`, // Bing 聊天 WebSocket 后端
      `DOMAIN,edgeservices.bing.com,${groupFinalName}`,
      `DOMAIN,login.microsoftonline.com,${groupFinalName}`, // 账号登录(Copilot 需登录)
      `DOMAIN,login.live.com,${groupFinalName}`,
      // 你可以按相同模式添加其他需要代理的国内可解析域名

      // --- 核心优化: 国内域名统配 ---
      "GEOSITE,cn,DIRECT",

      // --- 游戏平台国内 CDN ---
      "GEOSITE,steam@cn,DIRECT",
      "GEOSITE,category-games@cn,DIRECT",

      // --- 兜底国内 IP ---
      "GEOIP,CN,DIRECT",
    ];

    // ================= 3. 提取与构建节点 =================
    // 只提取出网协议节点, 排除 DIRECT/REJECT 等
    const validNodeTypes = [
      "ss",
      "vmess",
      "vless",
      "trojan",
      "hysteria",
      "hysteria2",
      "tuic",
      "ssr",
      "snell",
      "socks5",
      "http",
    ];

    if (!config.proxies) config.proxies = [];

    // 过滤无效节点 (server 为 0.0.0.0 / 127.0.0.1 等"信息节点"会破坏链路)
    const airportProxies = config.proxies
      .filter(
        (p) =>
          p &&
          p.type &&
          p.server &&
          p.server !== "0.0.0.0" &&
          p.server !== "127.0.0.1" &&
          validNodeTypes.includes(p.type) &&
          p.name !== staticProxyConfig.name
      )
      .map((p) => p.name);

    // 防错: 没有任何有效节点时给一个 DIRECT 占位
    if (airportProxies.length === 0) airportProxies.push("DIRECT");

    // 关键: 让静态 IP 节点的底层连接走机场池
    staticProxyConfig["dialer-proxy"] = groupAirportName;
    config.proxies.unshift(staticProxyConfig);

    // ================= 4. 分组策略 =================
    config["proxy-groups"] = [
      {
        name: groupFinalName,
        type: "select",
        proxies: [
          staticProxyConfig.name, // 默认: 走静态 IP 链式代理
          groupAirportName, // 备用: 不走静态 IP, 直接走机场
        ],
      },
      {
        // 用 select 而非 url-test, 防止自动切换导致已建立链路重置
        // 如需自动选优可改回 url-test (注意会引起静态 IP 隧道闪断)
        name: groupAirportName,
        type: "select",
        proxies: airportProxies,
      },
    ];

    // ================= 5. 规则合并 =================
    const finalRules = [...optimizedDirectRules];

    if (config.rules && config.rules.length > 0) {
      config.rules.forEach((rule) => {
        const parts = rule.split(",");
        if (parts.length < 2) return;

        const ruleType = parts[0].trim().toUpperCase();
        const isNoResolve =
          parts[parts.length - 1].trim().toLowerCase() === "no-resolve";
        const policyIndex = isNoResolve ? parts.length - 2 : parts.length - 1;
        const originalPolicy = parts[policyIndex].trim();

        // 保留 DIRECT 和 REJECT, 其他全部重定向到最终出口
        if (
          originalPolicy === "DIRECT" ||
          originalPolicy === "REJECT" ||
          originalPolicy.startsWith("REJECT")
        ) {
          finalRules.push(rule);
        } else if (ruleType !== "MATCH") {
          parts[policyIndex] = groupFinalName;
          finalRules.push(parts.join(","));
        }
      });
    }

    // 兜底: 最后一条 MATCH 走最终出口
    finalRules.push(`MATCH,${groupFinalName}`);
    config.rules = finalRules;

    return config;
  } catch (e) {
    // 防御: 脚本异常时返回原始 config, 避免整个配置加载失败
    console.log(
      "[Script.js] 脚本执行异常, 已返回原始配置: " +
        (e && e.message ? e.message : String(e))
    );
    return config;
  }
}
