# verta-magpie-auth

这是一个 [magpie](https://usemagpie.ai) 插件，用来把 Vetra 的模型接入本机编程工具。

支持两种登录方式：

- **api-key登录**：使用个人 api-key 连接模型 API，自动获取该 key 可用的模型，原生转发对话、流式响应和工具调用。
- **网页登录**：使用网页版会话，通过 LangGraph 进行对话和本地工具调用，并自动尝试续期登录状态。续期需要密码或验证码时会保留原窗口，完成后可继续；失败后的重试间隔会保留到插件重启之后。

在 magpie 中重新登录 Vetra，选择 **api-key登录**，填入在用户模型接口页面生成的 api-key。完整 api-key 只在生成或重置时展示一次；重置会使旧 api-key 失效。

API key 模式使用标准 OpenAI Chat Completions，其他客户端协议由 magpie 转换。模型列表以网关返回结果为准，模型 ID 和工具调用参数保持原样；插件会适配网关的 GPT-5 输出上限和推理参数。API key 无效时会提示重新登录，额度页仅检查 key 是否有效。

API key 模式下，GPT-5.4、GPT-5.5 和 GPT-5.6 的上下文窗口为 **1,050,000 tokens**，GPT-5 为 **400,000 tokens**；最大输出均为 128,000 tokens。网关当前为 GPT-5.4/5.5/5.6 提供 `none`、`low`、`medium`、`high`、`xhigh`，会拒绝 `max`。这与 [OpenAI 官方 GPT-5.6 规格](https://developers.openai.com/api/docs/models/gpt-5.6-sol)的推理档位有区别，以实际部署的支持范围为准。

GPT-5.6 在当前网关的 Chat Completions 接口中，使用 function tools 时要求 `reasoning_effort: "none"`。需要推理与工具调用同时使用时，可选择 GPT-5.4。

使用 `magpie plugin login vetra` 可以打开登录选择。在项目目录执行 `magpie plugin add .` 可加载本地版本。插件选项 `apiBase` 或环境变量 `VETRA_API_BASE` 可指定模型 API 的 Base URL（含 `/v1`）；`base` / `VETRA_BASE` 用于网页版地址。

**本项目仅供学习使用。**
