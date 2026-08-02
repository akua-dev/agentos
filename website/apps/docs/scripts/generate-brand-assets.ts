import { Effect, FileSystem, Path, Runtime, Schema } from 'effect';
import sharp from 'sharp';

import { runWebsiteScript } from './script-runtime';

const FAVICON_SIZES = [16, 32, 48];

export class BrandAssetError extends Schema.TaggedErrorClass<BrandAssetError>()(
  'BrandAssetError',
  {
    code: Schema.Literals(['filesystem', 'image']),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override readonly [Runtime.errorExitCode] = 1;
}

function createIco(
  images: ReadonlyArray<{ readonly size: number; readonly bytes: Buffer }>,
): Buffer {
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

function renderImage(label: string, render: () => Promise<Buffer>) {
  return Effect.tryPromise({
    try: render,
    catch: (cause) =>
      new BrandAssetError({
        code: 'image',
        message: `Could not render ${label}`,
        cause,
      }),
  });
}

function renderIcon(source: Uint8Array, size: number) {
  return renderImage(`${size}x${size} browser icon`, () =>
    sharp(source)
      .resize(size, size, { fit: 'fill' })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer(),
  );
}

export const generateBrandAssets = Effect.fn(
  'agentos.website.generateBrandAssets',
)(function*() {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const appDirectory = yield* paths.fromFileUrl(
    new URL('../app/', import.meta.url),
  );
  const publicDirectory = yield* paths.fromFileUrl(
    new URL('../public/', import.meta.url),
  );
  const brandDirectory = yield* paths.fromFileUrl(
    new URL('../../../../docs/brand/', import.meta.url),
  );
  const [iconSvg, wordmarkSvg] = yield* Effect.all(
    [
      fileSystem.readFile(paths.join(brandDirectory, 'agentos-browser-icon.svg')),
      fileSystem.readFile(paths.join(brandDirectory, 'agentos-wordmark-bone.svg')),
    ],
    { concurrency: 'unbounded' },
  ).pipe(
    Effect.mapError(
      (cause) =>
        new BrandAssetError({
          code: 'filesystem',
          message: 'Could not read the canonical AgentOS brand sources',
          cause,
        }),
    ),
  );

  const [icon, appleIcon, faviconImages, wordmark] = yield* Effect.all(
    [
      renderIcon(iconSvg, 512),
      renderIcon(iconSvg, 180),
      Effect.forEach(
        FAVICON_SIZES,
        (size) =>
          renderIcon(iconSvg, size).pipe(
            Effect.map((bytes) => ({ size, bytes })),
          ),
        { concurrency: 'unbounded' },
      ),
      renderImage('AgentOS wordmark', () =>
        sharp(wordmarkSvg)
          .resize({ width: 720, withoutEnlargement: true })
          .png({ compressionLevel: 9, adaptiveFiltering: true })
          .toBuffer(),
      ),
    ],
    { concurrency: 'unbounded' },
  );
  const socialImage = yield* renderImage('AgentOS social image', () =>
    sharp({
      create: {
        width: 1200,
        height: 630,
        channels: 4,
        background: '#080A0E',
      },
    })
      .composite([{ input: wordmark, gravity: 'center' }])
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer(),
  );

  yield* Effect.all(
    [
      fileSystem.writeFile(paths.join(appDirectory, 'icon.png'), icon),
      fileSystem.writeFile(
        paths.join(appDirectory, 'apple-icon.png'),
        appleIcon,
      ),
      fileSystem.writeFile(
        paths.join(appDirectory, 'favicon.ico'),
        createIco(faviconImages),
      ),
      fileSystem.writeFile(
        paths.join(publicDirectory, 'opengraph-image.png'),
        socialImage,
      ),
    ],
    { concurrency: 'unbounded' },
  ).pipe(
    Effect.mapError(
      (cause) =>
        new BrandAssetError({
          code: 'filesystem',
          message: 'Could not write the generated AgentOS brand assets',
          cause,
        }),
    ),
  );
});

if (import.meta.main) runWebsiteScript(generateBrandAssets());
