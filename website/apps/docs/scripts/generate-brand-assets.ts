import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const appDirectory = new URL('../app/', import.meta.url);
const brandDirectory = new URL('../../../../docs/brand/', import.meta.url);
const iconSource = new URL('agentos-browser-icon.svg', brandDirectory);
const wordmarkSource = new URL('agentos-wordmark-bone.svg', brandDirectory);

function createIco(images: readonly { size: number; bytes: Buffer }[]): Buffer {
  const directory = Buffer.alloc(6 + images.length * 16);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(images.length, 4);

  let offset = directory.length;
  images.forEach(({ size, bytes }, index) => {
    const entry = 6 + index * 16;
    directory.writeUInt8(size === 256 ? 0 : size, entry);
    directory.writeUInt8(size === 256 ? 0 : size, entry + 1);
    directory.writeUInt8(0, entry + 2);
    directory.writeUInt8(0, entry + 3);
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(bytes.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += bytes.length;
  });

  return Buffer.concat([directory, ...images.map(({ bytes }) => bytes)]);
}

async function renderIcon(source: Buffer, size: number): Promise<Buffer> {
  return sharp(source)
    .resize(size, size, { fit: 'fill' })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

export async function generateBrandAssets(): Promise<void> {
  const [iconSvg, wordmarkSvg] = await Promise.all([
    readFile(iconSource),
    readFile(wordmarkSource),
  ]);
  const [icon, appleIcon] = await Promise.all([
    renderIcon(iconSvg, 512),
    renderIcon(iconSvg, 180),
  ]);
  const faviconImages = await Promise.all(
    [16, 32, 48].map(async (size) => ({
      size,
      bytes: await renderIcon(iconSvg, size),
    })),
  );
  const wordmark = await sharp(wordmarkSvg)
    .resize({ width: 720, withoutEnlargement: true })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  const socialImage = await sharp({
    create: {
      width: 1200,
      height: 630,
      channels: 4,
      background: '#080A0E',
    },
  })
    .composite([{ input: wordmark, gravity: 'center' }])
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();

  await Promise.all([
    writeFile(new URL('icon.png', appDirectory), icon),
    writeFile(new URL('apple-icon.png', appDirectory), appleIcon),
    writeFile(new URL('favicon.ico', appDirectory), createIco(faviconImages)),
    writeFile(new URL('opengraph-image.png', appDirectory), socialImage),
  ]);
}

if (import.meta.main) {
  await generateBrandAssets();
}
