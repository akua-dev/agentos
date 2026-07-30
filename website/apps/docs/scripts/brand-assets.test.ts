import { readFile, stat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const appAsset = (name: string) => new URL(`../app/${name}`, import.meta.url);

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function icoSizes(bytes: Buffer): number[] {
  expect(bytes.readUInt16LE(0)).toBe(0);
  expect(bytes.readUInt16LE(2)).toBe(1);
  const count = bytes.readUInt16LE(4);
  return Array.from({ length: count }, (_, index) => {
    const width = bytes[6 + index * 16];
    return width === 0 ? 256 : width;
  });
}

describe('AgentOS browser and social assets', () => {
  it.each([
    ['icon.png', 512, 512],
    ['apple-icon.png', 180, 180],
    ['opengraph-image.png', 1200, 630],
  ] as const)('publishes %s at its contract dimensions', async (name, width, height) => {
    expect(pngDimensions(await readFile(appAsset(name)))).toEqual({ width, height });
  });

  it('publishes the common favicon sizes in one ICO', async () => {
    expect(icoSizes(await readFile(appAsset('favicon.ico')))).toEqual([16, 32, 48]);
  });

  it('removes the superseded nautical banner', async () => {
    await expect(stat(new URL('../public/banner.png', import.meta.url))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
