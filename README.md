# Cube Toolkit

Cube Toolkit 是一套离线优先的三阶魔方练习工具，包含 **CubeTimer 魔方计时器** 和 **CFOP 公式学习器**。它不需要构建工具，本地打开或用一个轻量 Node 服务器即可运行。

## 功能

- **魔方计时器**
  - 空格键/触摸计时，支持 15 秒观察、+2 与 DNF 判罚、误触保护
  - Bo5、Bo10、自由练习；三阶、二阶、四阶、单手三阶
  - 最快/最慢高亮、全部平均、去极值平均、历史记录和 CSV 导出
  - PWA 添加到主屏幕，本机数据备份与恢复
  - 可选 Supabase 账号登录，多设备同步，行级安全策略保护个人成绩
- **CFOP 公式学习器**
  - PLL 21、OLL 57、F2L 41、桥式 45，共 164 个情况
  - 每个公式配有由公式逆推生成的真实 case 图
  - 分组浏览、搜索、未掌握筛选、y 旋转视角
  - 公式逐帧演示、单步播放、练习模式和本地掌握进度
  - 完全离线可用，双击 HTML 即可打开
- **校验脚本**
  - 4 个零依赖 Node.js 脚本，覆盖公式数据、清空/代理回退、静态服务器安全和计时器交互

## 快速开始

需要 Node.js 18 或更高版本。

```powershell
cd timer
node server.js 8902
```

浏览器打开 <http://127.0.0.1:8902/index.html>。Windows 用户也可以双击 `timer/启动计时器.bat`。同一 Wi-Fi 下，用服务器输出中的局域网地址可在手机访问。

CFOP 学习器无需服务器：

```text
cfop/CFOP公式学习.html
```

## Supabase 配置

不配置 Supabase 也可以完整使用计时器，成绩会保存在本机浏览器中。若需要多设备同步：

1. 在 Supabase 创建项目，并在 SQL Editor 执行 `database/schema.sql`。
2. 如需修复/更新行级安全策略，执行 `database/rls-fix.sql`。
3. 将项目 URL 和 Publishable key 填入 `timer/supabase-config.js`，或在页面“设置”标签中填写。
4. 注册/登录账号后，本机已有成绩会自动上传。

`server.js` 会从 `supabase-config.js` 读取项目地址，为手机等设备提供 `/sb/*` 代理。也可以用环境变量 `SUPABASE_HOST` 覆盖。

> 安全提示：只使用 Publishable key，不要提交 service role key。仓库中的 `supabase-config.js` 是空模板。

## 目录结构

```text
cube-toolkit/
├── timer/        # CubeTimer 页面、本地/局域网服务器、PWA 资源
├── cfop/         # CFOP 公式学习器（离线 HTML）
├── database/     # Supabase 表结构与 RLS 修复脚本
├── validation/   # Node.js 校验脚本
└── docs/         # 使用说明与 2026-10-12 修复记录
```

## 校验

```powershell
node validation/校验_CFOP公式.js cfop/CFOP公式学习.html
node validation/校验_清空成绩与代理回退.js timer/store.js
node validation/校验_静态文件服务.js timer/server.js 18923
node validation/校验_计时器交互.js timer
```

已完成的校验结果记录在 `docs/fixes-2026-10-12.txt`。

## 说明

本仓库发布本机与局域网版本，不包含 Cloudflare Pages 部署包。所有界面文案以中文为主，适合速拧练习和 CFOP/桥式学习。

## License

MIT License. See [LICENSE](LICENSE).
