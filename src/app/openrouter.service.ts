import { Injectable } from "@angular/core";
import { AppSettings, ModelOption } from "./app.types";

interface ModelsResponse {
  data?: Array<{
    id?: string;
    name?: string;
    description?: string;
    context_length?: number;
    max_model_len?: number;
  }>;
}

interface StreamHandlers {
  onText: (chunk: string) => void;
}

@Injectable({ providedIn: "root" })
export class OpenRouterService {
  private readonly openRouterUrl = "https://openrouter.ai/api/v1";

  async fetchModels(settings: AppSettings): Promise<ModelOption[]> {
    const response = await fetch(`${this.baseUrl(settings)}/models`, {
      headers: this.headers(settings),
    });
    if (!response.ok) {
      throw new Error(`Unable to fetch models (${response.status}).`);
    }

    const payload = (await response.json()) as ModelsResponse;
    return (payload.data ?? [])
      .filter((item): item is {
        id: string;
        name?: string;
        context_length?: number;
        max_model_len?: number;
        description?: string;
      } => Boolean(item.id))
      .map((item) => ({
        id: item.id,
        name: item.name ?? item.id,
        contextLength: item.context_length ?? item.max_model_len ?? null,
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

    const response = await fetch(`${this.baseUrl(settings)}/chat/completions`, {
      method: "POST",
      signal,
      headers: this.headers(settings, true),
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
        errorText || `AI request failed (${response.status}).`,
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

  private baseUrl(settings: AppSettings): string {
    return (settings.provider === "aiServer" ? settings.aiServerUrl : this.openRouterUrl)
      .trim()
      .replace(/\/$/, "");
  }

  private headers(settings: AppSettings, json = false): Record<string, string> {
    const headers: Record<string, string> = json ? { "Content-Type": "application/json" } : {};
    const apiKey = settings.apiKey.trim();

    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    if (settings.provider === "openrouter") {
      headers["HTTP-Referer"] = window.location.origin;
      headers["X-Title"] = "AIText";
    }

    return headers;
  }
}
