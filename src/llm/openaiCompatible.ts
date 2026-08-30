import { ChatMessage, ChatProvider, ChatRequest, ChatResponse } from './types.js';

interface WireMessage {
  role: string;
  content: string | null;
  tool_calls?: ChatMessage['tool_calls'];
  tool_call_id?: string;
}

function toWireMessage(message: ChatMessage): WireMessage {
  const wire: WireMessage = { role: message.role, content: message.content };
  if (message.tool_calls && message.tool_calls.length > 0) {
    wire.tool_calls = message.tool_calls;
  }
  if (message.tool_call_id) {
    wire.tool_call_id = message.tool_call_id;
  }
  return wire;
}

export class OpenAICompatibleProvider implements ChatProvider {
  readonly name = 'openai-compatible';

  constructor(
    private readonly options: {
      model: string;
      apiKey: string;
      baseUrl?: string;
      timeoutMs?: number;
      fetchImpl?: typeof fetch;
    },
  ) {}

  get model(): string {
    return this.options.model;
  }

  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const base = (this.options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    const timeoutMs = this.options.timeoutMs ?? 120_000;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`LLM request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onExternalAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const fetchFn = this.options.fetchImpl ?? fetch;
      const res = await fetchFn(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages.map(toWireMessage),
          tools: request.tools,
          temperature: request.temperature ?? 0.2,
          max_tokens: request.maxTokens ?? 4096,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        let detail = '';
        try {
          detail = await res.text();
        } catch {
          // response body may already be consumed
        }
        throw new Error(`LLM API error ${res.status}: ${detail.slice(0, 500)}`);
      }

      const data = (await res.json()) as unknown;
      return mapChatCompletion(data);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onExternalAbort);
    }
  }
}

function mapChatCompletion(data: unknown): ChatResponse {
  const anyData = data as {
    id?: string;
    choices?: Array<{
      message?: {
        content?: unknown;
        tool_calls?: Array<{
          id?: unknown;
          type?: unknown;
          function?: { name?: unknown; arguments?: unknown };
        }>;
      };
      finish_reason?: unknown;
    }>;
  };
  const choice = anyData.choices?.[0];
  if (!choice?.message) {
    throw new Error('LLM response missing choices[0].message');
  }

  const message: ChatMessage = {
    role: 'assistant',
    content: typeof choice.message.content === 'string' ? choice.message.content : null,
  };

  if (Array.isArray(choice.message.tool_calls)) {
    message.tool_calls = choice.message.tool_calls
      .filter((call) => call && (call.type === 'function' || call.function))
      .map((call) => ({
        id: typeof call.id === 'string' ? call.id : `call_${Math.random().toString(36).slice(2, 10)}`,
        type: 'function',
        function: {
          name: typeof call.function?.name === 'string' ? call.function.name : '',
          arguments:
            typeof call.function?.arguments === 'string'
              ? call.function.arguments
              : JSON.stringify(call.function?.arguments ?? {}),
        },
      }));
  }

  return {
    id: anyData.id,
    message,
    finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : undefined,
  };
}
