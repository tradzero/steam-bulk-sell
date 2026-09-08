# 安全边界

## 权限

仅申请 `activeTab`、`scripting`、`storage`。没有永久 host 权限、`cookies`、`webRequest`、`tabs`、交易接口权限、远程更新地址、外部消息入口、网页可访问资源或常驻 content scripts。

`activeTab` 是 Chrome 对用户主动点击的临时授权。代码在此基础上额外检查精确 HTTPS 来源 `steamcommunity.com`、页面路径、账户和库存上下文。临时授权并不是只读权限，也不意味着其他功能从能力上绝对不可实现；这里的约束需要同时审计实际发布代码。

## 数据与网络

扩展 UI 的 CSP 为 `connect-src 'none'`，只执行包内脚本，不载入远程 JavaScript、不使用 eval。物品图片只允许以下 Steam CDN：

- `https://community.fastly.steamstatic.com`
- `https://community.akamai.steamstatic.com`
- `https://community.cloudflare.steamstatic.com`

插件主动发起的 API 网络请求只有两个固定来源和路径，由绑定的 Steam 标签页在 ISOLATED 环境中发送：

1. `GET https://steamcommunity.com/inventory/{当前账户}/{已知游戏}/{已知上下文}`，固定分页大小 2000；只有分页游标可变化。
2. `GET https://steamcommunity.com/market/priceoverview/`，参数为已知游戏、当前钱包货币和已加载物品名称。

两者均使用 `credentials: same-origin`、15 秒超时、禁止重定向和不使用缓存。浏览器可能自动附带现有 Steam 登录凭据；扩展代码不会读取或导出它们。

用户选择交接时，插件导航到 `https://steamcommunity.com/market/multisell`，URL 只含 appid、contextid、items[]。价格和数量留在扩展会话中，再按已核对的清单填入页面。

市场物品链接和物品图片也会产生正常的浏览器 GET。Steam 页面自身的请求属于 Steam 原生页面，并不受扩展 UI 的 `connect-src` 限制。本插件没有宣称阻断 Steam 或其他已安装插件的网络访问。

## 身份与消息边界

- 核对页面登录账户与库存所有者相同，不读取认证令牌、Cookie 字符串、API Key、验证器密钥、钱包余额。
- 扩展页面通过 Chrome 内部消息与 service worker 通信。验证扩展 ID、UI 路径、会话 UUID，以及 Chrome 提供的 URL fragment 和 UI 标签页 ID；若浏览器省略 fragment，仍要求其他会话身份校验通过。
- 不使用网页 `postMessage` 接收操作指令；没有任意 URL、任意脚本、任意 HTTP 方法的代理入口。
- 提交交接时只接收已生成核对单 ID，不接受新的数量或价格覆盖。
- 原生交接核对账号、游戏、上下文、名称集合、完整库存、commodity 标记、可用数量和费用。
- 一旦原生表单填充开始，校验失败会把已识别的目标数量归零，避免留下部分可提交的清单。
- 仅写入原生数量和价格字段，调用其费用/合计函数。不调用创建上架函数、不模拟点击提交、不修改协议复选框。

## 本地存储

仅用 `chrome.storage.session` 保存必要账户标识、上下文、同质物品摘要、去重用资产 ID、参考价、草稿和核对单。没有同步或外传。该存储只对扩展可信上下文开放。

两个小时不活动后，访问时拒绝继续；过期存储在下次启动清理。关闭浏览器、关闭来源标签页或点击“清除本次草稿”也会使其失效/删除。原生页面中已经填入的字段不会因删除工作台草稿自动撤回。

## 供应链与更新

生产扩展无第三方 npm 运行时依赖，开发依赖在 `package-lock.json` 锁定。用 `npm ci --ignore-scripts` 构建。发布包含产物哈希；包外另提供 ZIP 哈希。

本地加载版没有远程自动更新配置。升级时应先审查源码差异、权限和网络目标，重新构建后再在 Chrome 扩展管理页点“重新加载”。哈希用于发现产物不一致，不等同于第三方审计或安全认证。

## 残余风险

Steam 的库存、行情和 multisell 属于网页实现，不是面向本扩展承诺稳定的交易 API。页面变化、费用差异、限流、登录失效和库存变动可能导致停止工作。

MAIN 环境与 Steam 页面共享 JavaScript；这里依赖 Steam 页面的账户信息、费用函数和原生 UI。Steam 页面被篡改、浏览器被攻陷，或其他具有 Steam 权限的插件恶意修改页面时，本扩展不能保证整个平台安全。扩展自己的权限减少和 CSP 不会撤销其他插件已有的权限。

最终手动核对和 Steam 手机确认是操作流程的一部分，但手机确认是否出现取决于 Steam，不应把它视为每笔出售必然存在的兜底。

## 来源

- Chrome activeTab：https://developer.chrome.com/docs/extensions/develop/concepts/activeTab
- Chrome scripting：https://developer.chrome.com/docs/extensions/reference/api/scripting
- Chrome storage：https://developer.chrome.com/docs/extensions/reference/api/storage
- Steam 官方库存脚本：`https://community.fastly.steamstatic.com/public/javascript/economy_v2.js`
- Steam 官方费用脚本：`https://community.fastly.steamstatic.com/public/javascript/economy_common.js`
- Steam 官方原生批量脚本：`https://community.fastly.steamstatic.com/public/javascript/market_multisell.js`

同类插件仅参考公开 UI/UX，没有安装或引用它们的实现代码。
