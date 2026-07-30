import { docs, learn } from 'collections/server';
import { type LoaderPlugin, loader } from 'fumadocs-core/source';
import { lucideIconsPlugin } from 'fumadocs-core/source/lucide-icons';

export const source = loader(docs.toFumadocsSource(), {
  baseUrl: '/docs',
  plugins: [pageTreeCodeTitles(), lucideIconsPlugin()],
});

export const learnSource = loader(learn.toFumadocsSource(), {
  baseUrl: '/learn',
});

function pageTreeCodeTitles(): LoaderPlugin {
  return {
    transformPageTree: {
      file(node) {
        if (
          typeof node.name === 'string' &&
          (node.name.endsWith('()') || node.name.match(/^<\w+ \/>$/))
        ) {
          return {
            ...node,
            name: (
              <code key="0" className="text-[0.8125rem]">
                {node.name}
              </code>
            ),
          };
        }

        return node;
      },
    },
  };
}

export type Page = (typeof source)['$inferPage'];
export type LearnPage = (typeof learnSource)['$inferPage'];
export type Meta = (typeof source)['$inferMeta'];
