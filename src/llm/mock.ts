import { ChatMessage, ChatProvider, ChatRequest, ChatResponse, ToolCall } from './types.js';

export type MockStep = (messages: ChatMessage[]) => ChatResponse;

export class MockProvider implements ChatProvider {
  readonly name = 'mock';
  private readonly steps: MockStep[];

  constructor(
    private readonly options: {
      model: string;
      steps?: MockStep[];
    },
  ) {
    this.steps = options.steps ? [...options.steps] : [];
  }

  get model(): string {
    return this.options.model;
  }

  get remainingSteps(): number {
    return this.steps.length;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const step = this.steps.shift();
    if (!step) {
      throw new Error('MockProvider script exhausted');
    }
    return step(request.messages);
  }
}

export class RuleMockProvider implements ChatProvider {
  readonly name = 'mock';

  constructor(private readonly modelName: string) {}

  get model(): string {
    return this.modelName;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const messages = request.messages;
    const last = messages[messages.length - 1];
    if (!last) {
      return textResponse('（Mock 模式）没有收到消息。');
    }

    if (last.role === 'tool') {
      return this.respondToToolResult(messages);
    }

    const text = last.content ?? '';
    if (/列出|查看|当前目录|有哪些文件|list/i.test(text)) {
      return toolCallResponse('list_dir', { path: '.' });
    }
    if (/创建|写入|写文件|新建|hello/i.test(text)) {
      return toolCallResponse('write_file', { path: 'hello.txt', content: 'Hello Forge' });
    }
    return textResponse(`（Mock 模式）已收到任务：${text}`);
  }

  private respondToToolResult(messages: ChatMessage[]): ChatResponse {
    const last = messages[messages.length - 1];
    const content = last?.content ?? '';
    const originalUser =
      [...messages]
        .reverse()
        .find((message) => message.role === 'user' && message.content)?.content ?? '';
    const wantsHelloFile = /创建|写入|写文件|新建|hello/i.test(originalUser);

    if (/wrote|写入|已写入|created/i.test(content)) {
      return toolCallResponse('list_dir', { path: '.' });
    }
    if (wantsHelloFile && !/hello\.txt/i.test(content)) {
      return toolCallResponse('write_file', { path: 'hello.txt', content: 'Hello Forge' });
    }
    if (/ERROR|错误|permission denied/i.test(content)) {
      return textResponse('（Mock 模式）工具执行失败，请检查权限或参数后重试。');
    }
    return textResponse(`（Mock 模式）已获取工具结果：${content.slice(0, 300)}`);
  }
}

export function toolCallResponse(name: string, args: Record<string, unknown>, id?: string): ChatResponse {
  const call: ToolCall = {
    id: id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
  return {
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [call],
    },
    finishReason: 'tool_calls',
  };
}

export function textResponse(content: string): ChatResponse {
  return {
    message: { role: 'assistant', content },
    finishReason: 'stop',
  };
}

export function demoSteps(): MockStep[] {
  return [
    () => toolCallResponse('list_dir', { path: '.' }),
    () => toolCallResponse('write_file', { path: 'hello.txt', content: 'Hello Forge' }),
    () => toolCallResponse('list_dir', { path: '.' }),
    () =>
      textResponse(
        '演示完成：已查看目录、创建 hello.txt（内容为 Hello Forge），并再次列出目录确认文件存在。',
      ),
  ];
}
