import { Injectable } from "@angular/core";
import { AppSettings, ModelOption } from "./app.types";

interface OpenRouterModelResponse {
  data?: Array<{
    id?: string;
    name?: string;
    description?: string;
    context_length?: number;
  }>;
}

interface StreamHandlers {
  onText: (chunk: string) => void;
}

@Injectable({ providedIn: "root" })
export class OpenRouterService {
  private readonly modelsUrl = "https://openrouter.ai/api/v1/models";
  private readonly completionsUrl = "https://openrouter.ai/api/v1/chat/completions";

  async fetchModels(apiKey: string): Promise<ModelOption[]> {
    const headers: Record<string, string> = {};

    if (apiKey.trim()) {
      headers["Authorization"] = `Bearer ${apiKey.trim()}`;
    }

    const response = await fetch(this.modelsUrl, { headers });
    if (!response.ok) {
      throw new Error(`Unable to fetch models (${response.status}).`);
    }

    const payload = (await response.json()) as OpenRouterModelResponse;
    return (payload.data ?? [])
      .filter((item): item is Required<Pick<ModelOption, "id" | "name">> & {
        context_length?: number;
        description?: string;
      } => Boolean(item.id && item.name))
      .map((item) => ({
        id: item.id,
        name: item.name,
        contextLength: item.context_length ?? null,
        description: item.description ?? "",
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async streamCompletion(
    settings: AppSettings,
    documentText: string,
    signal: AbortSignal,
    handlers: StreamHandlers,
  ): Promise<void> {
    const messages = [];
    if (settings.systemPrompt.trim()) {
      messages.push({
        role: "system",
        content: settings.systemPrompt.trim(),
      });
    }

    messages.push({
      role: "user",
      content: [
        "Continue the following text from exactly where it ends.",
        "Return only the continuation with no commentary or framing.",
        "",
        documentText,
      ].join("\n"),
    });

    const response = await fetch(this.completionsUrl, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey.trim()}`,
        "HTTP-Referer": window.location.origin,
        "X-Title": "AIText",
      },
      body: JSON.stringify({
        model: settings.model,
        max_tokens: settings.maxTokens,
        temperature: settings.temperature,
        top_p: settings.topP,
        stream: true,
        messages,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        errorText || `OpenRouter request failed (${response.status}).`,
      );
    }

    if (!response.body) {
      throw new Error("Streaming is unavailable because the response body was empty.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        const lines = part
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.startsWith("data:"));

        for (const line of lines) {
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") {
            continue;
          }

          const json = JSON.parse(payload) as {
            choices?: Array<{
              delta?: {
                content?: string;
              };
            }>;
          };

          const chunk = json.choices?.[0]?.delta?.content ?? "";
          if (chunk) {
            handlers.onText(chunk);
          }
        }
      }
    }
  }
}
