import { sha256Hex } from "@verityos/audit-kernel";

export function buildGovernedPrompt(input: {
  skillId: string;
  userContent: string;
  knowledgeChunks: Array<{ chunk_id: string; text: string }>;
}): { prompt: string; promptHash: string; includedChunkIds: string[] } {
  const knowledge = input.knowledgeChunks
    .map((chunk, index) => `[${index + 1} chunk_id=${chunk.chunk_id}]\n${chunk.text}`)
    .join("\n\n");
  const prompt = [
    "SYSTEM: You are VerityOS. Follow observable skill instructions only. Do not emit hidden chain-of-thought or private reasoning tokens.",
    `SKILL: ${input.skillId}`,
    knowledge
      ? `KNOWLEDGE:\n${knowledge}`
      : "KNOWLEDGE: none",
    `USER:\n${input.userContent}`,
  ].join("\n\n");
  return {
    prompt,
    promptHash: sha256Hex(prompt),
    includedChunkIds: input.knowledgeChunks.map((chunk) => chunk.chunk_id),
  };
}
