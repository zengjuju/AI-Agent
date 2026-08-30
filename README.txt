Forge —— 自研编程智能体

Git 仓库地址：https://github.com/zengjuju/AI-Agent

一、项目简介
Forge 是运行在本地终端的编程智能体，通过与大语言模型交互，能自主读写文件、执行命令，完成编程任务。核心逻辑:对话历史与上下文管理、工具定义与本地执行、模型输出解析、循环终止条件、错误处理，未使用任何 agent 框架/SDK，也不依赖服务端托管执行。

二、技术栈
TypeScript + Node.js 22；OpenAI 兼容 Chat Completions 原生 tool calling；内置 Mock Provider 支持离线演示。

三、如何运行
1. 安装依赖：npm install
2. 配置凭据：
   $env:FORGE_API_KEY='你的key'
   $env:FORGE_API_BASE='https://api.deepseek.com/v1'
   $env:FORGE_MODEL='deepseek-chat'
3. 编译：npm run build
4. 离线演示：node dist/src/cli/index.js --demo
5. 终端交互：node dist/src/cli/index.js
6. 浏览器实时交互：node dist/src/cli/index.js --serve --port 8787

四、特色功能
- Agent Loop：模型自主多轮调用本地工具，工具结果自动回填
- 多轮上下文：跨轮记忆 + 滑动窗口裁剪
- 本地工具：list_dir/read_file/write_file/run_command，沙盒越界防护与审批门控
- 错误自愈：工具失败回喂模型，指数退避重试，最大轮次与命令超时保护
- 三种形态：离线 demo、终端 REPL、HTTP 流式实时交互
- 会话持久化：每次任务落盘可复查

五、测试
npm test（20 项单元测试覆盖 Agent Loop、工具、上下文、配置、会话等）
