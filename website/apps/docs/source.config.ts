import { remarkSteps } from '@fumadocs/satteri/remark-steps';
import { remarkTs2js } from '@fumadocs/satteri/remark-ts2js';
import { remarkAutoTypeTable } from '@fumadocs/satteri/remark-auto-type-table';
import type { ElementContent } from 'hast';
import type { Nodes } from 'mdast';
import type { MdastPluginDefinition } from 'satteri';
import type { ShikiTransformer } from 'shiki';
import z from 'zod';
import { rehypeCodeDefaultOptions } from 'fumadocs-core/mdx-plugins/rehype-code';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';
import { transformerTwoslash } from 'fumadocs-twoslash';
import { createFileSystemTypesCache } from 'fumadocs-twoslash/cache-fs';
import {
  createFileSystemGeneratorCache,
  createGenerator,
  type RemarkAutoTypeTableOptions,
} from 'fumadocs-typescript';
import { defineConfig, defineDocs } from 'fumadocs-mdx/config';
import jsonSchema from 'fumadocs-mdx/plugins/json-schema';
import lastModified from 'fumadocs-mdx/plugins/last-modified';
import { canonicalSourceSchema } from './lib/content/canonical-source.ts';
import { defaultShikiOptions } from './lib/shiki.ts';

const typeTableGenerator = createGenerator({
  cache: createFileSystemGeneratorCache('.next/cache/fumadocs-typescript'),
});

const isLint = process.env.LINT === '1';

declare module 'satteri' {
  interface DataMap {
    elementIds?: string[];
  }
}

/** Docs lint only — collects JSX `id` attributes for link validation. */
function remarkElementIds(): MdastPluginDefinition {
  return {
    name: 'remark-element-ids',
    mdxJsxFlowElement(node, ctx) {
      if (!node.name || !node.attributes) return;

      const idAttr = node.attributes.find(
        (attr) => attr.type === 'mdxJsxAttribute' && attr.name === 'id',
      );
      if (!idAttr || typeof idAttr.value !== 'string') return;

      const ids = (ctx.data.elementIds ??= []);
      ids.push(idAttr.value);
    },
  };
}

export const docs = defineDocs({
  docs: {
    compiler: 'satteri',
    schema: pageSchema.extend({
      preview: z.string().optional(),
      index: z.boolean().default(false),
      canonical: z.array(canonicalSourceSchema).default([]),
      /**
       * API routes only
       */
      method: z.string().optional(),
    }),
    postprocess: {
      includeProcessedMarkdown: true,
      extractLinkReferences: true,
      valueToExport: ['elementIds'],
    },
    async: true,
    lastModified: true,
    satteriOptions() {
      const typeTableOptions: RemarkAutoTypeTableOptions = {
        generator: typeTableGenerator,
        shiki: defaultShikiOptions,
      };

      return {
        features: {
          math: true,
        },
        rehypeCodeOptions: isLint
          ? false
          : {
              inline: 'tailing-curly-colon',
              themes: {
                light: 'catppuccin-latte',
                dark: 'catppuccin-mocha',
              },
              transformers: [
                ...(rehypeCodeDefaultOptions.transformers ?? []),
                transformerTwoslash({
                  typesCache: createFileSystemTypesCache(),
                  twoslashOptions: {
                    compilerOptions: {
                      types: ['@types/node'],
                    },
                  },
                }),
                transformerEscape(),
              ],
            },
        remarkCodeTabOptions: {
          parseMdx: true,
        },
        remarkStructureOptions: {
          stringify: {
            filterElement(node: Nodes) {
              switch (node.type) {
                case 'mdxJsxFlowElement':
                case 'mdxJsxTextElement':
                  switch (node.name) {
                    case 'File':
                    case 'TypeTable':
                    case 'Callout':
                    case 'Card':
                    case 'Custom':
                      return true;
                  }
                  return 'children-only';
              }

              return true;
            },
          },
        },
        remarkImageOptions: isLint ? false : undefined,
        remarkNpmOptions: {
          persist: {
            id: 'package-manager',
          },
        },
        mdastPlugins: (plugins) =>
          isLint
            ? [remarkElementIds(), ...plugins]
            : [
                remarkSteps(),
                remarkAutoTypeTable(typeTableOptions),
                remarkTs2js(),
                ...plugins,
              ],
      };
    },
  },
  meta: {
    schema: metaSchema.extend({
      description: z.string().optional(),
    }),
  },
});

export const learn = defineDocs({
  dir: 'content/learn',
  docs: {
    compiler: 'satteri',
    schema: pageSchema.extend({
      courseId: z.string().min(1),
      courseTitle: z.string().min(1),
      courseOrder: z.number().int().positive(),
      lessonId: z.string().min(1),
      lessonOrder: z.number().int().positive(),
      estimatedMinutes: z.number().int().positive().max(5),
      canonical: z.array(canonicalSourceSchema).default([]),
      video: z
        .object({
          url: z.url().refine((value) => value.startsWith('https://')),
          title: z.string().min(1),
          transcript: z.string().min(1).optional(),
        })
        .optional(),
    }),
    postprocess: {
      includeProcessedMarkdown: true,
      extractLinkReferences: true,
    },
    async: true,
    lastModified: true,
  },
  meta: {
    schema: metaSchema.extend({
      description: z.string().optional(),
    }),
  },
});

function transformerEscape(): ShikiTransformer {
  return {
    name: '@shikijs/transformers:remove-notation-escape',
    code(hast) {
      function replace(node: ElementContent) {
        if (node.type === 'text') {
          node.value = node.value.replace('[\\!code', '[!code');
        } else if ('children' in node) {
          for (const child of node.children) {
            replace(child);
          }
        }
      }

      replace(hast);
      return hast;
    },
  };
}

export default defineConfig({
  compiler: 'satteri',
  plugins: [
    jsonSchema({
      insert: true,
    }),
    lastModified(),
  ],
});
