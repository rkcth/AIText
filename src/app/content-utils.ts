const EMPTY_DOCUMENT_MARKDOWN = "";

const stripHtmlToText = (value: string): string => {
  const container = document.createElement("div");
  container.innerHTML = value;

  const blockElements = Array.from(
    container.querySelectorAll("p, div, li, h1, h2, h3, h4, h5, h6, br, hr"),
  );

  for (const element of blockElements) {
    if (element.tagName === "BR") {
      element.replaceWith("\n");
      continue;
    }

    if (element.tagName === "HR") {
      element.replaceWith("\n---\n");
      continue;
    }

    if (!element.textContent?.endsWith("\n")) {
      element.append("\n");
    }
  }

  return (container.textContent ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

export const normalizeStoredContent = (content: string): string => {
  const raw = (content ?? "").trim();
  if (!raw) {
    return EMPTY_DOCUMENT_MARKDOWN;
  }

  if (/<[a-z][\s\S]*>/i.test(raw)) {
    return stripHtmlToText(raw);
  }

  return raw.replace(/\r\n/g, "\n");
};

export const markdownToPlainText = (content: string): string =>
  normalizeStoredContent(content)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-+*]\s+\[.\]\s+/gm, "")
    .replace(/^\s*[-+*]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*([-*_]\s*){3,}$/gm, " ")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export const previewTextFromContent = (content: string, maxLength = 120): string => {
  const flattened = markdownToPlainText(content).replace(/\s+/g, " ").trim();
  if (!flattened) {
    return "Empty document";
  }

  return flattened.length > maxLength
    ? `${flattened.slice(0, maxLength - 3)}...`
    : flattened;
};

export const appendPlainTextToContent = (
  baseContent: string,
  insertedText: string,
): string => {
  const normalizedBase = normalizeStoredContent(baseContent);
  if (!insertedText) {
    return normalizedBase;
  }

  return `${normalizedBase}${insertedText}`.replace(/\r\n/g, "\n");
};

export { EMPTY_DOCUMENT_MARKDOWN };
