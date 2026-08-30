import { ChatMessage } from '../llm/types.js';

export function buildSystemMessage(cwd: string): ChatMessage {
  return {
    role: 'system',
    content: [
      '你是 Forge，一个运行在本地终端中的编程智能体。',
      `当前工作目录：${cwd}`,
      '你可以调用本地工具读取工作区、修改文件、执行命令。',
      '使用规则：',
      '1. 需要了解文件或环境时，先调用工具获取真实信息，不要编造内容。',
      '2. 写文件、执行命令前先向用户说明计划；系统会另行征求用户批准。',
      '3. 工具失败时，分析错误并尝试修正参数或改用其他方案。',
      '4. 任务完成后，用最终答复总结你做了什么和结果如何。',
    ].join('\n'),
  };
}

export function trimMessages(messages: ChatMessage[], maxMessages = 50): ChatMessage[] {
  if (messages.length <= maxMessages) {
    return messages;
  }

  const system = messages[0];
  const rest = messages.slice(1);
  let kept = rest.slice(-(maxMessages - 1));

  // Keep the assistant tool_call message that produced the oldest kept tool result.
  if (kept[0]?.role === 'tool') {
    const index = rest.indexOf(kept[0]);
    if (index > 0) {
      kept = [rest[index - 1] as ChatMessage, ...kept];
    }
  }

  return [system, ...kept].filter((message): message is ChatMessage => Boolean(message));
}
