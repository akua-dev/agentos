export type DocumentationGroup =
  | 'start'
  | 'concepts'
  | 'operate'
  | 'architecture'
  | 'reference'
  | 'contribute';

export interface DocumentationRoute {
  path: `/docs${string}`;
  title: string;
  group: DocumentationGroup | null;
  canonicalRequired: boolean;
}

const groupRoutes = {
  start: [
    ['start', 'Start'],
    ['start/what-is-agentos', 'What is AgentOS?'],
    ['start/get-started', 'Get started'],
    ['start/meet-first-mate', 'Meet your First Mate'],
    ['start/verify-fleet', 'Verify the Fleet'],
    ['start/adopt-project', 'Adopt one project'],
  ],
  concepts: [
    ['concepts', 'Concepts'],
    ['concepts/autonomous-companies', 'Autonomous companies'],
    ['concepts/models-agents-harnesses', 'Models, Agents and harnesses'],
    ['concepts/crew', 'The crew'],
    ['concepts/tasks-assignments', 'Tasks and Assignments'],
    ['concepts/progressive-planning', 'Progressive planning'],
    ['concepts/authority-decisions', 'Authority and decisions'],
    ['concepts/organizational-attention', 'Organizational attention'],
    ['concepts/human-work-surfaces', 'Human work surfaces'],
    ['concepts/native-authorities', 'Native authorities'],
    ['concepts/persistence-recovery', 'Persistence and recovery'],
    ['concepts/composition', 'Composition'],
    ['concepts/memory-learning', 'Memory and learning'],
  ],
  operate: [
    ['operate', 'Operate a Fleet'],
    ['operate/delegate-outcome', 'Delegate an outcome'],
    ['operate/continue-local-work', 'Continue local work with the Fleet'],
    ['operate/create-second-mate', 'Create a Second Mate'],
    ['operate/supervise-steer', 'Supervise and steer'],
    ['operate/ask-for-decision', 'Ask for a decision'],
    ['operate/projects', 'Work with projects'],
    ['operate/memory', 'Agent memory'],
    ['operate/harnesses', 'Choose a harness'],
    ['operate/authentication', 'Authentication'],
    ['operate/ai-gateway', 'Fleet AI Gateway'],
    ['operate/upgrade', 'Upgrade AgentOS'],
    ['operate/diagnose-recover', 'Diagnose and recover'],
  ],
  architecture: [
    ['architecture', 'Architecture'],
    ['architecture/agents-runtime', 'Agents and runtime Pods'],
    ['architecture/delegation-supervision', 'Delegation and supervision'],
    ['architecture/postgresql', 'PostgreSQL coordination'],
    ['architecture/external-events', 'External events and reconciliation'],
    ['architecture/kubernetes', 'Kubernetes and authorization'],
    ['architecture/herdr', 'Herdr and native sessions'],
    ['architecture/toolchains-worktrees', 'Toolchains and worktrees'],
    ['architecture/bootstrap', 'Bootstrap boundary'],
    ['architecture/security-chain-of-custody', 'Security and chain of custody'],
  ],
  reference: [
    ['reference', 'Reference'],
    ['reference/database', 'Database objects'],
    ['reference/commands', 'AgentOS commands'],
    ['reference/kubernetes', 'Kubernetes resources'],
    ['reference/configuration', 'Configuration and environment'],
    ['reference/releases', 'Release artifacts'],
    ['reference/benchmarks', 'Benchmarks'],
    ['reference/glossary', 'Glossary'],
  ],
  contribute: [
    ['contribute', 'Contributing'],
    ['contribute/repository-map', 'Repository map'],
    ['contribute/development', 'Development workflow'],
    ['contribute/testing', 'Testing and verification'],
    ['contribute/evaluation', 'Evaluate an organization'],
    ['contribute/improvement', 'Improve from evidence'],
    ['contribute/releases', 'Release model'],
  ],
} as const satisfies Record<DocumentationGroup, ReadonlyArray<readonly [string, string]>>;

export const documentationRoutes: readonly DocumentationRoute[] = [
  {
    path: '/docs',
    title: 'AgentOS documentation',
    group: null,
    canonicalRequired: false,
  },
  ...Object.entries(groupRoutes).flatMap(([group, routes]) =>
    routes.map(([path, title]) => ({
      path: `/docs/${path}` as const,
      title,
      group: group as DocumentationGroup,
      canonicalRequired: true,
    })),
  ),
];
