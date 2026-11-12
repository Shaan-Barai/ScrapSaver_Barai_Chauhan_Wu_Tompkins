/** The text-generation interface analytics needs (vision's Gemini gateway satisfies it). */
export interface TextGateway {
  generateText(
    prompt: string,
    opts?: {
      systemInstruction?: string;
      temperature?: number;
      maxOutputTokens?: number;
    },
  ): Promise<string>;
}

/** Collapse whitespace and soft-cap model text so a runaway response does not flood the dashboard. */
export function sanitizeModelText(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed.length === 0) {
    throw new Error('Empty suggestion text from gateway.');
  }
  return trimmed.length > 600 ? `${trimmed.slice(0, 597)}...` : trimmed;
}
