# 足球欧赔变化采集

React + Vite 实现的纯前端足球欧赔变化采集工具，页面采用足球数据看板风格。

## 功能

- 按北京时间、主队、客队尝试自动匹配比赛欧赔页
- 支持直接输入比赛 ID 或欧赔页 URL
- 支持粘贴赛程页 / 欧赔页源码解析
- 提取欧赔胜平负、返还率、胜平负凯利指数变化
- 公司汇总、采集日志、CSV / JSON 导出
- 内置样例数据，可离线验证页面流程

## 运行

```bash
npm install
npm run dev
```

默认开发地址：

```text
http://127.0.0.1:5175/
```

构建生产包：

```bash
npm run build
```

## 纯前端限制

浏览器不能绕过目标站点的 CORS、Referer、Cookie 或反爬限制。如果目标站点不允许跨域读取，直连 `fetch` 会失败。此时可以：

- 开发环境默认使用 Vite 本地代理 `/proxy500/...`
- Netlify 部署默认使用 `netlify/functions/proxy500.js` 只读代理，并通过 `netlify.toml` 把 `/proxy500/*` 转发到函数
- 配置自己的只读代理前缀
- 直接输入比赛 ID / 欧赔页 URL
- 把赛程页或欧赔页源码粘贴到页面中解析

生产部署到 Netlify 时，默认代理前缀保持为空即可，页面会自动把 500彩票网请求转成 `/proxy500/...`。

## 目录

- `src/App.jsx`：React 页面和交互逻辑
- `src/lib/oddsParser.js`：抓取 URL、赛程匹配、赔率解析、格式化工具
- `src/data/sampleData.js`：离线样例数据
- `src/styles.css`：足球风格 UI
