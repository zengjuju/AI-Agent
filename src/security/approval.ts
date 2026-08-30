export interface ApprovalPrompt {
  approve(toolName: string, args: Record<string, unknown>): Promise<boolean>;
}

export class AutoApprovePrompt implements ApprovalPrompt {
  async approve(): Promise<boolean> {
    return true;
  }
}

export class DenyApprovalPrompt implements ApprovalPrompt {
  async approve(): Promise<boolean> {
    return false;
  }
}

export class InteractiveApprovalPrompt implements ApprovalPrompt {
  constructor(private readonly ask: (question: string) => Promise<string>) {}

  async approve(toolName: string, args: Record<string, unknown>): Promise<boolean> {
    const pretty = JSON.stringify(args);
    const answer = (await this.ask(`[审批] 允许执行工具 "${toolName}"（${pretty}）？(y/n，回车默认拒绝) `))
      .trim()
      .toLowerCase();
    return answer === 'y' || answer === 'yes' || answer === 'a';
  }
}
