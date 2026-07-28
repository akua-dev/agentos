export interface MateMemoryPolicy {
  enabled: boolean;
  extractionEnabled: boolean;
  extractionStride: number;
  dreamEnabled: boolean;
  dreamMinHours: number;
  dreamMinPriorSessions: number;
  maxIndexLines: number;
  maxIndexBytes: number;
  maxTopicFiles: number;
  maxRelevantTopics: number;
  maxPinnedTopics: number;
  maxSessionAttachmentBytes: number;
}

export const mateMemoryPolicy = {
  enabled: true,
  extractionEnabled: true,
  extractionStride: 1,
  dreamEnabled: true,
  dreamMinHours: 24,
  dreamMinPriorSessions: 5,
  maxIndexLines: 200,
  maxIndexBytes: 25_000,
  maxTopicFiles: 200,
  maxRelevantTopics: 5,
  maxPinnedTopics: 4,
  maxSessionAttachmentBytes: 61_440,
} as const satisfies MateMemoryPolicy;

export function resolveMateMemoryPolicy(
  overrides: Partial<MateMemoryPolicy> = {},
): MateMemoryPolicy {
  return { ...mateMemoryPolicy, ...overrides };
}
