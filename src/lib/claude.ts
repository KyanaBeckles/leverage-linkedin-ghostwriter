// Minimal Claude API client — a single generation call per post, no SDK needed.

export interface ClaudeGenerateArgs {
  apiKey: string;
  model?: string;
  system: string;
  user: string;
  maxTokens?: number;
}

export async function generateWithClaude(args: ClaudeGenerateArgs): Promise<{ text: string; tokensUsed: number }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": args.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: args.model ?? "claude-sonnet-5",
      max_tokens: args.maxTokens ?? 1024,
      system: args.system,
      messages: [{ role: "user", content: args.user }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Claude API HTTP ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as {
    content: Array<{ type: string; text?: string }>;
    usage: { input_tokens: number; output_tokens: number };
  };

  const text = json.content.find((c) => c.type === "text")?.text ?? "";
  const tokensUsed = (json.usage?.input_tokens ?? 0) + (json.usage?.output_tokens ?? 0);
  return { text, tokensUsed };
}
