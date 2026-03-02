# Claude Code 项目指引

## 首要步骤

**在做任何事之前，先读 `.cursorrules` 文件**。该文件包含项目的完整架构、所有源文件说明、API 端点、CSS 选择器、代码规范和开发注意事项。每次会话开始时都必须先阅读它。

## OUTSIDE BASH 规则（必须遵守）

当你要执行的 bash/shell 命令会**访问项目外部的文件系统路径**时，必须在执行命令之前输出以下标记：

```
OUTSIDE BASH
```

### 什么算"访问外部文件"

- 读取、写入、列出项目目录（`C:\p\cursor_auto`）之外的文件或目录
- 例如：读取 `C:\Program Files\Cursor\...`、`%LOCALAPPDATA%\Programs\...`、`%USERPROFILE%\...` 等路径
- 例如：`Get-ChildItem C:\Users\...`、`cat /etc/...`、`ls ~/...`

### 什么不算"访问外部文件"

- 访问网络 URL（`curl https://...`、`fetch http://...`）— 不需要标记
- 访问项目内部的文件（`src/`、`public/`、`dist/`、`node_modules/` 等）— 不需要标记
- 纯计算命令（`node -e "..."`、`npm run ...`）— 不需要标记
- 查看进程/端口等系统信息（`Get-Process`、`netstat`）— 不需要标记

### 示例

正确做法：
```
OUTSIDE BASH
ls "C:\Program Files\Cursor\resources\app"
```

```
OUTSIDE BASH
Get-Content "$env:LOCALAPPDATA\Programs\cursor\resources\app\package.json"
```

不需要标记的情况：
```
npm run server
```

```
curl http://127.0.0.1:9222/json/version
```

```
node src/doctor.js
```
