import { type FileObject, printErrors, scanURLs, validateFiles } from 'next-validate-link';
import { learnSource, source, type LearnPage, type Page } from '@/lib/source';

async function checkLinks() {
  const scanned = await scanURLs({
    populate: {
      'docs/[[...slug]]': await Promise.all(
        source.getPages().map(async (page) => {
          return {
            value: {
              slug: page.slugs,
            },
            hashes: await getHeadings(page),
          };
        }),
      ),
      '(home)/learn/[...slug]': await Promise.all(
        learnSource.getPages().map(async (page) => {
          return {
            value: {
              slug: page.slugs,
            },
            hashes: await getHeadings(page),
          };
        }),
      ),
    },
  });

  console.log(`collected ${scanned.urls.size} URLs, ${scanned.fallbackUrls.length} fallbacks`);

  printErrors(
    await validateFiles(await getFiles(), {
      scanned,
      markdown: {
        components: {
          Card: { attributes: ['href'] },
        },
      },
      checkRelativePaths: 'as-url',
    }),
    true,
  );
}

async function getHeadings(page: Page | LearnPage): Promise<string[]> {
  if (page.type !== 'docs') return [];
  const { _exports, toc } = await page.data.load();
  const headings = toc.map((item) => item.url.slice(1));
  const elementIds = _exports?.elementIds;
  if (Array.isArray(elementIds)) {
    headings.push(...elementIds);
  }

  return headings;
}

async function getFiles() {
  const files: FileObject[] = [];
  for (const page of source.getPages()) {
    if (page.type !== 'docs') continue;

    files.push({
      data: page.data,
      url: page.url,
      path: page.data.info.fullPath,
      content: await page.data.getText('raw'),
    });
  }
  for (const page of learnSource.getPages()) {
    if (page.type !== 'docs') continue;

    files.push({
      data: page.data,
      url: page.url,
      path: page.data.info.fullPath,
      content: await page.data.getText('raw'),
    });
  }

  return files;
}

void checkLinks();
