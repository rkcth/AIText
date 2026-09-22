export interface StreamDelta {
  content: string;
  complete: boolean;
}

export function splitSseEvents(buffer: string): { events: string[]; rest: string } {
  const events: string[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    const char = buffer[index];
    if (char !== "\n") continue;
    const previous = buffer[index - 1] === "\r" ? index - 1 : index;
    const next = buffer[index + 1] === "\r" ? index + 2 : index + 1;
    if (buffer[next] !== "\n") continue;
    events.push(buffer.slice(start, previous));
    start = next + 1;
    index = start - 1;
  }
  return { events, rest: buffer.slice(start) };
}

export function readOpenAiStreamEvent(part: string): StreamDelta {
  let content = "";
  let complete = false;
  for (const line of part.split(/\r?\n/).map((entry) => entry.trim()).filter((entry) => entry.startsWith("data:"))) {
    const payload = line.slice(5).trim();
    if (!payload) continue;
    if (payload === "[DONE]") {
      complete = true;
      continue;
    }
    const parsed = JSON.parse(payload) as { error?: { message?: string }; choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }> };
    if (parsed.error) throw new Error(parsed.error.message ?? "Stream failed.");
    const choice = parsed.choices?.[0];
    content += choice?.delta?.content ?? "";
    if (choice?.finish_reason) complete = true;
  }
  return { content, complete };
}
