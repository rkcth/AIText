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
  onReasoning: (chunk: string) => void;
}

@Injectable({ providedIn: "root" })
export class OpenRouterService {
  private readonly openRouterUrl = "https://openrouter.ai/api/v1";

  async fetchModels(settings: AppSettings, signal?: AbortSignal): Promise<ModelOption[]> {
    const response = await this.fetchOrExplain(`${this.baseUrl(settings)}/models`, settings, {
      headers: this.headers(settings),
      signal,
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
    reasoningContext = "",
  ): Promise<void> {
    const messages = [];
    if (settings.systemPrompt.trim()) {
      messages.push({
        role: "system",
        content: settings.systemPrompt.trim(),
      });
    }

    if (reasoningContext.trim()) {
      messages.push({
        role: "system",
        content: [
          "Previous reasoning notes, edited by the user.",
          "Use them as ordinary context only; correct them if the document implies they are wrong.",
          reasoningContext.trim(),
        ].join("\n"),
      });
    }

    messages.push({
      role: "user",
      content: [
        "Continue the following text from exactly where it ends.",
        `Write a substantial continuation, aiming for roughly ${settings.maxTokens} tokens unless the text clearly ends.`,
        "Return only the continuation with no commentary or framing.",
        "",
        documentText,
      ].filter(Boolean).join("\n"),
    });

    const response = await this.fetchOrExplain(`${this.baseUrl(settings)}/chat/completions`, settings, {
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
        ...(settings.provider === "aiServer" ? { chat_template_kwargs: { enable_thinking: true } } : {}),
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
                reasoning?: string;
                reasoning_content?: string;
              };
            }>;
          };

          const delta = json.choices?.[0]?.delta;
          const reasoning = delta?.reasoning_content ?? delta?.reasoning ?? "";
          const chunk = delta?.content ?? "";
          if (reasoning) {
            handlers.onReasoning(reasoning);
          }
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

  private async fetchOrExplain(
    url: string,
    settings: AppSettings,
    init: RequestInit,
  ): Promise<Response> {
    try {
      return await fetch(url, init);
    } catch (error) {
      if (
        settings.provider === "aiServer" &&
        window.location.protocol === "https:" &&
        url.startsWith("http://")
      ) {
        throw new Error(
          "The browser blocked the AI server because AIText is loaded over HTTPS but the AI server URL is HTTP. Open AIText over http://localhost, or expose the AI server with HTTPS.",
        );
      }

      throw error;
    }
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
