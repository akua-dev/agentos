import { timingSafeEqual } from "node:crypto";

export function timingSafeStringEqual(leftValue: string, rightValue: string) {
  const encoder = new TextEncoder();
  const left = encoder.encode(leftValue);
  const right = encoder.encode(rightValue);
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}
